import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Boom } from '@hapi/boom';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  proto,
  WASocket,
} from '@whiskeysockets/baileys';
import { clearRedisSession, useRedisAuthState } from '../auth/redisAuthState.js';
import { config, getPublicBaseUrl, getRedisClient } from '../config.js';
import { createSessionLogger, logger } from '../utils/logger.js';
import { getWhatsAppVersion } from '../utils/versionGuard.js';
import type {
  InboundMediaMetadata,
  SessionMetadata,
  SessionStatus,
  SessionSummary,
  WebhookAckPayload,
  WebhookInboundPayload,
  WebhookPayload,
} from '../types/index.js';

export interface RecentEvent {
  id: string;
  timestamp: number;
  type:
    | 'inbound_message'
    | 'outbound_message'
    | 'message_ack'
    | 'webhook_dispatched'
    | 'webhook_failed'
    | 'session_event';
  sessionId: string;
  details: Record<string, any>;
}

/**
 * Multi-Tenant Session Manager for Botla WhatsApp Gateway.
 * Manages the lifecycle of Baileys WASocket instances, Redis persistence,
 * QR code streaming, anti-ban outbound rate limiting, structured logging, and webhook dispatches.
 */
export class SessionManager {
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
   * Initializes or boots a Baileys WhatsApp socket session.
   * Connects to Redis for persistent authentication state and subscribes to lifecycle events.
   */
  public async initSession(sessionId: string): Promise<SessionMetadata> {
    const sessionLog = createSessionLogger(sessionId);

    // Clear any terminating flag if re-initializing this session
    this.terminatingSessions.delete(sessionId);

    const existingSocket = this.activeSockets.get(sessionId);
    const existingMeta = this.metadataMap.get(sessionId);

    // If session is already connected or actively connecting, return its state
    if (existingSocket && existingMeta && (existingMeta.status === 'connected' || existingMeta.status === 'connecting')) {
      sessionLog.info({ status: existingMeta.status }, '[SessionManager] Session already initialized or connecting');
      return existingMeta;
    }

    // Terminate any previous socket reference if re-initializing from qr_ready, qr_expired or disconnected
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
    sessionLog.info({ reconnectAttempts: meta.reconnectAttempts }, '[SessionManager] Initializing WhatsApp session socket...');

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
        browser: Browsers.macOS('Desktop'), // CRITICAL: Standard recognized client signature to prevent pairing rejection
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
      });

      this.activeSockets.set(sessionId, sock);

      // Step C: Listen for credentials update
      sock.ev.on('creds.update', async () => {
        try {
          await saveCreds();
          sessionLog.debug('[SessionManager] Credentials successfully updated & persisted to Redis');
        } catch (err: any) {
          sessionLog.error({ err: err.message, stack: err.stack }, '[SessionManager] Failed to save creds to Redis');
        }
      });

      // Step D: Listen for connection updates (QR, open, close)
      sock.ev.on('connection.update', async (update) => {
        // If session is marked for intentional termination/purge, suppress all updates and reconnect loops
        if (this.terminatingSessions.has(sessionId)) {
          sessionLog.info(
            '[SessionManager] Connection update received during intentional purge; ignoring and bypassing reconnect.'
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
          sessionLog.info('[SessionManager] New WhatsApp QR Code generated and ready for scan');

          // Cache QR in Redis with 60-second TTL
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

          // Clear cached QR in Redis
          try {
            await redis.del(`wa:session:${sessionId}:qr`);
          } catch {
            // Ignore
          }

          sessionLog.info(
            { user: meta.user, socketId: sock.user?.id },
            '[SessionManager] WhatsApp connection successfully established (open)'
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

          // Categorize status code context for clear operational observability
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
            `[SessionManager] Socket close event: ${category} (HTTP ${statusCode || 'unknown'})`
          );

          // QR code references timed out without being scanned
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
              '[SessionManager] QR code pairing window expired (no scan detected before timeout). Awaiting new init.'
            );

            this.logEvent('session_event', sessionId, {
              action: 'qr_expired',
              statusCode,
            });
            return;
          }

          // DisconnectReason.loggedOut (401): clean up socket and purge keys from Redis
          if (isLoggedOut) {
            meta.status = 'logged_out';
            meta.qr = null;
            meta.user = null;
            meta.reconnectAttempts = 0;
            this.activeSockets.delete(sessionId);

            try {
              const purgedCount = await clearRedisSession(redis, sessionId);
              sessionLog.info({ purgedCount }, '[SessionManager] Cleaned up and purged logged-out session keys from Redis');
            } catch (purgeErr: any) {
              sessionLog.error({ err: purgeErr.message, stack: purgeErr.stack }, '[SessionManager] Error purging Redis session');
            }

            this.logEvent('session_event', sessionId, {
              action: 'logged_out',
              statusCode,
            });
          } else if (isRestartRequired) {
            // Immediate restart required by Baileys internal state sync (515)
            sessionLog.info('[SessionManager] Stream restart required by Baileys protocol (515), executing immediate reconnection');
            this.activeSockets.delete(sessionId);
            setTimeout(() => {
              this.initSession(sessionId).catch((reconnErr) => {
                sessionLog.error({ err: reconnErr.message, stack: reconnErr.stack }, '[SessionManager] Stream restart reconnection failed');
              });
            }, 500);
          } else {
            // Unexpected disconnection: mark disconnected and attempt automatic reconnection
            meta.status = 'disconnected';
            meta.qr = null;
            this.activeSockets.delete(sessionId);

            this.logEvent('session_event', sessionId, {
              action: 'disconnected',
              statusCode,
              category,
            });

            // Reconnection guardrail with exponential delay (up to 5 attempts)
            if (meta.reconnectAttempts < 5) {
              meta.reconnectAttempts++;
              const delay = Math.min(meta.reconnectAttempts * 1500, 6000);
              sessionLog.info(
                { attempt: meta.reconnectAttempts, maxAttempts: 5, delayMs: delay },
                `[SessionManager] Scheduling auto-reconnection attempt ${meta.reconnectAttempts}/5 in ${delay}ms`
              );

              setTimeout(() => {
                this.initSession(sessionId).catch((reconnErr) => {
                  sessionLog.error({ err: reconnErr.message, stack: reconnErr.stack }, '[SessionManager] Auto-reconnection attempt failed');
                });
              }, delay);
            } else {
              sessionLog.error(
                { reconnectAttempts: meta.reconnectAttempts },
                '[SessionManager] Exceeded maximum auto-reconnect attempts (5). Session remains disconnected until manual init.'
              );
            }
          }
        }
      });

      // Step E: Listen for inbound messages & dispatch to Laravel webhook
      sock.ev.on('messages.upsert', async ({ type, messages }) => {
        // Filter strictly for notify messages
        if (type !== 'notify') return;

        for (const msg of messages) {
          // Ignore messages sent by ourselves or with no content
          if (msg.key.fromMe || !msg.message) {
            continue;
          }

          const extractedText = this.extractMessageText(msg);

          // Detect if message contains media attachments (image, audio, document, video)
          const mediaInfo = this.detectInboundMedia(msg);
          let inboundMedia: InboundMediaMetadata | null = null;

          if (mediaInfo) {
            try {
              const buffer = await downloadMediaMessage(
                msg,
                'buffer',
                {},
                {
                  logger: baileysLogger,
                  reuploadRequest: (update) => sock.updateMediaMessage(update),
                }
              );

              if (buffer && buffer.length > 0) {
                const messageId = msg.key.id || crypto.randomUUID();
                const ext = this.getMediaExtension(
                  mediaInfo.mimetype,
                  mediaInfo.filename,
                  mediaInfo.type === 'image' ? 'jpg' : (mediaInfo.type === 'audio' ? 'ogg' : (mediaInfo.type === 'video' ? 'mp4' : 'bin'))
                );

                const storageDir = path.resolve(process.cwd(), 'storage/media', sessionId);
                await fs.promises.mkdir(storageDir, { recursive: true });

                const fileNameOnDisk = `${messageId}.${ext}`;
                const filePath = path.join(storageDir, fileNameOnDisk);
                await fs.promises.writeFile(filePath, buffer);

                const mediaAccessUrl = `${getPublicBaseUrl()}/media/${encodeURIComponent(sessionId)}/${fileNameOnDisk}`;

                inboundMedia = {
                  url: mediaAccessUrl,
                  mimetype: mediaInfo.mimetype,
                  fileSize: buffer.length,
                  caption: mediaInfo.caption,
                  type: mediaInfo.type,
                  filename: mediaInfo.filename || fileNameOnDisk,
                };

                sessionLog.info(
                  {
                    messageId,
                    type: mediaInfo.type,
                    fileSize: buffer.length,
                    url: mediaAccessUrl,
                  },
                  '[InboundMedia] Extracted, buffered to disk and access URL formed'
                );
              }
            } catch (mediaErr: any) {
              sessionLog.error(
                { err: mediaErr.message, stack: mediaErr.stack, type: mediaInfo.type },
                '[InboundMedia] Failed to download inbound media attachment'
              );
            }
          }

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
          this.dispatchWebhook(payload).catch((webhookErr) => {
            sessionLog.error({ err: webhookErr.message, stack: webhookErr.stack }, '[InboundMessage] Webhook relay failed');
          });
        }
      });

      // Step F: Listen for message delivery & read receipts (ACK updates) & relay to Botla webhook
      sock.ev.on('messages.update', async (updates) => {
        for (const item of updates) {
          const status = item.update?.status;

          // Process status change updates:
          // status: 2 -> Server Ack (Sent)
          // status: 3 -> Delivery Ack (Delivered)
          // status: 4 -> Read / Seen Ack
          // status: 0 -> Error / Delivery Failed
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

            // Dispatch ACK asynchronously to Botla Core webhook
            this.dispatchWebhook(ackPayload).catch((webhookErr) => {
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
      sessionLog.error({ err: err.message, stack: err.stack }, '[SessionManager] Failed to initialize session');
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
   * Helper to detect and extract media metadata from inbound WhatsApp messages.
   * Handles direct media messages as well as ephemeral, view-once, and captioned document envelopes.
   */
  public detectInboundMedia(msg: proto.IWebMessageInfo): {
    type: 'image' | 'audio' | 'document' | 'video';
    mimetype: string;
    caption: string | null;
    filename: string | null;
    fileLength: number;
  } | null {
    let m = msg.message;
    if (!m) return null;

    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;

    if (m.imageMessage) {
      return {
        type: 'image',
        mimetype: m.imageMessage.mimetype || 'image/jpeg',
        caption: m.imageMessage.caption || null,
        filename: null,
        fileLength: Number(m.imageMessage.fileLength || 0),
      };
    }
    if (m.audioMessage) {
      return {
        type: 'audio',
        mimetype: m.audioMessage.mimetype || 'audio/ogg',
        caption: null,
        filename: null,
        fileLength: Number(m.audioMessage.fileLength || 0),
      };
    }
    if (m.documentMessage) {
      return {
        type: 'document',
        mimetype: m.documentMessage.mimetype || 'application/octet-stream',
        caption: m.documentMessage.caption || null,
        filename: m.documentMessage.fileName || null,
        fileLength: Number(m.documentMessage.fileLength || 0),
      };
    }
    if (m.videoMessage) {
      return {
        type: 'video',
        mimetype: m.videoMessage.mimetype || 'video/mp4',
        caption: m.videoMessage.caption || null,
        filename: null,
        fileLength: Number(m.videoMessage.fileLength || 0),
      };
    }

    return null;
  }

  /**
   * Helper to infer an appropriate file extension from mimetype or original filename.
   */
  public getMediaExtension(
    mimetype?: string | null,
    originalFileName?: string | null,
    defaultExt: string = 'bin'
  ): string {
    if (originalFileName) {
      const ext = path.extname(originalFileName).replace('.', '').toLowerCase();
      if (ext && ext.length >= 1 && ext.length <= 8) return ext;
    }
    if (!mimetype) return defaultExt;

    const cleanMime = mimetype.split(';')[0].trim().toLowerCase();
    const mimeMap: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'audio/ogg': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'audio/aac': 'aac',
      'audio/wav': 'wav',
      'video/mp4': 'mp4',
      'video/3gpp': '3gp',
      'video/quicktime': 'mov',
      'application/pdf': 'pdf',
      'application/msword': 'doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.ms-excel': 'xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'application/zip': 'zip',
      'text/plain': 'txt',
      'text/csv': 'csv',
    };

    if (mimeMap[cleanMime]) return mimeMap[cleanMime];
    const sub = cleanMime.split('/')[1];
    if (sub && /^[a-z0-9]{2,6}$/.test(sub)) return sub;

    return defaultExt;
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
   * Asynchronously posts an inbound message or ACK status payload to Botla's Laravel webhook.
   * Signs the payload using HMAC-SHA256 if WEBHOOK_SECRET is set.
   */
  public async dispatchWebhook(payload: WebhookPayload | Record<string, any>): Promise<void> {
    const webhookUrl = config.botlaWebhookUrl;
    const sessionLog = payload.sessionId ? createSessionLogger(payload.sessionId) : logger;

    if (!webhookUrl) {
      sessionLog.warn('[Webhook] No BOTLA_WEBHOOK_URL configured; skipping dispatch');
      return;
    }

    const eventName = (payload as any).event || 'inbound_message';
    const bodyString = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Botla-WhatsApp-Gateway/1.0',
    };

    if (config.webhookSecret) {
      const signature = crypto
        .createHmac('sha256', config.webhookSecret)
        .update(bodyString)
        .digest('hex');
      headers['X-Botla-Signature'] = signature;
      headers['X-Hub-Signature-256'] = `sha256=${signature}`;
    }

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers,
        body: bodyString,
        signal: AbortSignal.timeout(10000), // 10s timeout
      });

      if (!response.ok) {
        throw new Error(`Webhook returned HTTP ${response.status}: ${response.statusText}`);
      }

      sessionLog.info(
        {
          event: eventName,
          url: webhookUrl,
          status: response.status,
        },
        '[Webhook] Payload successfully delivered to Laravel webhook'
      );
      this.logEvent('webhook_dispatched', payload.sessionId, {
        url: webhookUrl,
        event: eventName,
        statusCode: response.status,
      });
    } catch (err: any) {
      sessionLog.error(
        {
          event: eventName,
          url: webhookUrl,
          error: err.message,
          stack: err.stack,
        },
        '[Webhook] Failed to deliver payload to webhook'
      );
      this.logEvent('webhook_failed', payload.sessionId, {
        url: webhookUrl,
        event: eventName,
        error: err.message,
      });
    }
  }

  /**
   * Sends an outbound text message with anti-ban composing simulation and randomized delay.
   * Lifecycle logging: Enqueued -> Presence sent -> Dispatched.
   */
  public async sendMessage(
    sessionId: string,
    jid: string,
    text: string
  ): Promise<{ messageId: string; timestamp: number }> {
    const sessionLog = createSessionLogger(sessionId);
    const sock = this.activeSockets.get(sessionId);
    const meta = this.metadataMap.get(sessionId);

    if (!sock || meta?.status !== 'connected') {
      sessionLog.warn({ status: meta?.status }, '[OutboundLifecycle] Dispatch rejected: Session is not connected');
      throw new Error(`Session '${sessionId}' is not active or connected to WhatsApp`);
    }

    // Normalize JID
    let targetJid = jid.trim();
    if (!targetJid.includes('@')) {
      targetJid = `${targetJid}@s.whatsapp.net`;
    }

    // Step 1: Log Enqueued
    sessionLog.info(
      { jid: targetJid, textPreview: text.slice(0, 80), step: 'enqueued' },
      '[OutboundLifecycle] Outbound text message enqueued for dispatch'
    );

    // Step 2: Anti-ban guardrail - send typing presence
    await sock.sendPresenceUpdate('composing', targetJid);
    const delay = Math.floor(Math.random() * (1400 - 600 + 1)) + 600;

    sessionLog.info(
      { jid: targetJid, presence: 'composing', delayMs: delay, step: 'presence_sent' },
      `[OutboundLifecycle] Simulating typing presence (throttling for ${delay}ms)...`
    );

    await new Promise((resolve) => setTimeout(resolve, delay));

    // Step 3: Clear presence 'paused'
    await sock.sendPresenceUpdate('paused', targetJid);

    // Step 4: Dispatch message via Baileys socket
    const sendResult = await sock.sendMessage(targetJid, { text });
    const messageId = sendResult?.key?.id || crypto.randomUUID();

    sessionLog.info(
      { jid: targetJid, messageId, delayMs: delay, step: 'dispatched' },
      '[OutboundLifecycle] Outbound text message successfully dispatched to WhatsApp socket'
    );

    this.logEvent('outbound_message', sessionId, {
      jid: targetJid,
      messageId,
      textPreview: text.slice(0, 80),
      simulatedDelayMs: delay,
    });

    return {
      messageId,
      timestamp: Date.now(),
    };
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

    // Fallback check in Redis
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
   * Queries `wa:session:*:creds`, extracts unique session IDs, and sequentially boots each socket.
   * A failure in one session recovery does not block or crash remaining sessions.
   */
  public async restoreAllSessions(): Promise<void> {
    try {
      const redis = await getRedisClient();
      logger.info('[SessionManager] Querying Redis for active sessions to auto-restore (pattern: wa:session:*:creds)...');

      let keys: string[] = [];
      try {
        keys = await redis.keys('wa:session:*:creds');
      } catch (err: any) {
        logger.warn({ err: err.message }, '[SessionManager] Failed to query Redis keys for auto-restore');
        return;
      }

      if (!keys || keys.length === 0) {
        logger.info('[SessionManager] No previous session credentials found in Redis for auto-restore.');
        return;
      }

      // Extract unique sessionIds
      const sessionIds = new Set<string>();
      for (const key of keys) {
        const match = key.match(/^wa:session:(.+):creds$/);
        if (match && match[1]) {
          sessionIds.add(match[1]);
        }
      }

      logger.info(
        { count: sessionIds.size, sessions: Array.from(sessionIds) },
        `[SessionManager] Found ${sessionIds.size} existing session(s). Sequentially auto-restoring in background...`
      );

      for (const sessionId of sessionIds) {
        const sessionLog = createSessionLogger(sessionId);
        try {
          sessionLog.info('[SessionManager] Auto-restoring session from persistent Redis credentials...');
          await this.initSession(sessionId);
          sessionLog.info('[SessionManager] Successfully auto-restored session from Redis');
        } catch (sessionErr: any) {
          sessionLog.error(
            { err: sessionErr.message, stack: sessionErr.stack },
            '[SessionManager] Failed to auto-restore session; skipping to next'
          );
        }
      }

      logger.info('[SessionManager] Session auto-restore sequence finished.');
    } catch (err: any) {
      logger.error({ err: err.message, stack: err.stack }, '[SessionManager] Error executing restoreAllSessions');
    }
  }

  /**
   * Requests an 8-character pairing code for phone number pairing (alternative to QR scanning).
   * Formats the pairing code with hyphen (e.g., ABCD-1234).
   */
  public async requestPairingCode(sessionId: string, phoneNumber: string): Promise<string> {
    const sessionLog = createSessionLogger(sessionId);
    let sock = this.activeSockets.get(sessionId);
    let meta = this.metadataMap.get(sessionId);

    // If socket not initialized yet, initialize it
    if (!sock || !meta) {
      meta = await this.initSession(sessionId);
      sock = this.activeSockets.get(sessionId);
    }

    if (!sock) {
      sessionLog.error({ phoneNumber }, '[PairingCode] Failed to initialize socket for pairing');
      throw new Error(`Failed to initialize session '${sessionId}' for pairing code`);
    }

    // Clean and validate phone number (digits only)
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    if (!cleanPhone || cleanPhone.length < 8) {
      sessionLog.warn({ rawPhone: phoneNumber, cleanPhone }, '[PairingCode] Invalid phone number provided');
      throw new Error('Invalid phone number. Must include country code and digits (e.g. 88017xxxxxxxx).');
    }

    // Verify session is not already registered
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

    // Format with hyphen: e.g. ABCD-1234
    const cleanCode = rawCode.replace(/[^A-Za-z0-9]/g, '');
    const formattedCode = cleanCode.length === 8
      ? `${cleanCode.slice(0, 4)}-${cleanCode.slice(4)}`
      : (rawCode.includes('-') ? rawCode : (rawCode.match(/.{1,4}/g)?.join('-') || rawCode));

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
   * Dispatches an outbound media message (image, audio, or document) with human presence simulation.
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
  ): Promise<{ messageId: string; timestamp: number }> {
    const sessionLog = createSessionLogger(sessionId);
    const sock = this.activeSockets.get(sessionId);
    const meta = this.metadataMap.get(sessionId);

    if (!sock || meta?.status !== 'connected') {
      sessionLog.warn({ type, jid, status: meta?.status }, '[OutboundMedia] Dispatch rejected: session is not connected');
      throw new Error(`Session '${sessionId}' is not active or connected to WhatsApp`);
    }

    // Normalize target JID
    let targetJid = jid.trim();
    if (!targetJid.includes('@')) {
      targetJid = `${targetJid}@s.whatsapp.net`;
    }

    sessionLog.info(
      {
        jid: targetJid,
        type,
        url,
        ptt: options?.ptt,
        step: 'enqueued',
      },
      `[OutboundMedia] Media message (${type}) enqueued for dispatch`
    );

    // Anti-ban simulation: composing or recording presence
    const presenceType = type === 'audio' && options?.ptt ? 'recording' : 'composing';
    await sock.sendPresenceUpdate(presenceType, targetJid);

    const delay = Math.floor(Math.random() * (1400 - 600 + 1)) + 600;
    sessionLog.info(
      { jid: targetJid, presence: presenceType, delayMs: delay, step: 'presence_sent' },
      `[OutboundMedia] Simulated ${presenceType} presence sent, throttling ${delay}ms...`
    );

    await new Promise((resolve) => setTimeout(resolve, delay));
    await sock.sendPresenceUpdate('paused', targetJid);

    // Build media payload for Baileys
    let messagePayload: any = {};
    if (type === 'image') {
      messagePayload = {
        image: { url },
        caption: options?.caption || undefined,
      };
    } else if (type === 'audio') {
      messagePayload = {
        audio: { url },
        ptt: !!options?.ptt,
        mimetype: options?.ptt ? 'audio/ogg; codecs=opus' : 'audio/mp4',
      };
    } else if (type === 'document') {
      messagePayload = {
        document: { url },
        fileName: options?.filename || 'document.pdf',
        caption: options?.caption || undefined,
      };
    } else {
      throw new Error(`Unsupported media type: ${type}`);
    }

    let sendResult: any;
    try {
      sendResult = await sock.sendMessage(targetJid, messagePayload);
    } catch (directErr: any) {
      // Fallback: fetch media buffer directly and dispatch with Buffer
      sessionLog.warn(
        { type, url, err: directErr.message },
        '[OutboundMedia] Direct URL dispatch failed; fetching media buffer as fallback'
      );
      const fetchRes = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!fetchRes.ok) {
        throw new Error(`Failed to fetch media from URL (${fetchRes.status}: ${fetchRes.statusText})`);
      }
      const arrayBuffer = await fetchRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const fallbackMime = fetchRes.headers.get('content-type') || undefined;

      const fallbackPayload = {
        ...messagePayload,
        [type]: buffer,
        ...(fallbackMime ? { mimetype: fallbackMime } : {}),
      };
      sendResult = await sock.sendMessage(targetJid, fallbackPayload);
    }

    const messageId = sendResult?.key?.id || crypto.randomUUID();

    sessionLog.info(
      { jid: targetJid, type, messageId, delayMs: delay, step: 'dispatched' },
      `[OutboundMedia] Media (${type}) dispatched successfully to WhatsApp socket`
    );

    this.logEvent('outbound_message', sessionId, {
      jid: targetJid,
      messageId,
      type,
      mediaUrl: url,
      caption: options?.caption,
      filename: options?.filename,
      ptt: options?.ptt,
      simulatedDelayMs: delay,
    });

    return {
      messageId,
      timestamp: Date.now(),
    };
  }

  /**
   * Gracefully closes all active WASocket connections without clearing Redis persistence keys.
   */
  public async closeAllSessions(): Promise<void> {
    const count = this.activeSockets.size;
    logger.info({ count }, '[SessionManager] Gracefully closing all active WASockets without purging Redis keys...');

    for (const [sessionId, sock] of this.activeSockets.entries()) {
      const sessionLog = createSessionLogger(sessionId);
      try {
        sock.end(undefined);
        sessionLog.info('[SessionManager] Active socket ended gracefully');
      } catch (err: any) {
        sessionLog.warn({ err: err.message }, '[SessionManager] Warning while closing socket');
      }
    }

    this.activeSockets.clear();
    logger.info('[SessionManager] All active sockets closed.');
  }

  /**
   * Disconnects a session socket, clears its local cache, and purges Redis auth state.
   * Ensures intentional termination flag blocks any automated reconnect race conditions.
   */
  public async deleteSession(sessionId: string): Promise<void> {
    const sessionLog = createSessionLogger(sessionId);

    // Step 1: Add sessionId to terminatingSessions
    this.terminatingSessions.add(sessionId);

    // Step 2: Remove the session from internal maps immediately
    const sock = this.activeSockets.get(sessionId);
    this.activeSockets.delete(sessionId);
    this.metadataMap.delete(sessionId);

    // Step 3: Call sock.ws.close() or sock.end(undefined)
    if (sock) {
      try {
        if ((sock as any).ws && typeof (sock as any).ws.close === 'function') {
          (sock as any).ws.close();
        }
        sock.end(undefined);
      } catch (err: any) {
        sessionLog.warn({ err: err.message }, '[SessionManager] Socket end warning during purge');
      }
    }

    // Step 4: Remove all Redis keys associated with this session
    try {
      const redis = await getRedisClient();
      let keys: string[] = [];
      try {
        keys = await redis.keys(`wa:session:${sessionId}:*`);
      } catch (keyErr: any) {
        sessionLog.warn({ err: keyErr.message }, '[SessionManager] Failed to query Redis keys during purge');
      }

      if (keys && keys.length > 0) {
        await redis.del(...keys);
        sessionLog.info({ count: keys.length }, '[SessionManager] Deleted Redis session keys via pattern');
      }

      // Extra safety: run clearRedisSession
      await clearRedisSession(redis, sessionId);
      sessionLog.info('[SessionManager] Tenant session permanently purged from Redis and memory');
    } catch (err: any) {
      sessionLog.error({ err: err.message, stack: err.stack }, '[SessionManager] Error clearing Redis on session delete');
    }

    // Step 5: After a short timeout, delete sessionId from terminatingSessions
    setTimeout(() => {
      this.terminatingSessions.delete(sessionId);
    }, 5000);

    this.logEvent('session_event', sessionId, { action: 'purged' });
  }

  /**
   * Alias for deleteSession
   */
  public async purgeSession(sessionId: string): Promise<void> {
    return this.deleteSession(sessionId);
  }
}

// Export singleton instance for the microservice
export const sessionManager = new SessionManager();

