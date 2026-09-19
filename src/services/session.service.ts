/**
 * Multi-Tenant WhatsApp Session Service
 * Manages the connection lifecycle of Baileys WASocket instances, Redis persistence,
 * QR code caching, phone pairing codes, event dispatching, and graceful teardown.
 */
import crypto from 'crypto';
import { Boom } from '@hapi/boom';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  proto,
  WASocket,
} from '@whiskeysockets/baileys';
import { clearRedisSession, useRedisAuthState } from '../adapters/redisAuthState.js';
import { getRedisClient } from '../config/redis.js';
import { extractPhoneFromJid, formatPairingCode, sanitizePhoneNumber } from '../utils/jid.util.js';
import { createSessionLogger, logGatewayEvent, logger } from '../utils/logger.js';
import { getWhatsAppVersion } from '../utils/versionGuard.js';
import { MediaService } from './media.service.js';
import { MessageService } from './message.service.js';
import { WebhookService } from './webhook.service.js';
import { DbService, SessionStatus, MessageDirection, MessageStatus } from './db.service.js';
import type {
  OutboundMessageResult,
  RecentEvent,
  SessionInstance,
  SessionMetadata,
  SessionSummary,
  WebhookAckPayload,
  WebhookInboundPayload,
} from '../types/index.js';

export class SessionService {
  private activeSockets: Map<string, WASocket> = new Map();
  private sessions: Map<string, SessionInstance> = new Map();
  private metadataMap: Map<string, SessionMetadata> = new Map();
  public qrCodes: Map<string, string> = new Map();
  private inFlightInits: Map<string, Promise<SessionMetadata>> = new Map();
  private terminatingSessions: Set<string> = new Set();
  private recentEvents: RecentEvent[] = [];
  private readonly maxEvents = 100;

  /**
   * Records an event in the in-memory circular event buffer for observability.
   */
  public logEvent(
    type: RecentEvent['type'],
    sessionId: string,
    details: Record<string, any>
  ): void {
    const event: RecentEvent = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type,
      sessionId,
      details,
    };
    this.recentEvents.unshift(event);
    if (this.recentEvents.length > this.maxEvents) {
      this.recentEvents.pop();
    }
  }

  /**
   * Emits live session events to the logger & event buffer for real-time SSE broadcasting to UI.
   */
  public emitEvent(sessionId: string, action: string, data: Record<string, any>): void {
    const payload = {
      action,
      event: action,
      sessionId,
      ...data,
    };
    logGatewayEvent('info', `[SessionService] Session ${sessionId} event: ${action}`, sessionId, payload);
    this.logEvent('session_event', sessionId, payload);
  }

  /**
   * Returns recent events for observability and debugging.
   */
  public getRecentEvents(): RecentEvent[] {
    return [...this.recentEvents];
  }

  /**
   * Initializes or boots a Baileys WhatsApp socket session for a tenant.
   * Debounces parallel init calls for the same session ID.
   */
  public async initSession(
    sessionId: string,
    modeOrOpts?: 'qr' | 'pairing_code' | { authMode?: 'qr' | 'pairing_code'; phoneNumber?: string }
  ): Promise<SessionMetadata> {
    const existingInFlight = this.inFlightInits.get(sessionId);
    if (existingInFlight) {
      return existingInFlight;
    }

    const initPromise = (async () => {
      try {
        return await this.executeInitSession(sessionId, modeOrOpts);
      } finally {
        this.inFlightInits.delete(sessionId);
      }
    })();

    this.inFlightInits.set(sessionId, initPromise);
    return initPromise;
  }

  /**
   * Internal implementation of Baileys WhatsApp socket initialization.
   */
  private async executeInitSession(
    sessionId: string,
    modeOrOpts?: 'qr' | 'pairing_code' | { authMode?: 'qr' | 'pairing_code'; phoneNumber?: string }
  ): Promise<SessionMetadata> {
    const sessionLog = createSessionLogger(sessionId);

    // Clear any terminating flag if re-initializing this session
    this.terminatingSessions.delete(sessionId);

    const existingInstance = this.sessions.get(sessionId);
    const existingSocket = existingInstance?.sock || this.activeSockets.get(sessionId);
    const existingMeta = this.metadataMap.get(sessionId);

    // Resolve target authMode and phoneNumber (defaults to 'qr')
    let authMode: 'qr' | 'pairing_code' = 'qr';
    let phoneNumber: string | undefined = undefined;

    if (typeof modeOrOpts === 'string') {
      authMode = modeOrOpts || 'qr';
    } else if (modeOrOpts && typeof modeOrOpts === 'object') {
      authMode = modeOrOpts.authMode || existingInstance?.authMode || existingMeta?.authMode || 'qr';
      phoneNumber = modeOrOpts.phoneNumber || existingInstance?.phoneNumber;
    } else {
      authMode = existingInstance?.authMode || existingMeta?.authMode || 'qr';
      phoneNumber = existingInstance?.phoneNumber;
    }

    // If session is already connected, update metadata/instance and return state
    if (existingSocket && existingMeta && existingMeta.status === 'connected') {
      sessionLog.info({ status: existingMeta.status, authMode }, '[SessionService] Session already connected');
      existingMeta.authMode = authMode;
      if (existingInstance) {
        existingInstance.authMode = authMode;
        if (phoneNumber) existingInstance.phoneNumber = phoneNumber;
      }
      return existingMeta;
    }

    // If session is already actively connecting with matching authMode, return its state
    if (
      existingSocket &&
      existingMeta &&
      (existingMeta.status === 'connecting' || existingMeta.status === 'qr_ready') &&
      existingMeta.authMode === authMode
    ) {
      sessionLog.info(
        { status: existingMeta.status, authMode },
        '[SessionService] Session already initializing with matching authMode'
      );
      return existingMeta;
    }

    // Terminate any previous socket reference if re-initializing or switching authMode
    if (existingSocket) {
      sessionLog.info(
        { sessionId, previousMode: existingMeta?.authMode || existingInstance?.authMode, newMode: authMode },
        '[SessionService] Terminating previous socket for clean init'
      );
      try {
        existingSocket.ev.removeAllListeners('connection.update');
        existingSocket.ev.removeAllListeners('creds.update');
        existingSocket.ev.removeAllListeners('messages.upsert');
        if ((existingSocket as any).ws && typeof (existingSocket as any).ws.close === 'function') {
          (existingSocket as any).ws.close();
        }
        existingSocket.end(undefined);
      } catch {
        // Ignore termination error
      }
      this.activeSockets.delete(sessionId);
      this.sessions.delete(sessionId);
    }

    const redis = await getRedisClient();

    if (authMode === 'pairing_code') {
      try {
        await redis.del(`wa:session:${sessionId}:qr`);
      } catch {
        // Ignore
      }
    }

    // Prepare metadata record
    const meta: SessionMetadata = {
      id: sessionId,
      status: 'connecting',
      authMode,
      qr: null,
      qrUpdatedAt: null,
      user: null,
      reconnectAttempts: existingMeta?.reconnectAttempts || 0,
      createdAt: existingMeta?.createdAt || Date.now(),
      lastActiveAt: Date.now(),
    };
    this.metadataMap.set(sessionId, meta);
    this.logEvent('session_event', sessionId, { action: 'init_started', authMode });

    // Persist or update session in relational DB
    const initialDbStatus = authMode === 'pairing_code' ? SessionStatus.PAIRING_CODE : SessionStatus.QR_READY;
    DbService.upsertSession(sessionId, {
      status: initialDbStatus,
      authMode,
      phoneNumber: phoneNumber || null,
      lastActiveAt: new Date(),
    }).catch(() => {});

    sessionLog.info(
      { reconnectAttempts: meta.reconnectAttempts, authMode, phoneNumber },
      '[SessionService] Initializing WhatsApp session socket...'
    );

    try {
      // Step A: Initialize Custom Redis Auth State & Resolve WhatsApp Web Protocol Version
      const { state, saveCreds } = await useRedisAuthState(redis, sessionId);
      const { version } = await getWhatsAppVersion(redis);

      // Create pino sublogger for Baileys with minimal noise
      const baileysLogger = logger.child({ module: 'baileys', sessionId });
      baileysLogger.level = 'fatal';

      // Step B: Create WASocket instance with synchronized protocol version and standard browser signature
      const sock = makeWASocket({
        version,
        auth: state,
        logger: baileysLogger,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'), // Standard realistic client signature ['Ubuntu', 'Chrome', '20.0.04']
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
      });

      this.activeSockets.set(sessionId, sock);
      this.sessions.set(sessionId, {
        sock,
        authMode,
        phoneNumber,
        isReconnecting: false,
      });

      // Step C: Listen for credentials update
      sock.ev.on('creds.update', async () => {
        try {
          await saveCreds();
          sessionLog.debug('[SessionService] Credentials successfully updated & persisted to Redis');
        } catch (err: any) {
          sessionLog.error({ err: err.message, stack: err.stack }, '[SessionService] Failed to save creds to Redis');
        }
      });

      // Step D: Listen for connection updates (QR, open, close)
      sock.ev.on('connection.update', async (update) => {
        const currentSession = this.sessions.get(sessionId);

        // If session is marked for intentional termination/purge, suppress updates
        if (this.terminatingSessions.has(sessionId)) {
          sessionLog.info(
            '[SessionService] Connection update received during intentional purge; ignoring and bypassing reconnect.'
          );
          this.activeSockets.delete(sessionId);
          this.sessions.delete(sessionId);
          this.metadataMap.delete(sessionId);
          this.qrCodes.delete(sessionId);
          return;
        }

        // Ignore updates from superseded or already-detached sockets
        if (this.activeSockets.get(sessionId) !== sock) {
          sessionLog.debug(
            '[SessionService] Connection update received from superseded socket; ignoring.'
          );
          return;
        }

        const { connection, lastDisconnect, qr } = update;
        meta.lastActiveAt = Date.now();

        // 1. Natural Baileys QR Code emission
        if (update.qr) {
          this.qrCodes.set(sessionId, update.qr);
          meta.qr = update.qr;
          meta.qrUpdatedAt = Date.now();
          meta.status = 'qr_ready';
          sessionLog.info('[SessionService] New WhatsApp QR Code generated and ready for scan');

          try {
            await redis.set(`wa:session:${sessionId}:qr`, update.qr, 'EX', 60);
          } catch (err: any) {
            sessionLog.warn({ err: err.message }, '[Redis] Failed to cache QR string in Redis');
          }

          this.logEvent('session_event', sessionId, { action: 'qr_generated', qr: update.qr });
          this.emitEvent(sessionId, 'qr_generated', { qr: update.qr });

          // Record QR_READY in DB
          DbService.updateSessionStatus(sessionId, SessionStatus.QR_READY).catch(() => {});
        }

        // 2. Connection opened successfully
        if (connection === 'open') {
          this.qrCodes.delete(sessionId);
          meta.status = 'connected';
          meta.qr = null;
          meta.qrUpdatedAt = null;
          meta.reconnectAttempts = 0;
          if (currentSession) currentSession.isReconnecting = false;

          if (sock.user) {
            meta.user = {
              id: sock.user.id,
              name: sock.user.name,
            };
          }

          try {
            await redis.del(`wa:session:${sessionId}:qr`);
          } catch {
            // Ignore
          }

          const connectedPhone = meta.user?.id ? extractPhoneFromJid(meta.user.id) : (currentSession?.phoneNumber || null);
          const connectedPushName = meta.user?.name || null;

          // Record CONNECTED status in DB
          DbService.updateSessionStatus(sessionId, SessionStatus.CONNECTED, {
            phoneNumber: connectedPhone,
            pushName: connectedPushName,
            lastActiveAt: new Date(),
          }).catch(() => {});

          sessionLog.info(
            { action: 'session_connected', event: 'session_connected', sessionId, status: 'connected', user: meta.user, socketId: sock.user?.id },
            `[SessionService] Session ${sessionId} successfully connected!`
          );
          this.logEvent('session_event', sessionId, {
            action: 'session_connected',
            event: 'session_connected',
            sessionId,
            status: 'connected',
            user: meta.user,
          });

          // Emit live SSE event to the UI
          this.emitEvent(sessionId, 'session_connected', {
            sessionId,
            status: 'connected',
            user: meta.user || sock.user,
          });

          // Dispatch session.status to webhook
          const connectedStatusPayload = {
            event: 'session.status',
            sessionId,
            timestamp: new Date().toISOString(),
            data: {
              status: 'connected',
              phone: meta.user?.id ? extractPhoneFromJid(meta.user.id) : (currentSession?.phoneNumber || null),
              pushName: meta.user?.name || null,
            },
          };
          WebhookService.dispatch(connectedStatusPayload).catch(() => {});
        }

        // 3. Connection closed / disconnected
        if (connection === 'close') {
          this.qrCodes.delete(sessionId);
          const disconnectError = lastDisconnect?.error as any;
          const boomError = disconnectError as Boom;
          const statusCode = boomError?.output?.statusCode || disconnectError?.status || disconnectError?.statusCode;
          const errorMessage = disconnectError?.message || 'Connection closed';
          const errorStack = disconnectError?.stack || undefined;

          // Record DISCONNECTED status in DB
          DbService.updateSessionStatus(sessionId, SessionStatus.DISCONNECTED, {
            lastActiveAt: new Date(),
          }).catch(() => {});

          const isConflict =
            statusCode === DisconnectReason.connectionReplaced ||
            statusCode === 440 ||
            (typeof errorMessage === 'string' && errorMessage.toLowerCase().includes('conflict')) ||
            (typeof errorMessage === 'string' && errorMessage.toLowerCase().includes('connection replaced'));

          let category = 'Unknown Disconnection';
          if (isConflict) {
            category = 'Connection Replaced / Stream Conflict (440)';
          } else if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
            category = 'Logged Out / Credentials Dead (401)';
          } else if (statusCode === DisconnectReason.timedOut || statusCode === 408) {
            category = 'Connection Timed Out / Socket Dead (408)';
          } else if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
            category = 'Stream Restart Required (515)';
          } else if (statusCode === DisconnectReason.connectionClosed || statusCode === 428) {
            category = 'Connection Closed by Host (428)';
          } else if (statusCode === DisconnectReason.connectionLost) {
            category = 'Connection Lost (408)';
          } else if (statusCode === DisconnectReason.badSession || statusCode === 500) {
            category = 'Bad Session Credentials (500)';
          } else if (statusCode === DisconnectReason.unavailableService || statusCode === 503) {
            category = 'WhatsApp Service Unavailable (503)';
          } else if (statusCode === DisconnectReason.multideviceMismatch || statusCode === 411) {
            category = 'Multi-Device Protocol Mismatch (411)';
          } else if (statusCode === DisconnectReason.forbidden || statusCode === 403) {
            category = 'Access Forbidden (403)';
          }

          const isLoggedOut = !isConflict && (statusCode === DisconnectReason.loggedOut || statusCode === 401);
          const isRestartRequired = !isConflict && (statusCode === DisconnectReason.restartRequired || statusCode === 515);
          const isQrExpired =
            !isConflict &&
            (errorMessage.includes('QR refs attempts ended') ||
            ((statusCode === DisconnectReason.timedOut || statusCode === 408) && (meta.status === 'qr_ready' || meta.status === 'connecting')));

          if (isQrExpired) {
            category = 'QR Code Expired (Timed Out)';
          }

          const logMethod = isQrExpired ? 'info' : (isConflict ? 'warn' : (isLoggedOut || (statusCode && statusCode >= 500 && statusCode !== 515) ? 'warn' : (statusCode === 515 ? 'debug' : (statusCode ? 'info' : 'debug'))));

          const preservedMode = currentSession?.authMode || meta.authMode || 'qr';
          const preservedPhone = currentSession?.phoneNumber;

          sessionLog[logMethod](
            {
              statusCode,
              category,
              error: errorMessage,
              stack: isQrExpired ? undefined : errorStack,
              isConflict,
              isLoggedOut,
              isRestartRequired,
              isQrExpired,
              reconnectAttempts: meta.reconnectAttempts,
              preservedMode,
            },
            `[SessionService] Socket close event: ${category} (HTTP ${statusCode || 'unknown'})`
          );

          if (isQrExpired) {
            meta.status = 'qr_expired';
            meta.qr = null;
            meta.qrUpdatedAt = null;
            meta.reconnectAttempts = 0;
            this.activeSockets.delete(sessionId);
            this.sessions.delete(sessionId);

            try {
              await redis.del(`wa:session:${sessionId}:qr`);
            } catch {
              // Ignore
            }

            sessionLog.info(
              { statusCode },
              '[SessionService] QR code pairing window expired (no scan detected before timeout). Awaiting new init.'
            );

            this.logEvent('session_event', sessionId, {
              action: 'qr_expired',
              statusCode,
            });
            return;
          }

          if (isConflict) {
            sessionLog.warn(
              { sessionId, statusCode, error: errorMessage },
              '[SessionService] Stream conflict / connection replaced: Another WhatsApp client connected or socket collision detected. Preserving credentials in Redis.'
            );
            meta.status = 'disconnected';
            meta.qr = null;
            meta.reconnectAttempts = 0;
            this.activeSockets.delete(sessionId);
            this.sessions.delete(sessionId);

            this.logEvent('session_event', sessionId, {
              action: 'stream_conflict',
              statusCode: 440,
              category,
            });
            this.emitEvent(sessionId, 'stream_conflict', {
              sessionId,
              message: 'Connection replaced or conflict detected with another active WhatsApp session. Click Reconnect to resume.',
            });
            return;
          }

          const wasRegistered = Boolean(sock.authState?.creds?.registered || meta.status === 'connected');

          if (isLoggedOut) {
            meta.status = 'logged_out';
            meta.qr = null;
            meta.user = null;
            meta.reconnectAttempts = 0;
            this.activeSockets.delete(sessionId);
            this.sessions.delete(sessionId);

            try {
              const purgedCount = await clearRedisSession(redis, sessionId);
              sessionLog.info({ purgedCount }, '[SessionService] Cleaned up and purged logged-out session keys from Redis');
            } catch (purgeErr: any) {
              sessionLog.error({ err: purgeErr.message, stack: purgeErr.stack }, '[SessionService] Error purging Redis session');
            }

            this.logEvent('session_event', sessionId, {
              action: 'logged_out',
              statusCode,
            });
          } else if (preservedMode === 'pairing_code' && !wasRegistered) {
            sessionLog.info(
              { statusCode, category },
              '[SessionService] Socket closed for unauthenticated pairing_code session. Bypassing auto-reconnect loop.'
            );
            meta.status = 'disconnected';
            meta.qr = null;
            this.activeSockets.delete(sessionId);
            this.sessions.delete(sessionId);
            this.logEvent('session_event', sessionId, {
              action: 'disconnected',
              statusCode,
              category,
            });
          } else if (isRestartRequired) {
            sessionLog.info('[SessionService] Stream restart required by Baileys protocol (515), executing immediate reconnection');
            this.activeSockets.delete(sessionId);
            this.sessions.delete(sessionId);
            setTimeout(() => {
              // NEVER default back to 'qr' if the session was explicitly started in 'pairing_code' mode
              this.initSession(sessionId, {
                authMode: preservedMode,
                phoneNumber: preservedPhone,
              }).catch((reconnErr) => {
                sessionLog.error({ err: reconnErr.message, stack: reconnErr.stack }, '[SessionService] Stream restart reconnection failed');
              });
            }, 500);
          } else {
            meta.status = 'disconnected';
            meta.qr = null;
            this.activeSockets.delete(sessionId);
            this.sessions.delete(sessionId);

            this.logEvent('session_event', sessionId, {
              action: 'disconnected',
              statusCode,
              category,
            });

            if (meta.reconnectAttempts < 5) {
              meta.reconnectAttempts++;
              const delay = Math.min(meta.reconnectAttempts * 1500, 6000);
              sessionLog.info(
                { attempt: meta.reconnectAttempts, maxAttempts: 5, delayMs: delay, mode: preservedMode },
                `[SessionService] Scheduling auto-reconnection attempt ${meta.reconnectAttempts}/5 in ${delay}ms preserving mode '${preservedMode}'`
              );

              setTimeout(() => {
                // Preserve authMode during auto-reconnection
                this.initSession(sessionId, {
                  authMode: preservedMode,
                  phoneNumber: preservedPhone,
                }).catch((reconnErr) => {
                  sessionLog.error({ err: reconnErr.message, stack: reconnErr.stack }, '[SessionService] Auto-reconnection attempt failed');
                });
              }, delay);
            } else {
              sessionLog.error(
                { reconnectAttempts: meta.reconnectAttempts },
                '[SessionService] Exceeded maximum auto-reconnect attempts (5). Session remains disconnected until manual init.'
              );
            }
          }
        }
      });

      // Step E: Listen for inbound messages & dispatch via WebhookService
      sock.ev.on('messages.upsert', async ({ type, messages }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
          if (msg.key.fromMe || !msg.message) {
            continue;
          }

          const extractedText = this.extractMessageText(msg);

          // Process media via MediaService
          const inboundMedia = await MediaService.processInboundMedia(
            sessionId,
            msg,
            sock,
            baileysLogger
          );

          const inboundData = {
            key: msg.key,
            from: msg.key.remoteJid,
            pushName: msg.pushName || null,
            text: extractedText,
            media: inboundMedia,
            raw: msg,
          };

          const payload: Record<string, any> = {
            event: 'message.inbound',
            sessionId,
            timestamp: new Date().toISOString(),
            data: inboundData,
            // Backwards compatibility for legacy receivers expecting message at root
            message: {
              key: msg.key,
              pushName: msg.pushName || null,
              text: extractedText,
              raw: msg,
              media: inboundMedia,
            },
          };

          sessionLog.info(
            {
              from: msg.key.remoteJid,
              pushName: msg.pushName,
              hasMedia: !!inboundMedia,
              mediaType: inboundMedia?.type,
              textPreview: extractedText ? extractedText.slice(0, 70) : undefined,
            },
            '[InboundMessage] WhatsApp message received, preparing webhook relay'
          );

          this.logEvent('inbound_message', sessionId, {
            from: msg.key.remoteJid,
            pushName: msg.pushName,
            text: extractedText,
            media: inboundMedia
              ? {
                  type: inboundMedia.type,
                  url: inboundMedia.url,
                  fileSize: inboundMedia.fileSize,
                  filename: inboundMedia.filename,
                }
              : undefined,
          });

          // Ingest received message into relational DB
          const inboundMsgId = msg.key.id || crypto.randomUUID();
          DbService.createMessage({
            id: inboundMsgId,
            sessionId,
            direction: MessageDirection.INBOUND,
            remoteJid: msg.key.remoteJid || '',
            lidJid: (msg.key as any).participant || (msg.key as any).remoteJidAlt || null,
            text: extractedText || null,
            hasMedia: !!inboundMedia,
            mediaType: inboundMedia?.type || null,
            mediaUrl: inboundMedia?.url || null,
            status: MessageStatus.SERVER_ACK,
            statusRaw: 2,
          }).catch(() => {});

          // Post asynchronously to configured Laravel webhook
          WebhookService.dispatch(payload, (evt, details) => {
            this.logEvent(
              evt === 'dispatched' ? 'webhook_dispatched' : 'webhook_failed',
              sessionId,
              details
            );
          }).catch((webhookErr) => {
            sessionLog.error({ err: webhookErr.message, stack: webhookErr.stack }, '[InboundMessage] Webhook relay error');
          });
        }
      });

      // Step F: Listen for message delivery receipts (ACK updates) & relay to webhook
      sock.ev.on('messages.update', async (updates) => {
        for (const item of updates) {
          const status = item.update?.status;

          if (status !== undefined && status !== null) {
            const messageId = item.key?.id || '';
            const remoteJid = item.key?.remoteJid || '';

            const statusLabel = this.getAckStatusLabel(status);

            const ackPayload: Record<string, any> = {
              event: 'message.ack',
              sessionId,
              timestamp: new Date().toISOString(),
              data: {
                messageId,
                remoteJid,
                status,
                statusLabel,
              },
            };

            sessionLog.info(
              {
                messageId,
                remoteJid,
                status,
                statusLabel,
                fromMe: item.key?.fromMe,
                step: 'ack_received',
              },
              `[OutboundLifecycle] Message delivery ACK: ${statusLabel} (code: ${status})`
            );

            this.logEvent('message_ack', sessionId, {
              messageId,
              remoteJid,
              status,
              statusLabel,
              fromMe: item.key?.fromMe,
            });

            // Map Baileys status code to Prisma MessageStatus and update DB
            let mappedStatus: MessageStatus = MessageStatus.SERVER_ACK;
            if (status === 0) mappedStatus = MessageStatus.FAILED;
            else if (status === 1) mappedStatus = MessageStatus.ENQUEUED;
            else if (status === 2) mappedStatus = MessageStatus.SERVER_ACK;
            else if (status === 3) mappedStatus = MessageStatus.DELIVERY_ACK;
            else if (status >= 4) mappedStatus = MessageStatus.READ;

            if (messageId) {
              DbService.updateMessageStatus(messageId, mappedStatus, status).catch(() => {});
            }

            WebhookService.dispatch(ackPayload, (evt, details) => {
              this.logEvent(
                evt === 'dispatched' ? 'webhook_dispatched' : 'webhook_failed',
                sessionId,
                details
              );
            }).catch((webhookErr) => {
              sessionLog.error(
                { messageId, status, err: webhookErr.message, stack: webhookErr.stack },
                '[OutboundLifecycle] Failed to dispatch ACK update to webhook'
              );
            });
          }
        }
      });

      return meta;
    } catch (err: any) {
      meta.status = 'disconnected';
      sessionLog.error({ err: err.message, stack: err.stack }, '[SessionService] Failed to initialize session');
      throw err;
    }
  }

  /**
   * Helper to convert numeric Baileys ACK status codes to human-readable labels.
   */
  public getAckStatusLabel(status: number): string {
    switch (status) {
      case 0:
        return 'ERROR (Failed)';
      case 1:
        return 'PENDING';
      case 2:
        return 'SERVER_ACK (Sent)';
      case 3:
        return 'DELIVERY_ACK (Delivered)';
      case 4:
        return 'READ (Seen)';
      case 5:
        return 'PLAYED (Voice Note)';
      default:
        return `STATUS_${status}`;
    }
  }

  /**
   * Helper to extract human-readable text from varied WhatsApp message protos.
   */
  public extractMessageText(msg: proto.IWebMessageInfo): string {
    const m = msg.message;
    if (!m) return '';

    return (
      m.conversation ||
      m.extendedTextMessage?.text ||
      m.imageMessage?.caption ||
      m.videoMessage?.caption ||
      m.documentMessage?.caption ||
      m.buttonsResponseMessage?.selectedButtonId ||
      m.listResponseMessage?.singleSelectReply?.selectedRowId ||
      m.templateButtonReplyMessage?.selectedId ||
      m.pollCreationMessage?.name ||
      ''
    );
  }

  /**
   * Sends an outbound text message via the session socket.
   */
  public async sendMessage(
    sessionId: string,
    jid: string,
    text: string,
    presence: boolean = true
  ): Promise<OutboundMessageResult> {
    const sock = this.activeSockets.get(sessionId);
    const meta = this.metadataMap.get(sessionId);

    if (!sock || meta?.status !== 'connected') {
      throw new Error(`Session '${sessionId}' is not active or connected to WhatsApp`);
    }

    return MessageService.sendText(
      sessionId,
      sock,
      jid,
      text,
      (type, sId, details) => {
        this.logEvent(type, sId, details);
      },
      presence
    );
  }

  /**
   * Sends an outbound media message via the session socket.
   */
  public async sendMedia(
    sessionId: string,
    jid: string,
    type: 'image' | 'audio' | 'document' | 'video',
    url: string,
    options?: {
      caption?: string;
      filename?: string;
      ptt?: boolean;
    }
  ): Promise<OutboundMessageResult> {
    const sock = this.activeSockets.get(sessionId);
    const meta = this.metadataMap.get(sessionId);

    if (!sock || meta?.status !== 'connected') {
      throw new Error(`Session '${sessionId}' is not active or connected to WhatsApp`);
    }

    return MessageService.sendMedia(sessionId, sock, jid, type, url, options, (t, sId, details) => {
      this.logEvent(t, sId, details);
    });
  }

  /**
   * Checks if a session is currently in phone pairing code mode (deprecated legacy helper).
   */
  public isPairingMode(_sessionId: string): boolean {
    return false;
  }

  /**
   * Checks if a session is currently marked in terminatingSessions.
   */
  public isTerminating(sessionId: string): boolean {
    return this.terminatingSessions.has(sessionId);
  }

  /**
   * Marks a session as terminating for intentional shutdown or purge guards.
   */
  public markTerminating(sessionId: string): void {
    this.terminatingSessions.add(sessionId);
  }

  /**
   * Clears a session from terminatingSessions.
   */
  public clearTerminating(sessionId: string): void {
    this.terminatingSessions.delete(sessionId);
  }

  /**
   * Retrieves raw QR string for a given session from memory or Redis.
   */
  public async getQR(sessionId: string): Promise<string | null> {
    if (this.terminatingSessions.has(sessionId)) return null;

    const memoryQr = this.qrCodes.get(sessionId);
    if (memoryQr) {
      return memoryQr;
    }

    const meta = this.metadataMap.get(sessionId);
    if (meta?.qr) {
      return meta.qr;
    }

    try {
      const redis = await getRedisClient();
      const cachedQr = await redis.get(`wa:session:${sessionId}:qr`);
      if (cachedQr) {
        this.qrCodes.set(sessionId, cachedQr);
        if (meta) meta.qr = cachedQr;
        return cachedQr;
      }
    } catch {
      // Ignore Redis query error
    }

    return null;
  }

  /**
   * Retrieves session metadata including active WASocket reference if initialized.
   */
  public getSession(sessionId: string): (SessionMetadata & { sock?: WASocket }) | null {
    if (this.terminatingSessions.has(sessionId)) return null;
    const meta = this.metadataMap.get(sessionId);
    if (!meta) return null;
    const sock = this.sessions.get(sessionId)?.sock || this.activeSockets.get(sessionId);
    return {
      ...meta,
      sock,
    };
  }

  /**
   * Retrieves active WASocket instance for a session.
   */
  public getSocket(sessionId: string): WASocket | null {
    if (this.terminatingSessions.has(sessionId)) return null;
    return this.sessions.get(sessionId)?.sock || this.activeSockets.get(sessionId) || null;
  }

  /**
   * Lists all sessions tracked by the manager.
   */
  public listSessions(): SessionSummary[] {
    return Array.from(this.metadataMap.values())
      .filter((m) => !this.terminatingSessions.has(m.id))
      .map((m) => ({
        id: m.id,
        status: m.status,
        authMode: m.authMode,
        hasQr: !!m.qr,
        user: m.user,
        createdAt: m.createdAt,
        lastActiveAt: m.lastActiveAt,
      }));
  }

  /**
   * Automatically restores all active sessions from Redis credentials on server boot.
   */
  public async restoreAllSessions(): Promise<void> {
    try {
      const redis = await getRedisClient();
      logger.info('[SessionService] Querying Redis for active sessions to auto-restore (pattern: wa:session:*:creds)...');

      let keys: string[] = [];
      try {
        keys = await redis.keys('wa:session:*:creds');
      } catch (err: any) {
        logger.warn({ err: err.message }, '[SessionService] Failed to query Redis keys for auto-restore');
        return;
      }

      if (!keys || keys.length === 0) {
        logger.info('[SessionService] No previous session credentials found in Redis for auto-restore.');
        return;
      }

      const sessionIds = new Set<string>();
      for (const key of keys) {
        const match = key.match(/^wa:session:(.+):creds$/);
        if (match && match[1]) {
          sessionIds.add(match[1]);
        }
      }

      logger.info(
        { count: sessionIds.size, sessions: Array.from(sessionIds) },
        `[SessionService] Found ${sessionIds.size} existing session(s). Sequentially auto-restoring in background...`
      );

      for (const sessionId of sessionIds) {
        const sessionLog = createSessionLogger(sessionId);
        try {
          sessionLog.info('[SessionService] Auto-restoring session from persistent Redis credentials...');
          await this.initSession(sessionId);
          sessionLog.info('[SessionService] Successfully auto-restored session from Redis');
        } catch (sessionErr: any) {
          sessionLog.error(
            { err: sessionErr.message, stack: sessionErr.stack },
            '[SessionService] Failed to auto-restore session; skipping to next'
          );
        }
      }

      logger.info('[SessionService] Session auto-restore sequence finished.');
    } catch (err: any) {
      logger.error({ err: err.message, stack: err.stack }, '[SessionService] Error executing restoreAllSessions');
    }
  }

  /**
   * Requests an 8-character pairing code for phone number pairing (alternative to QR scanning).
   * Directly uses the active WASocket instance on demand.
   */
  public async requestPairingCode(sessionId: string, phoneNumber: string): Promise<string> {
    const sessionLog = createSessionLogger(sessionId);

    const cleanPhone = sanitizePhoneNumber(phoneNumber);
    if (!cleanPhone || cleanPhone.length < 6) {
      sessionLog.warn({ rawPhone: phoneNumber, cleanPhone }, '[PairingCode] Invalid phone number provided');
      throw new Error('Invalid phone number. Must include country code and digits (e.g. 88017xxxxxxxx).');
    }

    const session = this.getSession(sessionId);
    if (!session || !session.sock) {
      sessionLog.warn('[PairingCode] Session not found or socket not initialized');
      throw new Error(`Session '${sessionId}' not found or socket not initialized.`);
    }

    const sock = session.sock;
    if (sock.authState?.creds?.registered) {
      sessionLog.warn('[PairingCode] Pairing request rejected: session is already registered and authenticated');
      throw new Error(`Session '${sessionId}' is already registered and authenticated.`);
    }

    sessionLog.info(
      { phoneNumber: cleanPhone, step: 'request_sent', timestamp: new Date().toISOString() },
      '[PairingCode] Requesting 8-character pairing code from WhatsApp socket...'
    );

    const rawCode = await sock.requestPairingCode(cleanPhone);
    const formattedCode = formatPairingCode(rawCode);

    sessionLog.info(
      {
        phoneNumber: cleanPhone,
        code: formattedCode,
        step: 'code_generated',
        timestamp: new Date().toISOString(),
      },
      '[PairingCode] 8-character pairing code generated successfully.'
    );

    this.logEvent('session_event', sessionId, {
      action: 'pairing_code_generated',
      phoneNumber: cleanPhone,
      code: formattedCode,
    });

    this.emitEvent(sessionId, 'pairing_code_generated', {
      phoneNumber: cleanPhone,
      code: formattedCode,
    });

    return formattedCode;
  }

  /**
   * Gracefully closes all active WASocket connections without clearing Redis persistence keys.
   */
  public async closeAllSessions(): Promise<void> {
    const count = this.activeSockets.size;
    logger.info({ count }, '[SessionService] Gracefully closing all active WASockets without purging Redis keys...');

    for (const [sessionId, sock] of this.activeSockets.entries()) {
      const sessionLog = createSessionLogger(sessionId);
      try {
        if ((sock as any).ws && typeof (sock as any).ws.close === 'function') {
          (sock as any).ws.close();
        }
        sock.end(undefined);
        sessionLog.info('[SessionService] Active socket ended gracefully');
      } catch (err: any) {
        sessionLog.warn({ err: err.message }, '[SessionService] Warning while closing socket');
      }
    }

    this.activeSockets.clear();
    this.sessions.clear();
    this.qrCodes.clear();
    logger.info('[SessionService] All active sockets closed.');
  }

  /**
   * Gracefully unlinks WhatsApp session via sock.logout() without wiping tenant configuration.
   */
  public async logoutSession(sessionId: string): Promise<void> {
    const sessionLog = createSessionLogger(sessionId);
    this.terminatingSessions.add(sessionId);
    this.qrCodes.delete(sessionId);

    const currentSession = this.sessions.get(sessionId);
    const sock = currentSession?.sock || this.activeSockets.get(sessionId);
    const meta = this.metadataMap.get(sessionId);

    if (sock) {
      try {
        await sock.logout();
        sessionLog.info('[SessionService] Socket logged out from WhatsApp');
      } catch (err: any) {
        sessionLog.warn({ err: err.message }, '[SessionService] sock.logout() warning, closing socket');
        try {
          if ((sock as any).ws && typeof (sock as any).ws.close === 'function') {
            (sock as any).ws.close();
          }
          sock.end(undefined);
        } catch {
          // Ignore
        }
      }
    }

    this.activeSockets.delete(sessionId);
    this.sessions.delete(sessionId);

    if (meta) {
      meta.status = 'disconnected';
      meta.qr = null;
      meta.user = null;
      meta.lastActiveAt = Date.now();
    }

    // Update DB status to DISCONNECTED
    DbService.updateSessionStatus(sessionId, SessionStatus.DISCONNECTED, {
      lastActiveAt: new Date(),
    }).catch(() => {});

    try {
      const redis = await getRedisClient();
      await clearRedisSession(redis, sessionId);
      sessionLog.info('[SessionService] Cleared Redis auth state on logout (tenant config preserved)');
    } catch (err: any) {
      sessionLog.warn({ err: err.message }, '[SessionService] Error clearing Redis credentials on logout');
    }

    setTimeout(() => {
      this.terminatingSessions.delete(sessionId);
    }, 4000);

    this.emitEvent(sessionId, 'session_logged_out', {
      sessionId,
      status: 'disconnected',
      message: 'WhatsApp session unlinked and logged out',
    });
  }

  /**
   * Disconnects a session socket, clears its local cache, and purges Redis auth state.
   */
  public async deleteSession(sessionId: string): Promise<void> {
    const sessionLog = createSessionLogger(sessionId);

    this.terminatingSessions.add(sessionId);
    this.qrCodes.delete(sessionId);

    const currentSession = this.sessions.get(sessionId);
    const sock = currentSession?.sock || this.activeSockets.get(sessionId);
    this.activeSockets.delete(sessionId);
    this.sessions.delete(sessionId);
    this.metadataMap.delete(sessionId);

    if (sock) {
      try {
        if ((sock as any).ws && typeof (sock as any).ws.close === 'function') {
          (sock as any).ws.close();
        }
        sock.end(undefined);
      } catch (err: any) {
        sessionLog.warn({ err: err.message }, '[SessionService] Socket end warning during purge');
      }
    }

    try {
      const redis = await getRedisClient();
      let keys: string[] = [];
      try {
        keys = await redis.keys(`wa:session:${sessionId}:*`);
      } catch (keyErr: any) {
        sessionLog.warn({ err: keyErr.message }, '[SessionService] Failed to query Redis keys during purge');
      }

      if (keys && keys.length > 0) {
        await redis.del(...keys);
        sessionLog.info({ count: keys.length }, '[SessionService] Deleted Redis session keys via pattern');
      }

      await clearRedisSession(redis, sessionId);
      sessionLog.info('[SessionService] Tenant session permanently purged from Redis and memory');
    } catch (err: any) {
      sessionLog.error({ err: err.message, stack: err.stack }, '[SessionService] Error clearing Redis on session delete');
    }

    // Cascade delete in relational database
    DbService.deleteSession(sessionId).catch(() => {});

    setTimeout(() => {
      this.terminatingSessions.delete(sessionId);
    }, 5000);

    this.logEvent('session_event', sessionId, { action: 'purged' });
  }

  /**
   * Alias for deleteSession.
   */
  public async purgeSession(sessionId: string): Promise<void> {
    return this.deleteSession(sessionId);
  }
}

/**
 * Singleton SessionService instance.
 */
export const sessionService = new SessionService();
