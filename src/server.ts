/**
 * WhatsApp Gateway - Application Entrypoint
 * Bootstraps Fastify server, middleware pipelines, API/UI routes,
 * background persistence workers, and graceful lifecycle handlers.
 */
import fs from 'fs';
import path from 'path';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { config, getPublicBaseUrl } from './config/env.js';
import { disconnectRedisClient } from './config/redis.js';
import { registerErrorHandlers } from './middleware/errorHandler.js';
import swaggerPlugin from './plugins/swagger.plugin.js';
import { apiRoutes } from './routes/api.routes.js';
import { getDashboardHtml, uiRoutes } from './routes/ui.routes.js';
import { sessionService } from './services/session.service.js';
import { mediaService } from './services/media.service.js';
import { DbService } from './services/db.service.js';
import { initMessageWorker, closeMessageWorker } from './queues/message.worker.js';
import { messageQueue, redisConnection } from './queues/message.queue.js';
import { initWebhookWorker, closeWebhookWorker } from './queues/webhook.worker.js';
import { webhookQueue, webhookRedisConnection } from './queues/webhook.queue.js';
import { startMediaCleanupWorker, stopMediaCleanupWorker } from './utils/cleanup.js';
import { logger } from './utils/logger.js';

export async function buildServer() {
  const fastify = Fastify({
    logger: false, // We route logging through our unified Pino multi-stream
    disableRequestLogging: true,
    ajv: {
      customOptions: {
        strict: false,
      },
    },
  });

  // 1. Cross-Origin Resource Sharing (CORS)
  await fastify.register(fastifyCors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  // 1b. Gracefully handle empty or whitespace JSON bodies (e.g., DELETE/POST without payloads)
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body || typeof body !== 'string' || body.trim() === '') {
      done(null, {});
      return;
    }
    try {
      const json = JSON.parse(body);
      done(null, json);
    } catch (err: any) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // 2. Ensure media storage directory exists & register static media server
  const mediaStorageDir = path.resolve(process.env.STORAGE_DIR || './storage/media');
  if (!fs.existsSync(mediaStorageDir)) {
    try {
      fs.mkdirSync(mediaStorageDir, { recursive: true });
    } catch {
      // Ignore
    }
  }

  await fastify.register(fastifyStatic, {
    root: mediaStorageDir,
    prefix: '/media/',
    decorateReply: false, // Prevent clash if public/ is already served
    index: false,
    list: false,
  });

  // 2b. Static asset serving for modular frontend assets (CSS/JS)
  const publicDir = path.resolve(process.cwd(), 'public');
  if (!fs.existsSync(publicDir)) {
    try {
      fs.mkdirSync(publicDir, { recursive: true });
    } catch {
      // Ignore
    }
  }

  await fastify.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
    decorateReply: false,
    index: false,
  });

  // 3. Register OpenAPI 3.0 & Swagger UI Plugin (/docs, /docs/json)
  await fastify.register(swaggerPlugin);

  // 4. Register global error & JSON 404 handlers
  registerErrorHandlers(fastify, getDashboardHtml);

  // 5. Register API Routes under /api prefix
  await fastify.register(apiRoutes, { prefix: '/api' });

  // 5. Register UI Routes (Dashboard on / and /index.html)
  await fastify.register(uiRoutes);

  return fastify;
}

export async function startServer() {
  const server = await buildServer();

  try {
    const address = await server.listen({
      port: config.port,
      host: config.host,
    });

    logger.info(
      {
        port: config.port,
        host: config.host,
        publicUrl: getPublicBaseUrl(),
        webhookTarget: config.webhookUrl,
        redisTarget: config.redisUrl,
        mediaRetentionHours: config.mediaRetentionHours,
      },
      `⚡ WhatsApp Gateway listening on ${address}`
    );

    // Start background automated media storage cleanup worker
    startMediaCleanupWorker();

    // Run media retention cleanup periodically (every 24 hours)
    const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000;
    const mediaCleanupInterval = setInterval(() => {
      mediaService.runRetentionCleanup().catch((err) => {
        logger.error({ err }, 'Periodic media cleanup encountered an error');
      });
    }, CLEANUP_INTERVAL);
    if (mediaCleanupInterval.unref) {
      mediaCleanupInterval.unref();
    }

    // Trigger initial media retention cleanup
    mediaService.runRetentionCleanup().catch(() => {});

    // Initialize BullMQ Anti-Ban Outbound Message Worker
    try {
      initMessageWorker(redisConnection);
      logger.info('[Server] BullMQ Anti-Ban Outbound Message Worker initialized successfully');
    } catch (workerErr: any) {
      logger.warn({ err: workerErr.message }, '[Server] Warning initializing BullMQ message worker');
    }

    // Initialize BullMQ Webhook Dispatch Worker
    try {
      initWebhookWorker(webhookRedisConnection);
      logger.info('[Server] BullMQ Webhook Dispatch Worker initialized successfully');
    } catch (whErr: any) {
      logger.warn({ err: whErr.message }, '[Server] Warning initializing BullMQ webhook worker');
    }

    // Auto-restore previously active sessions from persistent Redis storage
    sessionService.restoreAllSessions().catch((restoreErr) => {
      logger.error(
        { err: restoreErr.message, stack: restoreErr.stack },
        '[Server] Session auto-restore sequence encountered an error'
      );
    });

    // Register OS process shutdown signals for clean exit
    const handleShutdown = async (signal: string) => {
      logger.info({ signal }, `[Server] Received ${signal}. Executing graceful shutdown...`);

      // 1. Stop background workers
      stopMediaCleanupWorker();

      // 1b. Close BullMQ Message & Webhook Workers & Queues
      try {
        await closeMessageWorker();
        await messageQueue.close();
      } catch (queueErr: any) {
        logger.warn({ err: queueErr.message }, '[Server] Warning closing message queue during shutdown');
      }

      try {
        await closeWebhookWorker();
        await webhookQueue.close();
      } catch (whQueueErr: any) {
        logger.warn({ err: whQueueErr.message }, '[Server] Warning closing webhook queue during shutdown');
      }

      // 2. Gracefully end active WASockets
      try {
        await sessionService.closeAllSessions();
      } catch (sessErr: any) {
        logger.warn({ err: sessErr.message }, '[Server] Warning closing sessions during shutdown');
      }

      // 3. Disconnect Redis client
      try {
        await disconnectRedisClient();
      } catch (redisErr: any) {
        logger.warn({ err: redisErr.message }, '[Server] Warning disconnecting Redis during shutdown');
      }

      // 4. Disconnect Prisma database client
      try {
        await DbService.disconnect();
      } catch (dbErr: any) {
        logger.warn({ err: dbErr.message }, '[Server] Warning disconnecting Prisma during shutdown');
      }

      // 5. Close Fastify server
      try {
        await server.close();
        logger.info('[Server] HTTP server closed cleanly. Exiting process.');
      } catch (srvErr: any) {
        logger.warn({ err: srvErr.message }, '[Server] Warning closing HTTP server');
      }

      process.exit(0);
    };

    process.on('SIGINT', () => handleShutdown('SIGINT'));
    process.on('SIGTERM', () => handleShutdown('SIGTERM'));

    return server;
  } catch (err: any) {
    logger.fatal({ err: err.message, stack: err.stack }, '[Server] Fatal error during startup');
    process.exit(1);
  }
}

// Auto-boot if executed directly (not imported in test environments)
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  startServer().catch((err) => {
    logger.fatal({ err }, '[Server] Startup bootstrap failure');
    process.exit(1);
  });
}
