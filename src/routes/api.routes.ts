/**
 * Declarative API Route Definitions
 * Registers modular Session, Message, and System route plugins under the /api prefix
 * with preHandler authentication and unified OpenAPI schemas.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { messageRoutes } from './message.routes.js';
import { sessionRoutes } from './session.routes.js';
import { systemRoutes } from './system.routes.js';
import { webhookRoutes } from './webhook.routes.js';

export const apiRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // Apply authentication hook across all API routes
  fastify.addHook('preHandler', authMiddleware);

  // Register modular route modules
  await fastify.register(systemRoutes);
  await fastify.register(sessionRoutes);
  await fastify.register(messageRoutes);
  await fastify.register(webhookRoutes);
};
