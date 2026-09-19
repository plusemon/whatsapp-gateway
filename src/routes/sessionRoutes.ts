import fs from 'fs';
import path from 'path';
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import QRCode from 'qrcode';
import { getRedisClient } from '../config.js';
import { sessionManager } from '../manager/sessionManager.js';
import { cleanLogStorage, cleanMediaStorage, formatBytes } from '../utils/cleanup.js';
import { getRecentLogs, subscribeLogStream } from '../utils/logger.js';
import { getCachedWhatsAppVersion, getWhatsAppVersion } from '../utils/versionGuard.js';
import type {
  ApiDeleteResponse,
  ApiInitResponse,
  ApiPairCodeResponse,
  ApiQrResponse,
  ApiSendMediaResponse,
  ApiSendResponse,
  LogCleanupResult,
  MediaCleanupResult,
  PairCodeBody,
  SendMediaBody,
  SendMessageBody,
  SessionParams,
  StreamLogEvent,
} from '../types/index.js';

/**
 * Fastify routes plugin exposing REST APIs for managing multi-tenant WhatsApp sessions.
 */
export const sessionRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  /**
   * 1. POST /api/sessions/:id/init
   * Initializes / boots the WhatsApp Baileys socket session.
   */
  fastify.post<{ Params: SessionParams; Reply: ApiInitResponse }>(
    '/sessions/:id/init',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              sessionId: { type: 'string' },
              status: { type: 'string' },
              message: { type: 'string' },
              qr: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      try {
        const sessionMeta = await sessionManager.initSession(id);
        return reply.status(200).send({
          success: true,
          sessionId: id,
          status: sessionMeta.status,
          message:
            sessionMeta.status === 'connected'
              ? 'Session is already connected'
              : 'Session socket initialized; waiting for QR scan or connection',
          qr: sessionMeta.qr,
        });
      } catch (err: any) {
        request.log.error({ sessionId: id, err: err.message }, 'Failed to initialize session');
        return reply.status(500).send({
          success: false,
          sessionId: id,
          status: 'disconnected',
          message: `Failed to initialize session: ${err.message}`,
          qr: null,
        });
      }
    }
  );

  /**
   * 2. GET /api/sessions/:id/qr
   * Returns current raw QR string (or null if connected/waiting).
   * Also optionally returns a rendered base64 data URL for easy viewing.
   */
  fastify.get<{
    Params: SessionParams;
    Querystring: { format?: string };
    Reply: ApiQrResponse;
  }>(
    '/sessions/:id/qr',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1 },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: ['raw', 'image', 'json'] },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              sessionId: { type: 'string' },
              qr: { type: ['string', 'null'] },
              status: { type: 'string' },
              qrDataUrl: { type: ['string', 'null'] },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const meta = sessionManager.getSession(id);
      const rawQr = await sessionManager.getQR(id);

      if (!meta && !rawQr) {
        return reply.status(404).send({
          sessionId: id,
          qr: null,
          status: 'disconnected',
          message: `Session '${id}' does not exist. Call POST /api/sessions/${id}/init first.`,
        });
      }

      let qrDataUrl: string | null = null;
      if (rawQr) {
        try {
          qrDataUrl = await QRCode.toDataURL(rawQr, { margin: 2, scale: 6 });
        } catch {
          // Ignore QR render error
        }
      }

      let message = 'Waiting for QR generation or device connection...';
      if (meta?.status === 'connected') {
        message = 'Device is already authenticated & connected';
      } else if (meta?.status === 'qr_expired') {
        message = 'QR code pairing timed out without being scanned. Re-initialize session to generate a new QR code.';
      } else if (rawQr) {
        message = 'Scan this QR code with WhatsApp';
      }

      return reply.status(200).send({
        sessionId: id,
        qr: rawQr,
        status: meta?.status || (rawQr ? 'qr_ready' : 'idle'),
        qrDataUrl,
        message,
      });
    }
  );

  /**
   * 3. POST /api/sessions/:id/send
   * Dispatches outbound message via the tenant's socket with anti-ban guardrails.
   */
  fastify.post<{
    Params: SessionParams;
    Body: SendMessageBody;
    Reply: ApiSendResponse;
  }>(
    '/sessions/:id/send',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1 },
          },
        },
        body: {
          type: 'object',
          required: ['jid', 'text'],
          properties: {
            jid: { type: 'string', minLength: 3 },
            text: { type: 'string', minLength: 1 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              sessionId: { type: 'string' },
              jid: { type: 'string' },
              messageId: { type: 'string' },
              timestamp: { type: 'number' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { jid, text } = request.body;

      try {
        const result = await sessionManager.sendMessage(id, jid, text);
        return reply.status(200).send({
          success: true,
          sessionId: id,
          jid,
          messageId: result.messageId,
          timestamp: result.timestamp,
        });
      } catch (err: any) {
        request.log.error({ sessionId: id, jid, err: err.message }, 'Failed to send message');
        return reply.status(400).send({
          success: false,
          sessionId: id,
          jid,
          messageId: '',
          timestamp: Date.now(),
        });
      }
    }
  );

  /**
   * 3b. POST /api/sessions/:id/pair-code
   * Alternative to QR code: generates an 8-character pairing code for phone number pairing.
   */
  fastify.post<{
    Params: SessionParams;
    Body: PairCodeBody;
    Reply: ApiPairCodeResponse;
  }>(
    '/sessions/:id/pair-code',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1 },
          },
        },
        body: {
          type: 'object',
          required: ['phoneNumber'],
          properties: {
            phoneNumber: { type: 'string', minLength: 6 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              sessionId: { type: 'string' },
              code: { type: ['string', 'null'] },
              message: { type: 'string' },
            },
          },
          400: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              sessionId: { type: 'string' },
              code: { type: ['string', 'null'] },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { phoneNumber } = request.body;

      try {
        const formattedCode = await sessionManager.requestPairingCode(id, phoneNumber);
        return reply.status(200).send({
          success: true,
          sessionId: id,
          code: formattedCode,
          message: 'Pairing code generated. Enter this code in WhatsApp > Linked Devices > Link with phone number.',
        });
      } catch (err: any) {
        request.log.error({ sessionId: id, phoneNumber, err: err.message }, 'Failed to generate pairing code');
        return reply.status(400).send({
          success: false,
          sessionId: id,
          code: null,
          message: err.message || 'Failed to request pairing code',
        });
      }
    }
  );

  /**
   * 3c. POST /api/sessions/:id/send-media
   * Dispatches outbound media (image, audio, document) with presence simulation.
   */
  fastify.post<{
    Params: SessionParams;
    Body: SendMediaBody;
    Reply: ApiSendMediaResponse;
  }>(
    '/sessions/:id/send-media',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1 },
          },
        },
        body: {
          type: 'object',
          required: ['jid', 'type', 'url'],
          properties: {
            jid: { type: 'string', minLength: 3 },
            type: { type: 'string', enum: ['image', 'audio', 'document'] },
            url: { type: 'string', minLength: 4 },
            caption: { type: 'string' },
            filename: { type: 'string' },
            ptt: { type: 'boolean' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              sessionId: { type: 'string' },
              jid: { type: 'string' },
              type: { type: 'string' },
              messageId: { type: 'string' },
              timestamp: { type: 'number' },
            },
          },
          400: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              sessionId: { type: 'string' },
              jid: { type: 'string' },
              type: { type: 'string' },
              messageId: { type: 'string' },
              timestamp: { type: 'number' },
              error: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { jid, type, url, caption, filename, ptt } = request.body;

      try {
        const result = await sessionManager.sendMedia(id, jid, type, url, {
          caption,
          filename,
          ptt,
        });

        return reply.status(200).send({
          success: true,
          sessionId: id,
          jid,
          type,
          messageId: result.messageId,
          timestamp: result.timestamp,
        });
      } catch (err: any) {
        request.log.error(
          { sessionId: id, jid, type, url, err: err.message },
          'Failed to send outbound media'
        );
        return reply.status(400).send({
          success: false,
          sessionId: id,
          jid,
          type,
          messageId: '',
          timestamp: Date.now(),
          error: err.message || 'Failed to dispatch outbound media message',
        });
      }
    }
  );

  /**
   * 4. DELETE /api/sessions/:id
   * 4b. POST /api/sessions/:id/purge (Fallback)
   * Disconnects socket and purges tenant session state from Redis.
   */
  const handlePurgeSession = async (
    request: { params: SessionParams; log: any },
    reply: any
  ) => {
    const { id } = request.params;

    try {
      await sessionManager.deleteSession(id);
      return reply.status(200).send({
        success: true,
        sessionId: id,
        message: 'Session purged successfully',
      });
    } catch (err: any) {
      request.log.error({ sessionId: id, err: err.message }, 'Failed to purge session');
      return reply.status(500).send({
        success: false,
        sessionId: id,
        message: `Error purging session '${id}': ${err.message}`,
      });
    }
  };

  fastify.delete<{ Params: SessionParams; Reply: ApiDeleteResponse }>(
    '/sessions/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              sessionId: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    handlePurgeSession
  );

  fastify.post<{ Params: SessionParams; Reply: ApiDeleteResponse }>(
    '/sessions/:id/purge',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              sessionId: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    handlePurgeSession
  );

  /**
   * Helper: GET /api/sessions
   * Lists all active or registered sessions.
   */
  fastify.get('/sessions', async () => {
    const sessions = sessionManager.listSessions();
    return {
      count: sessions.length,
      sessions,
    };
  });

  /**
   * Helper: GET /api/sessions/:id/status
   */
  fastify.get<{ Params: SessionParams }>('/sessions/:id/status', async (request, reply) => {
    const { id } = request.params;
    const session = sessionManager.getSession(id);
    if (!session) {
      return reply.status(404).send({
        success: false,
        message: `Session '${id}' not found`,
      });
    }
    return {
      success: true,
      session,
    };
  });

  /**
   * Helper: GET /api/events
   * Returns recent gateway events (inbound, outbound, webhooks, lifecycle).
   */
  fastify.get('/events', async () => {
    return {
      events: sessionManager.getRecentEvents(),
    };
  });

  /**
   * Trigger manual or administrative media storage retention cleanup.
   * POST /api/media/cleanup
   */
  fastify.post<{
    Body: { retentionHours?: number };
    Reply: MediaCleanupResult;
  }>('/media/cleanup', async (request, reply) => {
    try {
      const retentionHours = request.body?.retentionHours;
      const result = await cleanMediaStorage(retentionHours);
      return reply.status(200).send(result);
    } catch (err: any) {
      request.log.error({ err: err.message }, 'Failed to execute media cleanup');
      return reply.status(500).send({
        success: false,
        deletedFilesCount: 0,
        prunedDirsCount: 0,
        freedBytes: 0,
        freedBytesFormatted: '0 B',
        retentionHours: 48,
        timestamp: new Date().toISOString(),
      });
    }
  });

  /**
   * WhatsApp Web Protocol Version Check & Guard
   * GET /api/system/version
   */
  fastify.get('/system/version', async (request, reply) => {
    try {
      const redis = await getRedisClient();
      const versionInfo = await getWhatsAppVersion(redis);
      return reply.status(200).send({
        success: true,
        protocolVersion: versionInfo.version.join('.'),
        versionTuple: versionInfo.version,
        isLatest: versionInfo.isLatest,
        source: versionInfo.source,
        fetchedAt: new Date(versionInfo.fetchedAt).toISOString(),
      });
    } catch (err: any) {
      request.log.error({ err: err.message }, 'Failed to retrieve WhatsApp protocol version');
      const cached = getCachedWhatsAppVersion();
      return reply.status(200).send({
        success: true,
        protocolVersion: cached ? cached.version.join('.') : '2.3000.1015901307',
        versionTuple: cached ? cached.version : [2, 3000, 1015901307],
        isLatest: cached ? cached.isLatest : true,
        source: 'fallback',
        fetchedAt: new Date().toISOString(),
      });
    }
  });

  /**
   * Real-Time Server-Sent Events (SSE) Log Stream
   * GET /api/logs/stream
   *
   * Streams structured logs, errors, disconnections, and outbound lifecycle in real-time.
   */
  fastify.get('/logs/stream', async (request, reply) => {
    // Hijack the raw Node.js HTTP response for low-latency SSE streaming
    const rawRes = reply.raw;

    rawRes.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });

    // Send connected handshake message
    rawRes.write(
      `data: ${JSON.stringify({
        id: 'conn-' + Date.now(),
        timestamp: new Date().toISOString(),
        level: 'info',
        message: '⚡ Real-time Gateway Log Stream connected',
        meta: { transport: 'SSE', pid: process.pid },
      })}\n\n`
    );

    // Hydrate initial recent log history (up to 40 items)
    const history = getRecentLogs(40).reverse();
    for (const logItem of history) {
      rawRes.write(`data: ${JSON.stringify(logItem)}\n\n`);
    }

    // Subscribe to live log emissions
    const unsubscribe = subscribeLogStream((logEvent: StreamLogEvent) => {
      try {
        rawRes.write(`data: ${JSON.stringify(logEvent)}\n\n`);
      } catch {
        // Stream may have closed
      }
    });

    // Keep-alive heartbeat interval every 15 seconds
    const heartbeatTimer = setInterval(() => {
      try {
        rawRes.write(': heartbeat\n\n');
      } catch {
        clearInterval(heartbeatTimer);
      }
    }, 15000);

    // Clean up on client disconnect
    request.raw.on('close', () => {
      unsubscribe();
      clearInterval(heartbeatTimer);
    });

    // Fastify needs to know not to send its standard response
    reply.hijack();
  });

  /**
   * Query Recent Logs via REST
   * GET /api/logs
   */
  fastify.get<{
    Querystring: {
      limit?: number;
      level?: string;
      sessionId?: string;
    };
  }>('/logs', async (request, reply) => {
    const limit = Math.min(request.query.limit ? Number(request.query.limit) : 100, 250);
    const targetLevel = request.query.level?.toLowerCase();
    const targetSession = request.query.sessionId?.trim();

    let logs = getRecentLogs(limit);

    if (targetLevel) {
      logs = logs.filter((l) => l.level.toLowerCase() === targetLevel);
    }
    if (targetSession) {
      logs = logs.filter((l) => l.sessionId === targetSession);
    }

    return reply.status(200).send({
      count: logs.length,
      logs,
    });
  });

  /**
   * Trigger Manual or Administrative Log Storage Retention Cleanup
   * POST /api/logs/cleanup
   */
  fastify.post<{
    Body: { retentionDays?: number };
    Reply: LogCleanupResult;
  }>('/logs/cleanup', async (request, reply) => {
    try {
      const retentionDays = request.body?.retentionDays;
      const result = await cleanLogStorage(retentionDays);
      return reply.status(200).send(result);
    } catch (err: any) {
      request.log.error({ err: err.message }, 'Failed to execute log storage retention cleanup');
      return reply.status(500).send({
        success: false,
        deletedFilesCount: 0,
        freedBytes: 0,
        freedBytesFormatted: '0 B',
        retentionDays: 14,
        timestamp: new Date().toISOString(),
      });
    }
  });

  /**
   * Inspect Log Files on Disk
   * GET /api/logs/files
   */
  fastify.get('/logs/files', async (request, reply) => {
    try {
      const logsDir = path.resolve(process.cwd(), 'storage/logs');
      if (!fs.existsSync(logsDir)) {
        return reply.status(200).send({ files: [], totalSizeBytes: 0, totalSizeFormatted: '0 B' });
      }

      const fileNames = await fs.promises.readdir(logsDir);
      let totalBytes = 0;
      const filesInfo = [];

      for (const name of fileNames) {
        const filePath = path.join(logsDir, name);
        try {
          const stat = await fs.promises.stat(filePath);
          if (stat.isFile()) {
            totalBytes += stat.size;
            filesInfo.push({
              name,
              sizeBytes: stat.size,
              sizeFormatted: formatBytes(stat.size),
              modifiedAt: new Date(stat.mtimeMs).toISOString(),
              ageDays: Math.floor((Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24)),
            });
          }
        } catch {
          // Ignore file stat failure
        }
      }

      // Sort with combined.log and error.log first, then newest
      filesInfo.sort((a, b) => {
        if (a.name === 'combined.log') return -1;
        if (b.name === 'combined.log') return 1;
        if (a.name === 'error.log') return -1;
        if (b.name === 'error.log') return 1;
        return b.name.localeCompare(a.name);
      });

      return reply.status(200).send({
        files: filesInfo,
        totalSizeBytes: totalBytes,
        totalSizeFormatted: formatBytes(totalBytes),
        directory: 'storage/logs',
      });
    } catch (err: any) {
      request.log.error({ err: err.message }, 'Failed to inspect log directory');
      return reply.status(500).send({ error: err.message });
    }
  });
};
