/**
 * System, Telemetry & Webhook Configuration Routes
 * Implements declarative OpenAPI / Swagger schemas for health, logging, and webhook pipelines.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { SettingsController } from '../controllers/settings.controller.js';
import { SessionController } from '../controllers/session.controller.js';
import { SystemController } from '../controllers/system.controller.js';

export const systemRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  /* -------------------------------------------------------------------------- */
  /* System, Version & Telemetry Endpoints                                      */
  /* -------------------------------------------------------------------------- */

  // Health check & gateway telemetry
  fastify.get(
    '/health',
    {
      schema: {
        tags: ['System'],
        summary: 'Gateway health check and memory metrics.',
        description: 'Returns real-time gateway health status, active socket counts, Redis connection mode, and uptime.',
        response: {
          200: {
            description: 'Health status payload',
            type: 'object',
            properties: {
              status: { type: 'string', example: 'ok' },
              service: { type: 'string', example: 'whatsapp-gateway' },
              version: { type: 'string', example: '1.2.0' },
              uptimeSeconds: { type: 'number', example: 120 },
              timestamp: { type: 'string', format: 'date-time' },
              publicBaseUrl: { type: 'string', example: 'http://127.0.0.1:3000' },
              redis: { type: 'string', example: 'connected-redis' },
              webhookUrl: { type: 'string', example: 'http://localhost:8000/api/whatsapp/webhook' },
              webhookEnabled: { type: 'boolean', example: true },
              activeSessions: { type: 'number', example: 2 },
              protocolVersion: { type: 'string', example: '2.3000.1015901307' },
            },
          },
        },
      },
    },
    SystemController.getHealth
  );

  fastify.get(
    '/v1/health',
    {
      schema: {
        tags: ['System'],
        summary: 'Gateway health check v1.',
      },
    },
    SystemController.getHealth
  );

  // WhatsApp Web protocol version cache & sync
  fastify.get(
    '/system/version',
    {
      schema: {
        tags: ['System'],
        summary: 'WhatsApp Web protocol version cache and sync.',
        description: 'Retrieves current WhatsApp Web Baileys protocol version tuple and verifies if it is up-to-date.',
        response: {
          200: {
            description: 'Protocol version info',
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              data: {
                type: 'object',
                properties: {
                  protocolVersion: { type: 'string', example: '2.3000.1015901307' },
                  versionTuple: { type: 'array', items: { type: 'number' }, example: [2, 3000, 1015901307] },
                  isLatest: { type: 'boolean', example: true },
                  source: { type: 'string', example: 'redis-cached' },
                  fetchedAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
    SessionController.getVersion
  );

  // Storage retention cleanups
  fastify.post(
    '/media/cleanup',
    {
      schema: {
        tags: ['System'],
        summary: 'Run manual media storage retention cleanup.',
        description: 'Purges media files older than the retention threshold from local storage.',
        body: {
          type: 'object',
          properties: {
            retentionHours: { type: 'number', example: 48, description: 'Retention cutoff in hours' },
          },
        },
        response: {
          200: {
            description: 'Cleanup execution summary',
            type: 'object',
            properties: {
              deletedFilesCount: { type: 'number', example: 5 },
              freedBytes: { type: 'number', example: 1048576 },
              freedBytesFormatted: { type: 'string', example: '1.00 MB' },
            },
          },
        },
      },
    },
    SystemController.cleanupMedia
  );

  // Real-time structured log stream (SSE)
  fastify.get(
    '/logs/stream',
    {
      schema: {
        tags: ['System'],
        summary: 'Real-time Server-Sent Events (SSE) log stream.',
        description: 'Establishes a persistent Server-Sent Events (SSE) stream broadcasting real-time Pino JSON structured logs and socket events.',
      },
    },
    SystemController.streamLogs
  );

  // Structured logs query
  fastify.get(
    '/logs',
    {
      schema: {
        tags: ['System'],
        summary: 'Retrieve recent structured JSON logs.',
        description: 'Queries recent in-memory log buffer with level and session filtering.',
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', default: 100, maximum: 250, description: 'Number of logs to return' },
            level: { type: 'string', enum: ['info', 'warn', 'error', 'debug'], description: 'Filter by log severity level' },
            sessionId: { type: 'string', description: 'Filter by tenant session ID' },
          },
        },
        response: {
          200: {
            description: 'List of logs',
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              data: {
                type: 'object',
                properties: {
                  count: { type: 'number', example: 50 },
                  logs: { type: 'array' },
                },
              },
            },
          },
        },
      },
    },
    SystemController.getLogs
  );

  // Gateway event buffer
  fastify.get(
    '/events',
    {
      schema: {
        tags: ['System'],
        summary: 'Retrieve recent socket and gateway lifecycle events.',
        description: 'Fetches recent connection updates, QR rotations, and webhook dispatch telemetry events.',
      },
    },
    SessionController.getRecentEvents
  );

  // Mock Laravel webhook receiver for local testing
  fastify.post(
    '/webhook/mock',
    {
      schema: {
        tags: ['Webhooks'],
        summary: 'Mock receiver endpoint for testing webhook dispatches locally.',
        description: 'Accepts inbound WhatsApp payloads and verifies X-Gateway-Signature HMAC-SHA256 headers.',
      },
    },
    SystemController.mockWebhook
  );

  /* -------------------------------------------------------------------------- */
  /* Webhook Configuration & Dispatch Telemetry Endpoints                       */
  /* -------------------------------------------------------------------------- */

  // Dynamic Webhook Settings Query
  fastify.get(
    '/settings/webhook',
    {
      schema: {
        tags: ['Webhooks'],
        summary: 'Retrieve current webhook target URL and signature configuration.',
        description: 'Returns effective webhook URL, secret availability, retry statistics, and enabled event categories.',
        querystring: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'Tenant session ID to resolve tenant-specific webhook override' },
          },
        },
        response: {
          200: {
            description: 'Webhook configuration settings',
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              data: {
                type: 'object',
                properties: {
                  url: { type: 'string', example: 'http://localhost:8000/api/whatsapp/webhook' },
                  hasSecret: { type: 'boolean', example: true },
                  enabled: { type: 'boolean', example: true },
                  source: { type: 'string', example: 'database' },
                  sessionId: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
      },
    },
    SettingsController.getWebhookSettings
  );

  // Dynamic Webhook Settings Update
  fastify.post(
    '/settings/webhook',
    {
      schema: {
        tags: ['Webhooks'],
        summary: 'Update webhook destination URL and secret.',
        description: 'Updates downstream webhook URL, HMAC signature secret, bearer token, and event subscription flags.',
        body: {
          type: 'object',
          properties: {
            url: { type: 'string', format: 'uri', example: 'http://localhost:8000/api/whatsapp/webhook' },
            secret: { type: 'string', example: 'webhook-hmac-secret-key' },
            token: { type: 'string', example: 'bearer-token-123' },
            enabled: { type: 'boolean', default: true },
            sessionId: { type: 'string', description: 'Optional session ID for tenant-specific webhook' },
            events: {
              type: 'object',
              properties: {
                inbound: { type: 'boolean', default: true },
                ack: { type: 'boolean', default: true },
                status: { type: 'boolean', default: true },
              },
            },
          },
        },
        response: {
          200: {
            description: 'Webhook settings updated',
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              data: { type: 'object' },
            },
          },
        },
      },
    },
    SettingsController.updateWebhookSettings
  );

  // Webhook Test Ping
  fastify.post(
    '/settings/webhook/test',
    {
      schema: {
        tags: ['Webhooks'],
        summary: 'Dispatch test ping payload to configured webhook.',
        description: 'Sends a simulated ping event signed with HMAC-SHA256 to verify downstream receiver connectivity and signature verification.',
        body: {
          type: 'object',
          properties: {
            url: { type: 'string', example: 'http://localhost:8000/api/whatsapp/webhook' },
            secret: { type: 'string', example: 'webhook-hmac-secret-key' },
            token: { type: 'string', example: 'bearer-token' },
            sessionId: { type: 'string', example: 'tenant-default-1' },
          },
        },
        response: {
          200: {
            description: 'Webhook test ping execution results',
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              data: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  statusCode: { type: 'number', example: 200 },
                  latencyMs: { type: 'number', example: 45 },
                  responseBody: { type: 'string', example: '{"status":"received"}' },
                },
              },
            },
          },
        },
      },
    },
    SettingsController.testWebhook
  );
};
