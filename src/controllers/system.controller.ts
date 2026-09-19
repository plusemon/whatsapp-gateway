/**
 * System Operations Controller
 * Handles health telemetry, storage retention cleanup, log inspection & SSE streaming.
 */
import fs from 'fs';
import path from 'path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config, getPublicBaseUrl } from '../config/env.js';
import { isUsingMockRedis } from '../config/redis.js';
import { MediaService } from '../services/media.service.js';
import { sessionService } from '../services/session.service.js';
import { cleanLogStorage, formatBytes } from '../utils/cleanup.js';
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
        service: 'botla-whatsapp-gateway',
        version: '1.0.0',
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        publicBaseUrl: getPublicBaseUrl(),
        redis: isUsingMockRedis() ? 'in-memory-fallback' : 'connected-redis',
        webhookUrl: config.botlaWebhookUrl,
        activeSessions: sessionService.listSessions().length,
        protocolVersion: cachedVersion ? cachedVersion.version.join('.') : 'synced-on-demand',
        isLatestProtocol: cachedVersion ? cachedVersion.isLatest : true,
        mediaRetentionHours: config.mediaRetentionHours,
        mediaCleanupIntervalHours: config.mediaCleanupIntervalHours,
        logRetentionDays: config.logRetentionDays,
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
   * POST /api/logs/cleanup
   */
  public static async cleanupLogs(
    request: FastifyRequest<{ Body: { retentionDays?: number } }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    try {
      const retentionDays = request.body?.retentionDays;
      const result = await cleanLogStorage(retentionDays);
      return reply.status(200).send(result);
    } catch (err: any) {
      request.log.error({ err: err.message }, 'Failed to execute log storage retention cleanup');
      return ResponseUtil.error(
        reply,
        'Failed to execute log storage retention cleanup',
        500,
        'LOG_CLEANUP_FAILED',
        err.message,
        {
          deletedFilesCount: 0,
          freedBytes: 0,
          freedBytesFormatted: '0 B',
          retentionDays: 14,
          timestamp: new Date().toISOString(),
        }
      );
    }
  }

  /**
   * GET /api/logs/files
   */
  public static async getLogFiles(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    try {
      const logsDir = path.resolve(process.cwd(), 'storage/logs');
      if (!fs.existsSync(logsDir)) {
        return ResponseUtil.success(
          reply,
          { files: [], totalSizeBytes: 0, totalSizeFormatted: '0 B' },
          200
        );
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

      filesInfo.sort((a, b) => {
        if (a.name === 'combined.log') return -1;
        if (b.name === 'combined.log') return 1;
        if (a.name === 'error.log') return -1;
        if (b.name === 'error.log') return 1;
        return b.name.localeCompare(a.name);
      });

      return ResponseUtil.success(
        reply,
        {
          files: filesInfo,
          totalSizeBytes: totalBytes,
          totalSizeFormatted: formatBytes(totalBytes),
          directory: 'storage/logs',
        },
        200
      );
    } catch (err: any) {
      request.log.error({ err: err.message }, 'Failed to inspect log directory');
      return ResponseUtil.error(reply, err.message, 500, 'INSPECT_LOGS_FAILED');
    }
  }

  /**
   * GET /api/logs/view
   * Safely reads and tails the specified log file from storage/logs/
   */
  public static async viewLogFile(
    request: FastifyRequest<{
      Querystring: {
        file?: string;
        lines?: number | string;
      };
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    try {
      const rawFile = request.query.file?.trim();
      if (!rawFile) {
        return ResponseUtil.error(reply, "Query parameter 'file' is required", 400, 'MISSING_PARAM_FILE');
      }

      // Security: Strict path traversal prevention
      if (rawFile.includes('..') || rawFile.includes('/') || rawFile.includes('\\')) {
        return ResponseUtil.error(reply, 'Invalid file name: directory traversal characters forbidden', 400, 'INVALID_FILENAME');
      }

      const logsDir = path.resolve(process.cwd(), 'storage/logs');
      const filename = path.basename(rawFile);
      const filePath = path.resolve(logsDir, filename);

      // Verify that the resolved path is strictly within the logs directory
      if (!filePath.startsWith(logsDir)) {
        return ResponseUtil.error(reply, 'Access denied: Path is outside storage/logs directory', 403, 'FORBIDDEN_PATH');
      }

      if (!fs.existsSync(filePath)) {
        return ResponseUtil.error(reply, `Log file '${filename}' not found`, 404, 'LOG_FILE_NOT_FOUND');
      }

      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) {
        return ResponseUtil.error(reply, 'Target is not a regular file', 400, 'INVALID_FILE_TYPE');
      }

      // Default to 200 lines, bounded between 1 and 5000
      let maxLines = 200;
      if (request.query.lines !== undefined) {
        const parsed = Number(request.query.lines);
        if (!isNaN(parsed) && parsed > 0) {
          maxLines = Math.min(parsed, 5000);
        }
      }

      let content = '';
      let actualLineCount = 0;

      if (stat.size === 0) {
        content = '';
        actualLineCount = 0;
      } else if (stat.size <= 2 * 1024 * 1024) {
        // Read file in memory if <= 2MB
        const rawText = await fs.promises.readFile(filePath, 'utf-8');
        const lines = rawText.split(/\r?\n/);
        if (lines.length > 0 && lines[lines.length - 1] === '') {
          lines.pop();
        }
        const sliced = lines.slice(-maxLines);
        content = sliced.join('\n');
        actualLineCount = sliced.length;
      } else {
        // For larger files, read the tail chunk based on maxLines to prevent memory spikes
        const chunkSize = Math.min(stat.size, Math.max(256 * 1024, maxLines * 2048));
        const buffer = Buffer.alloc(chunkSize);
        const fd = await fs.promises.open(filePath, 'r');
        try {
          await fd.read(buffer, 0, chunkSize, stat.size - chunkSize);
          const rawChunk = buffer.toString('utf-8');
          const lines = rawChunk.split(/\r?\n/);
          if (stat.size > chunkSize && lines.length > 1) {
            lines.shift(); // Remove incomplete first line from byte boundary offset
          }
          if (lines.length > 0 && lines[lines.length - 1] === '') {
            lines.pop();
          }
          const sliced = lines.slice(-maxLines);
          content = sliced.join('\n');
          actualLineCount = sliced.length;
        } finally {
          await fd.close();
        }
      }

      return ResponseUtil.success(
        reply,
        {
          filename,
          lines: actualLineCount,
          content,
          totalSizeBytes: stat.size,
          sizeFormatted: formatBytes(stat.size),
          modifiedAt: new Date(stat.mtimeMs).toISOString(),
          data: {
            filename,
            lines: actualLineCount,
            content,
          },
        },
        200
      );
    } catch (err: any) {
      request.log.error({ err: err.message }, 'Failed to read log file');
      return ResponseUtil.error(reply, 'Failed to read log file: ' + err.message, 500, 'READ_LOG_FAILED');
    }
  }

  /**
   * GET /api/logs/download
   * Streams the raw log file directly as an attachment.
   */
  public static async downloadLogFile(
    request: FastifyRequest<{
      Querystring: {
        file?: string;
      };
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply | void> {
    try {
      const rawFile = request.query.file?.trim();
      if (!rawFile) {
        return ResponseUtil.error(reply, "Query parameter 'file' is required", 400, 'MISSING_PARAM_FILE');
      }

      if (rawFile.includes('..') || rawFile.includes('/') || rawFile.includes('\\')) {
        return ResponseUtil.error(reply, 'Invalid file name: directory traversal characters forbidden', 400, 'INVALID_FILENAME');
      }

      const logsDir = path.resolve(process.cwd(), 'storage/logs');
      const filename = path.basename(rawFile);
      const filePath = path.resolve(logsDir, filename);

      if (!filePath.startsWith(logsDir)) {
        return ResponseUtil.error(reply, 'Access denied: Path is outside storage/logs directory', 403, 'FORBIDDEN_PATH');
      }

      if (!fs.existsSync(filePath)) {
        return ResponseUtil.error(reply, `Log file '${filename}' not found`, 404, 'LOG_FILE_NOT_FOUND');
      }

      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) {
        return ResponseUtil.error(reply, 'Target is not a regular file', 400, 'INVALID_FILE_TYPE');
      }

      reply.header('Content-Type', 'text/plain; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      reply.header('Content-Length', stat.size);

      const stream = fs.createReadStream(filePath);
      return reply.send(stream);
    } catch (err: any) {
      request.log.error({ err: err.message }, 'Failed to download log file');
      return ResponseUtil.error(reply, 'Failed to download log file: ' + err.message, 500, 'DOWNLOAD_LOG_FAILED');
    }
  }

  /**
   * POST /api/webhook/mock
   */
  public static async mockWebhook(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const signature = request.headers['x-botla-signature'];
    logger.info({ signature, body: request.body }, '[MockWebhook] Received webhook payload');
    return ResponseUtil.success(
      reply,
      { received: true, signatureMatched: !!signature },
      200
    );
  }
}
