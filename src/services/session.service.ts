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
import { formatPairingCode, sanitizePhoneNumber } from '../utils/jid.util.js';
import { createSessionLogger, logger } from '../utils/logger.js';
import { getWhatsAppVersion } from '../utils/versionGuard.js';
import { MediaService } from './media.service.js';
import { MessageService } from './message.service.js';
import { WebhookService } from './webhook.service.js';
import type {
  OutboundMessageResult,
  RecentEvent,
  SessionMetadata,
  SessionSummary,
  WebhookAckPayload,
  WebhookInboundPayload,
} from '../types/index.js';

export class SessionService {
  private activeSockets: Map<string, WASocket> = new Map();
  private metadataMap: Map<string, SessionMetadata> = new Map();
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
   * Returns recent events for observability and debugging.
   */
  public getRecentEvents(): RecentEvent[] {
    return [...this.recentEvents];
  }

  /**
   * Initializes or boots a Baileys WhatsApp socket session for a tenant.
   */
  public async initSession(sessionId: string): Promise<SessionMetadata> {
    const sessionLog = createSessionLogger(sessionId);

    // Clear any terminating flag if re-initializing this session
    this.terminatingSessions.delete(sessionId);

    const existingSocket = this.activeSockets.get(sessionId);
    const existingMeta = this.metadataMap.get(sessionId);

    // If session is already connected or actively connecting, return its state
    if (existingSocket && existingMeta && (existingMeta.status === 'connected' || existingMeta.status === 'connecting')) {
      sessionLog.info({ status: existingMeta.status }, '[SessionService] Session already initialized or connecting');
      return existingMeta;
    }

    // Terminate any previous socket reference if re-initializing
    if (existingSocket) {
      try {
        existingSocket.end(undefined);
      } catch {
        // Ignore termination error
      }
      this.activeSockets.delete(sessionId);
    }

    const redis = await getRedisClient();

    // Prepare metadata record
    const meta: SessionMetadata = {
      id: sessionId,
      status: 'connecting',
      qr: null,
      qrUpdatedAt: null,
      user: null,
      reconnectAttempts: existingMeta?.reconnectAttempts || 0,
      createdAt: existingMeta?.createdAt || Date.now(),
      lastActiveAt: Date.now(),
    };
    this.metadataMap.set(sessionId, meta);
    this.logEvent('session_event', sessionId, { action: 'init_started' });
    sessionLog.info({ reconnectAttempts: meta.reconnectAttempts }, '[SessionService] Initializing WhatsApp session socket...');

    try {
      // Step A: Initialize Custom Redis Auth State & Resolve WhatsApp Web Protocol Version
      const { state, saveCreds } = await useRedisAuthState(redis, sessionId);
      const { version } = await getWhatsAppVersion(redis);

      // Create pino sublogger for Baileys with minimal noise
      const baileysLogger = logger.child({ module: 'baileys', sessionId });
      baileysLogger.level = 'warn';

      // Step B: Create WASocket instance with synchronized protocol version and standard browser signature
      const sock = makeWASocket({
        version,
        auth: state,
        logger: baileysLogger,
        printQRInTerminal: false,
        browser: Browsers.macOS('Desktop'), // Standard client signature
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
      });

      this.activeSockets.set(sessionId, sock);

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
        // If session is marked for intentional termination/purge, suppress updates
        if (this.terminatingSessions.has(sessionId)) {
          sessionLog.info(
            '[SessionService] Connection update received during intentional purge; ignoring and bypassing reconnect.'
          );
          this.activeSockets.delete(sessionId);
          this.metadataMap.delete(sessionId);
          return;
        }

        const { connection, lastDisconnect, qr } = update;
        meta.lastActiveAt = Date.now();

        // 1. Capture and cache raw QR strings
        if (qr) {
          meta.qr = qr;
          meta.qrUpdatedAt = Date.now();
          meta.status = 'qr_ready';
          sessionLog.info('[SessionService] New WhatsApp QR Code generated and ready for scan');

          try {
            await redis.set(`wa:session:${sessionId}:qr`, qr, 'EX', 60);
          } catch (err: any) {
            sessionLog.warn({ err: err.message }, '[Redis] Failed to cache QR string in Redis');
          }

          this.logEvent('session_event', sessionId, { action: 'qr_generated' });
        }

        // 2. Connection opened successfully
        if (connection === 'open') {
          meta.status = 'connected';
          meta.qr = null;
          meta.qrUpdatedAt = null;
          meta.reconnectAttempts = 0;

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

          sessionLog.info(
            { user: meta.user, socketId: sock.user?.id },
            '[SessionService] WhatsApp connection successfully established (open)'
          );
          this.logEvent('session_event', sessionId, {
            action: 'connected',
            user: meta.user,
          });
        }

        // 3. Connection closed / disconnected
        if (connection === 'close') {
          const disconnectError = lastDisconnect?.error as any;
          const boomError = disconnectError as Boom;
          const statusCode = boomError?.output?.statusCode || disconnectError?.status || disconnectError?.statusCode;
          const errorMessage = disconnectError?.message || 'Connection closed';
          const errorStack = disconnectError?.stack || undefined;

          let category = 'Unknown Disconnection';
          if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
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
          }

          const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
          const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;
          const isQrExpired =
            errorMessage.includes('QR refs attempts ended') ||
            (!meta.user && (statusCode === DisconnectReason.timedOut || statusCode === 408) && (meta.status === 'qr_ready' || meta.status === 'connecting'));

          sessionLog.warn(
            {
              statusCode,
              category,
              error: errorMessage,
              stack: errorStack,
              isLoggedOut,
              isRestartRequired,
              isQrExpired,
              reconnectAttempts: meta.reconnectAttempts,
            },
            `[SessionService] Socket close event: ${category} (HTTP ${statusCode || 'unknown'})`
          );

          if (isQrExpired) {
            meta.status = 'qr_expired';
            meta.qr = null;
            meta.qrUpdatedAt = null;
            meta.reconnectAttempts = 0;
            this.activeSockets.delete(sessionId);

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

          if (isLoggedOut) {
            meta.status = 'logged_out';
            meta.qr = null;
            meta.user = null;
            meta.reconnectAttempts = 0;
            this.activeSockets.delete(sessionId);

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
          } else if (isRestartRequired) {
            sessionLog.info('[SessionService] Stream restart required by Baileys protocol (515), executing immediate reconnection');
            this.activeSockets.delete(sessionId);
            setTimeout(() => {
              this.initSession(sessionId).catch((reconnErr) => {
                sessionLog.error({ err: reconnErr.message, stack: reconnErr.stack }, '[SessionService] Stream restart reconnection failed');
              });
            }, 500);
          } else {
            meta.status = 'disconnected';
            meta.qr = null;
            this.activeSockets.delete(sessionId);

            this.logEvent('session_event', sessionId, {
              action: 'disconnected',
              statusCode,
              category,
            });

            if (meta.reconnectAttempts < 5) {
              meta.reconnectAttempts++;
              const delay = Math.min(meta.reconnectAttempts * 1500, 6000);
              sessionLog.info(
                { attempt: meta.reconnectAttempts, maxAttempts: 5, delayMs: delay },
                `[SessionService] Scheduling auto-reconnection attempt ${meta.reconnectAttempts}/5 in ${delay}ms`
              );

              setTimeout(() => {
                this.initSession(sessionId).catch((reconnErr) => {
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

          const payload: WebhookInboundPayload = {
            sessionId,
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

            const ackPayload: WebhookAckPayload = {
              sessionId,
              event: 'message.ack',
              data: {
                messageId,
                remoteJid,
                status,
              },
            };

            const statusLabel = this.getAckStatusLabel(status);

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
    text: string
  ): Promise<OutboundMessageResult> {
    const sock = this.activeSockets.get(sessionId);
    const meta = this.metadataMap.get(sessionId);

    if (!sock || meta?.status !== 'connected') {
      throw new Error(`Session '${sessionId}' is not active or connected to WhatsApp`);
    }

    return MessageService.sendText(sessionId, sock, jid, text, (type, sId, details) => {
      this.logEvent(type, sId, details);
    });
  }

  /**
   * Sends an outbound media message via the session socket.
   */
  public async sendMedia(
    sessionId: string,
    jid: string,
    type: 'image' | 'audio' | 'document',
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
   * Retrieves raw QR string for a given session from memory or Redis.
   */
  public async getQR(sessionId: string): Promise<string | null> {
    if (this.terminatingSessions.has(sessionId)) return null;

    const meta = this.metadataMap.get(sessionId);
    if (meta?.qr) {
      return meta.qr;
    }

    try {
      const redis = await getRedisClient();
      const cachedQr = await redis.get(`wa:session:${sessionId}:qr`);
      if (cachedQr) {
        if (meta) meta.qr = cachedQr;
        return cachedQr;
      }
    } catch {
      // Ignore Redis query error
    }

    return null;
  }

  /**
   * Retrieves session metadata.
   */
  public getSession(sessionId: string): SessionMetadata | null {
    if (this.terminatingSessions.has(sessionId)) return null;
    return this.metadataMap.get(sessionId) || null;
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
   */
  public async requestPairingCode(sessionId: string, phoneNumber: string): Promise<string> {
    const sessionLog = createSessionLogger(sessionId);
    let sock = this.activeSockets.get(sessionId);
    let meta = this.metadataMap.get(sessionId);

    if (!sock || !meta) {
      meta = await this.initSession(sessionId);
      sock = this.activeSockets.get(sessionId);
    }

    if (!sock) {
      sessionLog.error({ phoneNumber }, '[PairingCode] Failed to initialize socket for pairing');
      throw new Error(`Failed to initialize session '${sessionId}' for pairing code`);
    }

    const cleanPhone = sanitizePhoneNumber(phoneNumber);
    if (!cleanPhone || cleanPhone.length < 8) {
      sessionLog.warn({ rawPhone: phoneNumber, cleanPhone }, '[PairingCode] Invalid phone number provided');
      throw new Error('Invalid phone number. Must include country code and digits (e.g. 88017xxxxxxxx).');
    }

    if (sock.authState?.creds?.registered) {
      sessionLog.warn('[PairingCode] Pairing request rejected: session is already registered and authenticated');
      throw new Error(`Session '${sessionId}' is already registered and authenticated.`);
    }

    sessionLog.info(
      { phoneNumber: cleanPhone, step: 'request_sent', timestamp: new Date().toISOString() },
      '[PairingCode] Requesting 8-character pairing code from WhatsApp socket...'
    );

    const rawCode = await sock.requestPairingCode(cleanPhone);

    if (!rawCode) {
      sessionLog.error({ phoneNumber: cleanPhone }, '[PairingCode] WhatsApp socket returned empty pairing code');
      throw new Error('WhatsApp did not return a pairing code. Please retry.');
    }

    const formattedCode = formatPairingCode(rawCode);

    sessionLog.info(
      {
        phoneNumber: cleanPhone,
        code: formattedCode,
        step: 'code_generated',
        timestamp: new Date().toISOString(),
      },
      '[PairingCode] 8-character pairing code generated successfully. Enter on phone.'
    );

    this.logEvent('session_event', sessionId, {
      action: 'pairing_code_generated',
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
        sock.end(undefined);
        sessionLog.info('[SessionService] Active socket ended gracefully');
      } catch (err: any) {
        sessionLog.warn({ err: err.message }, '[SessionService] Warning while closing socket');
      }
    }

    this.activeSockets.clear();
    logger.info('[SessionService] All active sockets closed.');
  }

  /**
   * Disconnects a session socket, clears its local cache, and purges Redis auth state.
   */
  public async deleteSession(sessionId: string): Promise<void> {
    const sessionLog = createSessionLogger(sessionId);

    this.terminatingSessions.add(sessionId);

    const sock = this.activeSockets.get(sessionId);
    this.activeSockets.delete(sessionId);
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
