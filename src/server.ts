import fs from 'fs';
import path from 'path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { FastifyInstance } from 'fastify';
import {
  config,
  disconnectRedisClient,
  getPublicBaseUrl,
  getRedisClient,
  isUsingMockRedis,
  logger,
} from './config.js';
import { sessionManager } from './manager/sessionManager.js';
import { sessionRoutes } from './routes/sessionRoutes.js';
import { startMediaCleanupWorker, stopMediaCleanupWorker } from './utils/cleanup.js';
import { getCachedWhatsAppVersion, getWhatsAppVersion } from './utils/versionGuard.js';

/**
 * Builds and starts the Fastify WhatsApp Gateway Microservice.
 */
export async function buildServer(): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: false, // Managed via custom pino logger in config
    trustProxy: true,
  });

  // Enable CORS for cross-origin management access
  await fastify.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // Ensure media storage directory exists
  const mediaStoragePath = path.resolve(process.cwd(), 'storage/media');
  if (!fs.existsSync(mediaStoragePath)) {
    fs.mkdirSync(mediaStoragePath, { recursive: true });
  }

  // Register static file serving for downloaded inbound & local outbound media files
  await fastify.register(fastifyStatic, {
    root: mediaStoragePath,
    prefix: '/media/',
    decorateReply: false,
  });

  // Health check endpoints
  fastify.get('/api/health', async () => {
    const cachedVersion = getCachedWhatsAppVersion();
    return {
      status: 'ok',
      service: 'botla-whatsapp-gateway',
      version: '1.0.0',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      publicBaseUrl: getPublicBaseUrl(),
      redis: isUsingMockRedis() ? 'in-memory-fallback' : 'connected-redis',
      webhookUrl: config.botlaWebhookUrl,
      activeSessions: sessionManager.listSessions().length,
      protocolVersion: cachedVersion ? cachedVersion.version.join('.') : 'synced-on-demand',
      isLatestProtocol: cachedVersion ? cachedVersion.isLatest : true,
      mediaRetentionHours: config.mediaRetentionHours,
      mediaCleanupIntervalHours: config.mediaCleanupIntervalHours,
    };
  });

  fastify.get('/health', async () => ({ status: 'ok' }));

  // Register session REST routes under /api
  await fastify.register(sessionRoutes, { prefix: '/api' });

  // Optional mock webhook receiver for local testing and demonstration
  fastify.post('/api/webhook/mock', async (request) => {
    const signature = request.headers['x-botla-signature'];
    logger.info({ signature, body: request.body }, '[MockWebhook] Received webhook payload');
    return { received: true, signatureMatched: !!signature };
  });

  // Interactive Web Gateway Console on root GET / and /index.html
  fastify.get('/', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    return getDashboardHtml();
  });

  fastify.get('/index.html', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    return getDashboardHtml();
  });

  // Ensure /api 404s always return clean JSON, while web routes serve the gateway UI
  fastify.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api')) {
      reply.status(404).send({ error: 'Endpoint not found', url: request.url });
    } else {
      reply.type('text/html; charset=utf-8').send(getDashboardHtml());
    }
  });

  return fastify;
}

let cachedDashboardHtml = '';

/**
 * Loads the clean Industrial Dark Mode Dashboard for Botla Gateway.
 */
function getDashboardHtml(): string {
  if (process.env.NODE_ENV === 'production' && cachedDashboardHtml) {
    return cachedDashboardHtml;
  }
  const possiblePaths = [
    path.resolve(process.cwd(), 'src/views/dashboard.html'),
    path.resolve(process.cwd(), 'whatsapp-gateway/src/views/dashboard.html'),
    path.resolve(process.cwd(), 'index.html'),
    path.resolve(process.cwd(), 'public/index.html'),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, 'utf-8');
        if (process.env.NODE_ENV === 'production') {
          cachedDashboardHtml = content;
        }
        return content;
      } catch {
        // Continue fallback
      }
    }
  }
  return '<!DOCTYPE html><html><body><h1>Botla WhatsApp Gateway</h1></body></html>';
}

/**
 * Direct launch entrypoint when run via node/tsx.
 */
export async function start() {
  try {
    // Pre-connect Redis
    const redis = await getRedisClient();

    // Pre-warm WhatsApp Web protocol version cache in the background
    getWhatsAppVersion(redis).catch((versionErr: any) => {
      logger.warn({ err: versionErr.message }, '[Server] Initial protocol version check warning');
    });

    // Start background media storage auto-cleanup worker
    startMediaCleanupWorker(config.mediaCleanupIntervalHours, config.mediaRetentionHours);

    const server = await buildServer();
    await server.listen({
      port: config.port,
      host: config.host,
    });

    logger.info(
      { port: config.port, host: config.host },
      `[Server] Botla WhatsApp Gateway running on http://${config.host}:${config.port}`
    );

    // Auto-Restore previous sessions from Redis credentials in the background
    sessionManager.restoreAllSessions().catch((restoreErr: any) => {
      logger.error(
        { err: restoreErr.message },
        '[Server] Background session auto-restore encountered an error'
      );
    });

    // Graceful process shutdown orchestration
    let isShuttingDown = false;
    const shutdown = async (signal: string) => {
      if (isShuttingDown) return;
      isShuttingDown = true;

      logger.info({ signal }, '[Server] Received shutdown signal. Initiating graceful termination...');

      // Failsafe timeout to prevent hanging termination
      const forceExitTimer = setTimeout(() => {
        logger.error('[Server] Graceful shutdown timed out (10s). Forcing process exit.');
        process.exit(1);
      }, 10000);
      forceExitTimer.unref();

      try {
        // 0. Stop background media cleanup worker
        stopMediaCleanupWorker();

        // 1. Close active Baileys sockets without purging Redis keys
        await sessionManager.closeAllSessions();

        // 2. Stop accepting incoming HTTP traffic & close Fastify
        await server.close();
        logger.info('[Server] Fastify HTTP server closed.');

        // 3. Disconnect Redis connection cleanly
        await disconnectRedisClient();

        clearTimeout(forceExitTimer);
        logger.info('[Server] Graceful termination complete. Exiting.');
        process.exit(0);
      } catch (err: any) {
        logger.error({ err: err.message }, '[Server] Error during graceful shutdown');
        process.exit(1);
      }
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));

  } catch (err: any) {
    logger.error({ err: err.message }, '[Server] Fatal startup error');
    process.exit(1);
  }
}

// Auto-boot if this file is the main entrypoint
start();
