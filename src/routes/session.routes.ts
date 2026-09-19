/**
 * Session Lifecycle & Multi-Device Authentication Routes
 * Implements declarative OpenAPI / Swagger schemas for tenant socket management.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { SessionController } from '../controllers/session.controller.js';

export const sessionRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  /* -------------------------------------------------------------------------- */
  /* REST API v1 Session Endpoints                                              */
  /* -------------------------------------------------------------------------- */

  // 1. Initialize or Reconnect Session
  fastify.post(
    '/v1/sessions/init',
    {
      schema: {
        tags: ['Sessions'],
        summary: 'Initialize or reconnect a tenant session.',
        description: 'Initializes a WhatsApp Baileys WASocket for the specified tenant sessionId. Supports QR code generation or pairing code mode.',
        body: {
          type: 'object',
          required: ['sessionId'],
          properties: {
            sessionId: {
              type: 'string',
              minLength: 1,
              example: 'tenant-botla-1',
              description: 'Unique tenant identifier',
            },
            authMode: {
              type: 'string',
              enum: ['qr', 'pairing_code'],
              default: 'qr',
              description: 'Authentication mode: qr for QR code scanning, pairing_code for 8-digit phone pairing',
            },
          },
        },
        response: {
          200: {
            description: 'Session initialized successfully',
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              data: {
                type: 'object',
                properties: {
                  sessionId: { type: 'string', example: 'tenant-botla-1' },
                  status: { type: 'string', example: 'idle' },
                  authMode: { type: 'string', example: 'qr' },
                  qr: { type: 'string', nullable: true, example: '2@AbCdEf...' },
                },
              },
            },
          },
          400: {
            description: 'Bad Request - Validation Error',
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string', example: 'VALIDATION_ERROR' },
                  message: { type: 'string', example: 'sessionId is required.' },
                },
              },
            },
          },
        },
      },
    },
    SessionController.initSessionV1
  );

  // 2. Request Phone Pairing Code
  fastify.post(
    '/v1/sessions/pair-code',
    {
      schema: {
        tags: ['Sessions'],
        summary: 'Request an 8-digit WhatsApp phone pairing code.',
        description: 'Requests an 8-character alphanumeric pairing code for linking WhatsApp via phone number without QR code scanning.',
        body: {
          type: 'object',
          required: ['sessionId', 'phoneNumber'],
          properties: {
            sessionId: {
              type: 'string',
              minLength: 1,
              example: 'tenant-botla-1',
              description: 'Unique tenant identifier',
            },
            phoneNumber: {
              type: 'string',
              minLength: 6,
              example: '+8801995329555',
              description: 'Phone number including country code',
            },
          },
        },
        response: {
          200: {
            description: 'Pairing code generated successfully',
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              data: {
                type: 'object',
                properties: {
                  pairingCode: { type: 'string', example: 'ABCD-1234' },
                  expiresIn: { type: 'number', example: 120 },
                },
              },
            },
          },
          400: {
            description: 'Bad Request - Pairing code generation failed',
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string', example: 'PAIRING_CODE_FAILED' },
                  message: { type: 'string', example: 'Failed to request pairing code' },
                },
              },
            },
          },
          404: {
            description: 'Session not found',
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string', example: 'SESSION_NOT_FOUND' },
                  message: { type: 'string', example: 'Session not found' },
                },
              },
            },
          },
        },
      },
    },
    SessionController.pairCodeV1
  );

  // 3. List All Sessions (v1 & direct)
  fastify.get(
    '/v1/sessions',
    {
      schema: {
        tags: ['Sessions'],
        summary: 'List all tenant sessions and their connection statuses.',
        description: 'Returns an array of all active or cached tenant sessions and their WhatsApp connection states.',
        response: {
          200: {
            description: 'List of sessions retrieved successfully',
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              data: {
                type: 'object',
                properties: {
                  count: { type: 'number', example: 1 },
                  sessions: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', example: 'tenant-botla-1' },
                        sessionId: { type: 'string', example: 'tenant-botla-1' },
                        status: { type: 'string', example: 'connected' },
                        phoneNumber: { type: 'string', nullable: true, example: '8801995329555' },
                        phone: { type: 'string', nullable: true, example: '8801995329555' },
                        pushName: { type: 'string', nullable: true, example: 'Botla Support' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    SessionController.listSessions
  );

  fastify.get(
    '/sessions',
    {
      schema: {
        tags: ['Sessions'],
        summary: 'List all tenant sessions (Direct Route).',
        description: 'Retrieves all tenant sessions and statuses.',
      },
    },
    SessionController.listSessions
  );

  // 4. Get Session Status
  fastify.get(
    '/v1/sessions/:sessionId/status',
    {
      schema: {
        tags: ['Sessions'],
        summary: 'Get active socket health, phone number, and push name.',
        description: 'Returns real-time connection status, authenticated phone number, and profile push name for a specific session.',
        params: {
          type: 'object',
          required: ['sessionId'],
          properties: {
            sessionId: { type: 'string', minLength: 1, example: 'tenant-botla-1', description: 'Tenant session identifier' },
          },
        },
        response: {
          200: {
            description: 'Session status details',
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              data: {
                type: 'object',
                properties: {
                  sessionId: { type: 'string', example: 'tenant-botla-1' },
                  status: { type: 'string', example: 'connected' },
                  phone: { type: 'string', nullable: true, example: '8801995329555' },
                  pushName: { type: 'string', nullable: true, example: 'Botla Support' },
                },
              },
            },
          },
          404: {
            description: 'Session not found',
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string', example: 'SESSION_NOT_FOUND' },
                  message: { type: 'string', example: "Session 'tenant-botla-1' not found" },
                },
              },
            },
          },
        },
      },
    },
    SessionController.getStatusV1
  );

  fastify.get(
    '/sessions/:id/status',
    {
      schema: {
        tags: ['Sessions'],
        summary: 'Get session status (Direct Route).',
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', example: 'tenant-botla-1' },
          },
        },
      },
    },
    SessionController.getSessionStatus
  );

  // 5. Logout Session
  fastify.post(
    '/v1/sessions/:sessionId/logout',
    {
      schema: {
        tags: ['Sessions'],
        summary: 'Unlink device from WhatsApp without deleting session credentials.',
        description: 'Unlinks the active WhatsApp device from the gateway socket without wiping local configs.',
        params: {
          type: 'object',
          required: ['sessionId'],
          properties: {
            sessionId: { type: 'string', minLength: 1, example: 'tenant-botla-1' },
          },
        },
        response: {
          200: {
            description: 'Device unlinked successfully',
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              data: {
                type: 'object',
                properties: {
                  sessionId: { type: 'string', example: 'tenant-botla-1' },
                  status: { type: 'string', example: 'disconnected' },
                  message: { type: 'string', example: 'Device unlinked successfully' },
                },
              },
            },
          },
        },
      },
    },
    SessionController.logoutV1
  );

  fastify.post(
    '/sessions/:id/logout',
    {
      schema: {
        tags: ['Sessions'],
        summary: 'Logout session socket (Direct Route).',
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', example: 'tenant-botla-1' },
          },
        },
      },
    },
    SessionController.logoutSession
  );

  // 6. Delete / Purge Session
  fastify.delete(
    '/v1/sessions/:sessionId',
    {
      schema: {
        tags: ['Sessions'],
        summary: 'Purge session credentials, socket connections, and database records.',
        description: 'Disconnects the active socket and flushes all Redis auth credentials and local runtime state.',
        params: {
          type: 'object',
          required: ['sessionId'],
          properties: {
            sessionId: { type: 'string', minLength: 1, example: 'tenant-botla-1' },
          },
        },
        response: {
          200: {
            description: 'Session purged successfully',
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              data: {
                type: 'object',
                properties: {
                  sessionId: { type: 'string', example: 'tenant-botla-1' },
                  message: { type: 'string', example: 'Session purged successfully' },
                },
              },
            },
          },
        },
      },
    },
    SessionController.deleteSessionV1
  );

  fastify.delete(
    '/sessions/:id',
    {
      schema: {
        tags: ['Sessions'],
        summary: 'Purge session (Direct Route).',
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', example: 'tenant-botla-1' },
          },
        },
      },
    },
    SessionController.deleteSession
  );

  fastify.post(
    '/sessions/:id/purge',
    {
      schema: {
        tags: ['Sessions'],
        summary: 'Purge session credentials via POST (Direct Route).',
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', example: 'tenant-botla-1' },
          },
        },
      },
    },
    SessionController.deleteSession
  );

  // 7. Direct / Legacy Session Init and QR Code Retrieval
  fastify.post(
    '/sessions/:id/init',
    {
      schema: {
        tags: ['Sessions'],
        summary: 'Initialize session socket (Direct Route).',
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1, example: 'tenant-botla-1' },
          },
        },
        body: {
          type: 'object',
          properties: {
            authMode: { type: 'string', enum: ['qr', 'pairing_code'], default: 'qr' },
          },
        },
      },
    },
    SessionController.initSession
  );

  fastify.get(
    '/sessions/:id/qr',
    {
      schema: {
        tags: ['Sessions'],
        summary: 'Retrieve current QR code.',
        description: 'Fetches the active QR pairing string and base64 rendered data URL for scanning.',
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', example: 'tenant-botla-1' },
          },
        },
        response: {
          200: {
            description: 'QR Code details and rendered base64 image data URL',
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              data: {
                type: 'object',
                properties: {
                  sessionId: { type: 'string', example: 'tenant-botla-1' },
                  qr: { type: 'string', nullable: true, example: '2@AbCdEf...' },
                  status: { type: 'string', example: 'qr_ready' },
                  qrDataUrl: { type: 'string', nullable: true, example: 'data:image/png;base64,...' },
                  message: { type: 'string', example: 'Scan this QR code with WhatsApp' },
                },
              },
            },
          },
        },
      },
    },
    SessionController.getQr
  );

  fastify.post(
    '/sessions/:id/pair-code',
    {
      schema: {
        tags: ['Sessions'],
        summary: 'Request 8-character phone pairing code (Direct Route).',
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', example: 'tenant-botla-1' },
          },
        },
        body: {
          type: 'object',
          required: ['phoneNumber'],
          properties: {
            phoneNumber: { type: 'string', minLength: 6, example: '+8801995329555' },
          },
        },
      },
    },
    SessionController.requestPairingCode
  );
};
