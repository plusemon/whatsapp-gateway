/**
 * Botla WhatsApp Gateway - Application Entrypoint
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
import { apiRoutes } from './routes/api.routes.js';
import { getDashboardHtml, uiRoutes } from './routes/ui.routes.js';
import { sessionService } from './services/session.service.js';
import { startMediaCleanupWorker, stopMediaCleanupWorker } from './utils/cleanup.js';
import { logger } from './utils/logger.js';

export async function buildServer() {
  const fastify = Fastify({
    logger: false, // We route logging through our unified Pino multi-stream
    disableRequestLogging: true,
  });

  // 1. Cross-Origin Resource Sharing (CORS)
  await fastify.register(fastifyCors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  // 2. Ensure media storage directory exists & register static media server
  const mediaStorageDir = path.resolve(process.cwd(), 'storage/media');
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
    decorateReply: true,
    index: false,
    list: false,
  });

  // 3. Register global error & JSON 404 handlers
  registerErrorHandlers(fastify, getDashboardHtml);

  // 4. Register API Routes under /api prefix
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
        webhookTarget: config.botlaWebhookUrl,
        redisTarget: config.redisUrl,
        mediaRetentionHours: config.mediaRetentionHours,
      },
      `⚡ Botla WhatsApp Gateway listening on ${address}`
    );

    // Start background automated media storage cleanup worker
    startMediaCleanupWorker();

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

      // 4. Close Fastify server
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

// Auto-boot if executed as main module
startServer().catch((err) => {
  logger.fatal({ err }, '[Server] Startup bootstrap failure');
  process.exit(1);
});
