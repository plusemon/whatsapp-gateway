import fs from 'fs';
import path from 'path';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { config, getRedisClient, isUsingMockRedis, logger } from './config.js';
import { sessionManager } from './manager/sessionManager.js';
import { sessionRoutes } from './routes/sessionRoutes.js';

/**
 * Builds and starts the Fastify WhatsApp Gateway Microservice.
 */
export async function buildServer() {
  const fastify = Fastify({
    logger: false, // Managed via custom pino logger in config
    trustProxy: true,
  });

  // Enable CORS for cross-origin management access
  await fastify.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // Health check endpoints
  fastify.get('/api/health', async () => {
    return {
      status: 'ok',
      service: 'botla-whatsapp-gateway',
      version: '1.0.0',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      redis: isUsingMockRedis() ? 'in-memory-fallback' : 'connected-redis',
      webhookUrl: config.botlaWebhookUrl,
      activeSessions: sessionManager.listSessions().length,
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
  if (cachedDashboardHtml) return cachedDashboardHtml;
  const possiblePaths = [
    path.resolve(process.cwd(), 'src/views/dashboard.html'),
    path.resolve(process.cwd(), 'whatsapp-gateway/src/views/dashboard.html'),
    path.resolve(process.cwd(), 'index.html'),
    path.resolve(process.cwd(), 'public/index.html'),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      try {
        cachedDashboardHtml = fs.readFileSync(p, 'utf-8');
        return cachedDashboardHtml;
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
    await getRedisClient();

    const server = await buildServer();
    await server.listen({
      port: config.port,
      host: config.host,
    });

    logger.info(
      { port: config.port, host: config.host },
      `[Server] Botla WhatsApp Gateway running on http://${config.host}:${config.port}`
    );
  } catch (err: any) {
    logger.error({ err: err.message }, '[Server] Fatal startup error');
    process.exit(1);
  }
}

// Auto-boot if this file is the main entrypoint
start();
