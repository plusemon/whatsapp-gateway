/**
 * Declarative API Route Definitions
 * Maps endpoint URLs, JSON schemas, and preHandlers to thin controller actions.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { MessageController } from '../controllers/message.controller.js';
import { SessionController } from '../controllers/session.controller.js';
import { SystemController } from '../controllers/system.controller.js';
import { SettingsController } from '../controllers/settings.controller.js';
import { authMiddleware } from '../middleware/auth.middleware.js';

export const apiRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // Apply authentication hook across all API routes
  fastify.addHook('preHandler', authMiddleware);

  /* -------------------------------------------------------------------------- */
  /* System, Version & Telemetry Endpoints                                      */
  /* -------------------------------------------------------------------------- */

  // Health check & gateway telemetry
  fastify.get('/health', SystemController.getHealth);

  // WhatsApp Web protocol version cache & sync
  fastify.get('/system/version', SessionController.getVersion);

  // Storage retention cleanups
  fastify.post('/media/cleanup', SystemController.cleanupMedia);

  // Real-time structured log stream (SSE) & Query
  fastify.get('/logs/stream', SystemController.streamLogs);
  fastify.get('/logs', SystemController.getLogs);

  // Gateway event buffer
  fastify.get('/events', SessionController.getRecentEvents);

  // Mock Laravel webhook receiver for local testing
  fastify.post('/webhook/mock', SystemController.mockWebhook);

  // Dynamic Webhook Settings & Test Ping
  fastify.get('/settings/webhook', SettingsController.getWebhookSettings);
  fastify.post('/settings/webhook', SettingsController.updateWebhookSettings);
  fastify.post('/settings/webhook/test', SettingsController.testWebhook);

  /* -------------------------------------------------------------------------- */
  /* Production-Grade Headless REST API v1 Endpoints                            */
  /* -------------------------------------------------------------------------- */

  // 1. Session Lifecycle
  fastify.post(
    '/v1/sessions/init',
    {
      schema: {
        body: {
          type: 'object',
          required: ['sessionId'],
          properties: {
            sessionId: { type: 'string', minLength: 1 },
            authMode: { type: 'string', enum: ['qr', 'pairing_code'] },
          },
        },
      },
    },
    SessionController.initSessionV1
  );

  fastify.post(
    '/v1/sessions/pair-code',
    {
      schema: {
        body: {
          type: 'object',
          required: ['sessionId', 'phoneNumber'],
          properties: {
            sessionId: { type: 'string', minLength: 1 },
            phoneNumber: { type: 'string', minLength: 6 },
          },
        },
      },
    },
    SessionController.pairCodeV1
  );

  fastify.get(
    '/v1/sessions/:sessionId/status',
    {
      schema: {
        params: {
          type: 'object',
          required: ['sessionId'],
          properties: {
            sessionId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    SessionController.getStatusV1
  );

  fastify.post(
    '/v1/sessions/:sessionId/logout',
    {
      schema: {
        params: {
          type: 'object',
          required: ['sessionId'],
          properties: {
            sessionId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    SessionController.logoutV1
  );

  fastify.delete(
    '/v1/sessions/:sessionId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['sessionId'],
          properties: {
            sessionId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    SessionController.deleteSessionV1
  );

  // 2. Messaging
  fastify.post(
    '/v1/messages/send-text',
    {
      schema: {
        body: {
          type: 'object',
          required: ['sessionId', 'to', 'message'],
          properties: {
            sessionId: { type: 'string', minLength: 1 },
            to: { type: 'string', minLength: 3 },
            message: { type: 'string', minLength: 1 },
            presence: { type: 'boolean' },
          },
        },
      },
    },
    MessageController.sendTextV1
  );

  fastify.post(
    '/v1/messages/send-media',
    {
      schema: {
        body: {
          type: 'object',
          required: ['sessionId', 'to', 'mediaUrl', 'mediaType'],
          properties: {
            sessionId: { type: 'string', minLength: 1 },
            to: { type: 'string', minLength: 3 },
            mediaUrl: { type: 'string', minLength: 4 },
            mediaType: { type: 'string', enum: ['document', 'image', 'video', 'audio'] },
            caption: { type: 'string' },
            fileName: { type: 'string' },
          },
        },
      },
    },
    MessageController.sendMediaV1
  );

  // 3. Message History & Status Queries (Prisma Persistence)
  fastify.get(
    '/v1/sessions/:sessionId/messages',
    {
      schema: {
        params: {
          type: 'object',
          required: ['sessionId'],
          properties: {
            sessionId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    MessageController.listSessionMessages
  );

  fastify.get(
    '/v1/messages/:messageId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['messageId'],
          properties: {
            messageId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    MessageController.getMessageById
  );

  // Direct and legacy session message queries
  fastify.get(
    '/sessions/:id/messages',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    MessageController.listSessionMessages
  );

  fastify.get(
    '/messages/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    MessageController.getMessageById
  );

  /* -------------------------------------------------------------------------- */
  /* WhatsApp Session Management Endpoints                                      */
  /* -------------------------------------------------------------------------- */

  // List all sessions
  fastify.get('/sessions', SessionController.listSessions);

  // Initialize or boot Baileys socket for a tenant
  fastify.post(
    '/sessions/:id/init',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    SessionController.initSession
  );

  // Retrieve current QR code
  fastify.get(
    '/sessions/:id/qr',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
      },
    },
    SessionController.getQr
  );

  // Request 8-character phone pairing code
  fastify.post(
    '/sessions/:id/pair-code',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
        body: {
          type: 'object',
          required: ['phoneNumber'],
          properties: {
            phoneNumber: { type: 'string', minLength: 6 },
          },
        },
      },
    },
    SessionController.requestPairingCode
  );

  // Delete & purge session
  fastify.delete(
    '/sessions/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
      },
    },
    SessionController.deleteSession
  );

  // Purge session alias (POST)
  fastify.post(
    '/sessions/:id/purge',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
      },
    },
    SessionController.deleteSession
  );

  // Logout session (POST /sessions/:id/logout)
  fastify.post(
    '/sessions/:id/logout',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
      },
    },
    SessionController.logoutSession
  );

  // Get session status
  fastify.get(
    '/sessions/:id/status',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
      },
    },
    SessionController.getSessionStatus
  );

  /* -------------------------------------------------------------------------- */
  /* Outbound Message & Media Dispatch Endpoints                                */
  /* -------------------------------------------------------------------------- */

  // Send outbound text message
  fastify.post(
    '/sessions/:id/send',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
        body: {
          type: 'object',
          required: ['jid', 'text'],
          properties: {
            jid: { type: 'string', minLength: 1 },
            text: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    MessageController.sendTextMessage
  );

  // Send outbound media message
  fastify.post(
    '/sessions/:id/send-media',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
        body: {
          type: 'object',
          required: ['jid', 'type', 'url'],
          properties: {
            jid: { type: 'string', minLength: 1 },
            type: { type: 'string', enum: ['image', 'audio', 'document'] },
            url: { type: 'string', minLength: 4 },
            caption: { type: 'string' },
            filename: { type: 'string' },
            ptt: { type: 'boolean' },
          },
        },
      },
    },
    MessageController.sendMediaMessage
  );
};
