import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Boom } from '@hapi/boom';
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  proto,
  WASocket,
} from '@whiskeysockets/baileys';
import { clearRedisSession, useRedisAuthState } from '../auth/redisAuthState.js';
import { config, getPublicBaseUrl, getRedisClient, logger } from '../config.js';
import type {
  InboundMediaMetadata,
  SessionMetadata,
  SessionStatus,
  SessionSummary,
  WebhookInboundPayload,
} from '../types/index.js';

export interface RecentEvent {
  id: string;
  timestamp: number;
  type: 'inbound_message' | 'outbound_message' | 'webhook_dispatched' | 'webhook_failed' | 'session_event';
  sessionId: string;
  details: Record<string, any>;
}

/**
 * Multi-Tenant Session Manager for Botla WhatsApp Gateway.
 * Manages the lifecycle of Baileys WASocket instances, Redis persistence,
 * QR code streaming, anti-ban outbound rate limiting, and webhook dispatches.
 */
export class SessionManager {
  private activeSockets: Map<string, WASocket> = new Map();
  private metadataMap: Map<string, SessionMetadata> = new Map();
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
    const existingSocket = this.activeSockets.get(sessionId);
    const existingMeta = this.metadataMap.get(sessionId);

    // If session is already connected or actively connecting, return its state
    if (existingSocket && existingMeta && (existingMeta.status === 'connected' || existingMeta.status === 'connecting')) {
      logger.info({ sessionId, status: existingMeta.status }, '[SessionManager] Session already initialized');
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

    try {
      // Step A: Initialize Custom Redis Auth State
      const { state, saveCreds } = await useRedisAuthState(redis, sessionId);

      // Create pino sublogger for Baileys with minimal noise
      const baileysLogger = logger.child({ module: 'baileys', sessionId });
      baileysLogger.level = 'warn';

      // Step B: Create WASocket instance
      const sock = makeWASocket({
        auth: state,
        logger: baileysLogger,
        printQRInTerminal: false,
        browser: ['Botla WhatsApp Gateway', 'Chrome', '124.0.0.0'],
        syncFullHistory: false,
        generateHighQualityLinkPreview: true,
      });

      this.activeSockets.set(sessionId, sock);

      // Step C: Listen for credentials update
      sock.ev.on('creds.update', async () => {
        try {
          await saveCreds();
          logger.debug({ sessionId }, '[SessionManager] Credentials persisted to Redis');
        } catch (err: any) {
          logger.error({ sessionId, err: err.message }, '[SessionManager] Failed to save creds to Redis');
        }
      });

      // Step D: Listen for connection updates (QR, open, close)
      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        meta.lastActiveAt = Date.now();

        // 1. Capture and cache raw QR strings
        if (qr) {
          meta.qr = qr;
          meta.qrUpdatedAt = Date.now();
          meta.status = 'qr_ready';
          logger.info({ sessionId }, '[SessionManager] New QR Code generated for session');

          // Cache QR in Redis with 60-second TTL
          try {
            await redis.set(`wa:session:${sessionId}:qr`, qr, 'EX', 60);
          } catch (err: any) {
            logger.warn({ sessionId, err: err.message }, '[Redis] Failed to cache QR string in Redis');
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

          logger.info(
            { sessionId, user: meta.user },
            '[SessionManager] WhatsApp connection successfully established (open)'
          );
          this.logEvent('session_event', sessionId, {
            action: 'connected',
            user: meta.user,
          });
        }

        // 3. Connection closed / disconnected
        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;
          const errorMessage = lastDisconnect?.error?.message || '';
          const isQrExpired =
            errorMessage.includes('QR refs attempts ended') ||
            (!meta.user && (statusCode === DisconnectReason.timedOut || statusCode === 408) && (meta.status === 'qr_ready' || meta.status === 'connecting'));
          const isRestartRequired = statusCode === DisconnectReason.restartRequired;

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

            logger.info(
              { sessionId, statusCode },
              '[SessionManager] QR code pairing expired (no scan received before timeout). Ready for re-init.'
            );

            this.logEvent('session_event', sessionId, {
              action: 'qr_expired',
              statusCode,
            });
            return;
          }

          logger.warn(
            { sessionId, statusCode, isLoggedOut, error: errorMessage },
            '[SessionManager] WhatsApp connection closed'
          );

          // DisconnectReason.loggedOut (401): clean up socket and purge keys from Redis
          if (isLoggedOut) {
            meta.status = 'logged_out';
            meta.qr = null;
            meta.user = null;
            meta.reconnectAttempts = 0;
            this.activeSockets.delete(sessionId);

            try {
              const purgedCount = await clearRedisSession(redis, sessionId);
              logger.info({ sessionId, purgedCount }, '[SessionManager] Purged logged out session keys from Redis');
            } catch (purgeErr: any) {
              logger.error({ sessionId, err: purgeErr.message }, '[SessionManager] Error purging Redis session');
            }

            this.logEvent('session_event', sessionId, {
              action: 'logged_out',
              statusCode,
            });
          } else if (isRestartRequired) {
            // Immediate restart required by Baileys internal state sync
            logger.info({ sessionId }, '[SessionManager] Restart required by Baileys, reconnecting immediately');
            this.activeSockets.delete(sessionId);
            setTimeout(() => {
              this.initSession(sessionId).catch((reconnErr) => {
                logger.error({ sessionId, err: reconnErr.message }, '[SessionManager] Restart reconnection failed');
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
            });

            // Reconnection guardrail with exponential delay (up to 5 attempts)
            if (meta.reconnectAttempts < 5) {
              meta.reconnectAttempts++;
              const delay = Math.min(meta.reconnectAttempts * 1500, 6000);
              logger.info(
                { sessionId, attempt: meta.reconnectAttempts, delayMs: delay },
                '[SessionManager] Scheduling auto-reconnection'
              );

              setTimeout(() => {
                this.initSession(sessionId).catch((reconnErr) => {
                  logger.error({ sessionId, err: reconnErr.message }, '[SessionManager] Auto-reconnection failed');
                });
              }, delay);
            } else {
              logger.error({ sessionId }, '[SessionManager] Exceeded maximum auto-reconnect attempts');
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

                logger.info(
                  {
                    sessionId,
                    messageId,
                    type: mediaInfo.type,
                    fileSize: buffer.length,
                    url: mediaAccessUrl,
                  },
                  '[SessionManager] Inbound media extracted, stored and URL generated'
                );
              }
            } catch (mediaErr: any) {
              logger.error(
                { sessionId, err: mediaErr.message, type: mediaInfo.type },
                '[SessionManager] Failed to download inbound media attachment'
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
            logger.error({ sessionId, err: webhookErr.message }, '[SessionManager] Webhook delivery failed');
          });
        }
      });

      return meta;
    } catch (err: any) {
      meta.status = 'disconnected';
      logger.error({ sessionId, err: err.message }, '[SessionManager] Failed to initialize session');
      throw err;
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
   * Asynchronously posts an inbound WhatsApp message payload to Botla's Laravel webhook.
   * Signs the payload using HMAC-SHA256 if WEBHOOK_SECRET is set.
   */
  public async dispatchWebhook(payload: WebhookInboundPayload): Promise<void> {
    const webhookUrl = config.botlaWebhookUrl;
    if (!webhookUrl) {
      logger.warn('[Webhook] No BOTLA_WEBHOOK_URL configured; skipping dispatch');
      return;
    }

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

      logger.info(
        { sessionId: payload.sessionId, url: webhookUrl, status: response.status },
        '[Webhook] Dispatched inbound message to Laravel webhook'
      );
      this.logEvent('webhook_dispatched', payload.sessionId, {
        url: webhookUrl,
        statusCode: response.status,
      });
    } catch (err: any) {
      logger.error(
        { sessionId: payload.sessionId, url: webhookUrl, error: err.message },
        '[Webhook] Failed to deliver payload to webhook'
      );
      this.logEvent('webhook_failed', payload.sessionId, {
        url: webhookUrl,
        error: err.message,
      });
    }
  }

  /**
   * Sends an outbound text message with anti-ban composing simulation and randomized delay.
   */
  public async sendMessage(
    sessionId: string,
    jid: string,
    text: string
  ): Promise<{ messageId: string; timestamp: number }> {
    const sock = this.activeSockets.get(sessionId);
    const meta = this.metadataMap.get(sessionId);

    if (!sock || meta?.status !== 'connected') {
      throw new Error(`Session '${sessionId}' is not active or connected to WhatsApp`);
    }

    // Normalize JID
    let targetJid = jid.trim();
    if (!targetJid.includes('@')) {
      targetJid = `${targetJid}@s.whatsapp.net`;
    }

    // Anti-ban guardrail requirement:
    // 1. Trigger presence 'composing'
    await sock.sendPresenceUpdate('composing', targetJid);

    // 2. Randomized delay (600ms - 1400ms)
    const delay = Math.floor(Math.random() * (1400 - 600 + 1)) + 600;
    await new Promise((resolve) => setTimeout(resolve, delay));

    // 3. Clear presence 'paused'
    await sock.sendPresenceUpdate('paused', targetJid);

    // 4. Send message
    const sendResult = await sock.sendMessage(targetJid, { text });
    const messageId = sendResult?.key?.id || crypto.randomUUID();

    logger.info(
      { sessionId, jid: targetJid, messageId, delayMs: delay },
      '[SessionManager] Message dispatched successfully'
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
    return this.metadataMap.get(sessionId) || null;
  }

  /**
   * Lists all sessions tracked by the manager.
   */
  public listSessions(): SessionSummary[] {
    return Array.from(this.metadataMap.values()).map((m) => ({
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
        try {
          logger.info({ sessionId }, '[SessionManager] Auto-restoring session...');
          await this.initSession(sessionId);
          logger.info({ sessionId }, '[SessionManager] Successfully auto-restored session');
        } catch (sessionErr: any) {
          logger.error(
            { sessionId, err: sessionErr.message },
            '[SessionManager] Failed to auto-restore session; skipping to next'
          );
        }
      }

      logger.info('[SessionManager] Session auto-restore sequence finished.');
    } catch (err: any) {
      logger.error({ err: err.message }, '[SessionManager] Error executing restoreAllSessions');
    }
  }

  /**
   * Requests an 8-character pairing code for phone number pairing (alternative to QR scanning).
   * Formats the pairing code with hyphen (e.g., ABCD-1234).
   */
  public async requestPairingCode(sessionId: string, phoneNumber: string): Promise<string> {
    let sock = this.activeSockets.get(sessionId);
    let meta = this.metadataMap.get(sessionId);

    // If socket not initialized yet, initialize it
    if (!sock || !meta) {
      meta = await this.initSession(sessionId);
      sock = this.activeSockets.get(sessionId);
    }

    if (!sock) {
      throw new Error(`Failed to initialize session '${sessionId}' for pairing code`);
    }

    // Clean and validate phone number (digits only)
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    if (!cleanPhone || cleanPhone.length < 8) {
      throw new Error('Invalid phone number. Must include country code and digits (e.g. 88017xxxxxxxx).');
    }

    // Verify session is not already registered
    if (sock.authState?.creds?.registered) {
      throw new Error(`Session '${sessionId}' is already registered and authenticated.`);
    }

    logger.info({ sessionId, phoneNumber: cleanPhone }, '[SessionManager] Requesting pairing code from WhatsApp...');
    const rawCode = await sock.requestPairingCode(cleanPhone);

    if (!rawCode) {
      throw new Error('WhatsApp did not return a pairing code. Please retry.');
    }

    // Format with hyphen: e.g. ABCD-1234
    const cleanCode = rawCode.replace(/[^A-Za-z0-9]/g, '');
    const formattedCode = cleanCode.length === 8
      ? `${cleanCode.slice(0, 4)}-${cleanCode.slice(4)}`
      : (rawCode.includes('-') ? rawCode : (rawCode.match(/.{1,4}/g)?.join('-') || rawCode));

    logger.info({ sessionId, code: formattedCode }, '[SessionManager] Pairing code generated successfully');

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
    const sock = this.activeSockets.get(sessionId);
    const meta = this.metadataMap.get(sessionId);

    if (!sock || meta?.status !== 'connected') {
      throw new Error(`Session '${sessionId}' is not active or connected to WhatsApp`);
    }

    // Normalize target JID
    let targetJid = jid.trim();
    if (!targetJid.includes('@')) {
      targetJid = `${targetJid}@s.whatsapp.net`;
    }

    // Anti-ban simulation: composing or recording presence
    const presenceType = type === 'audio' && options?.ptt ? 'recording' : 'composing';
    await sock.sendPresenceUpdate(presenceType, targetJid);

    const delay = Math.floor(Math.random() * (1400 - 600 + 1)) + 600;
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
      logger.warn(
        { sessionId, type, url, err: directErr.message },
        '[SessionManager] Direct URL dispatch failed; fetching media buffer as fallback'
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

    logger.info(
      { sessionId, jid: targetJid, type, messageId, delayMs: delay },
      '[SessionManager] Outbound media dispatched successfully'
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
      try {
        sock.end(undefined);
      } catch (err: any) {
        logger.warn({ sessionId, err: err.message }, '[SessionManager] Warning while closing socket');
      }
    }

    this.activeSockets.clear();
    logger.info('[SessionManager] All active sockets closed.');
  }

  /**
   * Disconnects a session socket, clears its local cache, and purges Redis auth state.
   */
  public async deleteSession(sessionId: string): Promise<void> {
    const sock = this.activeSockets.get(sessionId);

    if (sock) {
      try {
        sock.end(undefined);
      } catch (err: any) {
        logger.warn({ sessionId, err: err.message }, '[SessionManager] Socket end warning');
      }
      this.activeSockets.delete(sessionId);
    }

    this.metadataMap.delete(sessionId);

    // Purge Redis keys
    try {
      const redis = await getRedisClient();
      await clearRedisSession(redis, sessionId);
      logger.info({ sessionId }, '[SessionManager] Tenant session purged from Redis and memory');
    } catch (err: any) {
      logger.error({ sessionId, err: err.message }, '[SessionManager] Error clearing Redis on session delete');
    }

    this.logEvent('session_event', sessionId, { action: 'deleted' });
  }
}

// Export singleton instance for the microservice
export const sessionManager = new SessionManager();
