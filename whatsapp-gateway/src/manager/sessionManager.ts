import crypto from 'crypto';
import { Boom } from '@hapi/boom';
import makeWASocket, {
  DisconnectReason,
  proto,
  WASocket,
} from '@whiskeysockets/baileys';
import { clearRedisSession, useRedisAuthState } from '../auth/redisAuthState.js';
import { config, getRedisClient, logger } from '../config.js';
import type {
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

          logger.warn(
            { sessionId, statusCode, isLoggedOut, error: lastDisconnect?.error?.message },
            '[SessionManager] WhatsApp connection closed'
          );

          // DisconnectReason.loggedOut (401): clean up socket and purge keys from Redis
          if (isLoggedOut) {
            meta.status = 'logged_out';
            meta.qr = null;
            meta.user = null;
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

          const payload: WebhookInboundPayload = {
            sessionId,
            message: {
              key: msg.key,
              pushName: msg.pushName || null,
              text: extractedText,
              raw: msg,
            },
          };

          this.logEvent('inbound_message', sessionId, {
            from: msg.key.remoteJid,
            pushName: msg.pushName,
            text: extractedText,
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
