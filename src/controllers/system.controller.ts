/**
 * System Operations Controller
 * Handles health telemetry, media retention cleanup & SSE log streaming.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config, getPublicBaseUrl } from '../config/env.js';
import { isUsingMockRedis } from '../config/redis.js';
import { MediaService } from '../services/media.service.js';
import { sessionService } from '../services/session.service.js';
import { getRecentLogs, logger, subscribeLogStream } from '../utils/logger.js';
import { ResponseUtil } from '../utils/response.util.js';
import { getCachedWhatsAppVersion } from '../utils/versionGuard.js';
import type { StreamLogEvent } from '../types/index.js';

export class SystemController {
  /**
   * GET /api/health
   */
  public static async getHealth(
    _request: FastifyRequest,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const cachedVersion = getCachedWhatsAppVersion();
    return ResponseUtil.success(
      reply,
      {
        status: 'ok',
        service: 'whatsapp-gateway',
        version: '1.0.0',
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        publicBaseUrl: getPublicBaseUrl(),
        redis: isUsingMockRedis() ? 'in-memory-fallback' : 'connected-redis',
        webhookUrl: config.webhookUrl,
        webhookEnabled: config.webhookEnabled,
        activeSessions: sessionService.listSessions().length,
        protocolVersion: cachedVersion ? cachedVersion.version.join('.') : 'synced-on-demand',
        isLatestProtocol: cachedVersion ? cachedVersion.isLatest : true,
        mediaRetentionHours: config.mediaRetentionHours,
        mediaCleanupIntervalHours: config.mediaCleanupIntervalHours,
      },
      200
    );
  }

  /**
   * POST /api/media/cleanup
   */
  public static async cleanupMedia(
    request: FastifyRequest<{ Body: { retentionHours?: number } }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    try {
      const retentionHours = request.body?.retentionHours;
      const result = await MediaService.cleanStorage(retentionHours);
      return reply.status(200).send(result);
    } catch (err: any) {
      request.log.error({ err: err.message }, 'Failed to execute media cleanup');
      return ResponseUtil.error(
        reply,
        'Failed to execute media cleanup',
        500,
        'MEDIA_CLEANUP_FAILED',
        err.message,
        {
          deletedFilesCount: 0,
          prunedDirsCount: 0,
          freedBytes: 0,
          freedBytesFormatted: '0 B',
          retentionHours: 48,
          timestamp: new Date().toISOString(),
        }
      );
    }
  }

  /**
   * GET /api/logs/stream
   * Streams structured logs, errors, disconnections, and outbound lifecycle in real-time via SSE.
   */
  public static async streamLogs(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const rawRes = reply.raw;

    rawRes.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });

    rawRes.write(
      `data: ${JSON.stringify({
        id: 'conn-' + Date.now(),
        timestamp: new Date().toISOString(),
        level: 'info',
        message: '⚡ Real-time Gateway Log Stream connected',
        meta: { transport: 'SSE', pid: process.pid },
      })}\n\n`
    );

    const history = getRecentLogs(40).reverse();
    for (const logItem of history) {
      rawRes.write(`data: ${JSON.stringify(logItem)}\n\n`);
    }

    const unsubscribe = subscribeLogStream((logEvent: StreamLogEvent) => {
      try {
        rawRes.write(`data: ${JSON.stringify(logEvent)}\n\n`);
      } catch {
        // Stream may have closed
      }
    });

    const heartbeatTimer = setInterval(() => {
      try {
        rawRes.write(': heartbeat\n\n');
      } catch {
        clearInterval(heartbeatTimer);
      }
    }, 15000);

    request.raw.on('close', () => {
      unsubscribe();
      clearInterval(heartbeatTimer);
    });

    reply.hijack();
  }

  /**
   * GET /api/logs
   */
  public static async getLogs(
    request: FastifyRequest<{
      Querystring: {
        limit?: number;
        level?: string;
        sessionId?: string;
      };
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
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

    return ResponseUtil.success(
      reply,
      {
        count: logs.length,
        logs,
      },
      200
    );
  }

  /**
   * POST /api/webhook/mock
   */
  public static async mockWebhook(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const signature =
      request.headers['x-gateway-signature-256'] ||
      request.headers['x-hub-signature-256'] ||
      request.headers['x-botla-signature'];
    logger.info({ signature, body: request.body }, '[MockWebhook] Received webhook payload');
    return ResponseUtil.success(
      reply,
      { received: true, signatureMatched: !!signature },
      200
    );
  }
}
