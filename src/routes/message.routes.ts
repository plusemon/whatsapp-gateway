/**
 * Messaging & Media Dispatch Routes
 * Implements declarative OpenAPI / Swagger schemas for outbound messages, media, and message queries.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { MessageController } from '../controllers/message.controller.js';

export const messageRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  /* -------------------------------------------------------------------------- */
  /* REST API v1 Messaging Endpoints                                            */
  /* -------------------------------------------------------------------------- */

  // 1. Send Text Message
  fastify.post(
    '/v1/messages/send-text',
    {
      schema: {
        tags: ['Messages'],
        summary: 'Dispatch an outbound text message with optional typing simulation.',
        description: 'Sends a text message to a WhatsApp recipient phone number or JID with anti-ban typing presence simulation and randomized jitter delays.',
        body: {
          type: 'object',
          required: ['sessionId', 'to', 'message'],
          properties: {
            sessionId: {
              type: 'string',
              minLength: 1,
              example: 'tenant-botla-1',
              description: 'Tenant session ID',
            },
            to: {
              type: 'string',
              minLength: 3,
              example: '8801995329555',
              description: 'Recipient phone number (with country code) or WhatsApp JID',
            },
            message: {
              type: 'string',
              minLength: 1,
              example: 'Hello from Botla Gateway!',
              description: 'Message body text',
            },
            presence: {
              type: 'boolean',
              default: true,
              description: 'Simulate human typing delay (600ms–1400ms) before sending',
            },
          },
        },
        response: {
          202: {
            description: 'Message accepted and queued for anti-ban dispatch',
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              data: {
                type: 'object',
                properties: {
                  jobId: { type: 'string', example: '12' },
                  status: { type: 'string', example: 'QUEUED' },
                  estimatedDelayMs: { type: 'number', example: 1500 },
                },
              },
            },
          },
          400: {
            description: 'Bad Request - Validation error',
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string', example: 'VALIDATION_ERROR' },
                  message: { type: 'string', example: 'sessionId, to, and message are required fields.' },
                },
              },
            },
          },
        },
      },
    },
    MessageController.sendTextV1
  );

  // 2. Send Media Message
  fastify.post(
    '/v1/messages/send-media',
    {
      schema: {
        tags: ['Messages'],
        summary: 'Send image, video, audio, or document by remote URL.',
        description: 'Downloads media from remote URL or local storage and dispatches to WhatsApp recipient with anti-ban presence simulation.',
        body: {
          type: 'object',
          required: ['sessionId', 'to', 'mediaUrl', 'mediaType'],
          properties: {
            sessionId: {
              type: 'string',
              minLength: 1,
              example: 'tenant-botla-1',
              description: 'Tenant session ID',
            },
            to: {
              type: 'string',
              minLength: 3,
              example: '8801995329555',
              description: 'Recipient phone number (with country code) or WhatsApp JID',
            },
            mediaUrl: {
              type: 'string',
              format: 'uri',
              minLength: 4,
              example: 'https://example.com/invoice.pdf',
              description: 'Public URL of media file to download and forward',
            },
            mediaType: {
              type: 'string',
              enum: ['image', 'video', 'audio', 'document'],
              example: 'document',
              description: 'Type of media attachment',
            },
            caption: {
              type: 'string',
              example: 'September Invoice',
              description: 'Optional caption text accompanying image or video',
            },
            fileName: {
              type: 'string',
              example: 'invoice.pdf',
              description: 'Custom filename for document attachments',
            },
          },
        },
        response: {
          202: {
            description: 'Media message accepted and queued for anti-ban dispatch',
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              data: {
                type: 'object',
                properties: {
                  jobId: { type: 'string', example: '12' },
                  status: { type: 'string', example: 'QUEUED' },
                  estimatedDelayMs: { type: 'number', example: 2000 },
                },
              },
            },
          },
          400: {
            description: 'Bad Request - Validation or media download failure',
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string', example: 'VALIDATION_ERROR' },
                  message: { type: 'string', example: 'sessionId, to, mediaUrl, and mediaType are required fields.' },
                },
              },
            },
          },
        },
      },
    },
    MessageController.sendMediaV1
  );

  // 3. Get Message Delivery Status By ID
  fastify.get(
    '/v1/messages/:messageId',
    {
      schema: {
        tags: ['Messages'],
        summary: 'Fetch message delivery lifecycle status (ENQUEUED, SERVER_ACK, DELIVERY_ACK, READ).',
        description: 'Retrieves complete delivery audit trail and metadata for a specific message ID.',
        params: {
          type: 'object',
          required: ['messageId'],
          properties: {
            messageId: {
              type: 'string',
              minLength: 1,
              example: '3EB084DC6F0385409BFEDC',
              description: 'Unique message identifier',
            },
          },
        },
        response: {
          200: {
            description: 'Message status and delivery history',
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              data: {
                type: 'object',
                properties: {
                  id: { type: 'string', example: '3EB084DC6F0385409BFEDC' },
                  sessionId: { type: 'string', example: 'tenant-botla-1' },
                  remoteJid: { type: 'string', example: '8801995329555@s.whatsapp.net' },
                  direction: { type: 'string', example: 'OUTBOUND' },
                  status: { type: 'string', example: 'DELIVERY_ACK' },
                  type: { type: 'string', example: 'text' },
                  text: { type: 'string', nullable: true, example: 'Hello from Botla Gateway!' },
                  createdAt: { type: 'string', format: 'date-time' },
                  updatedAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
          404: {
            description: 'Message not found',
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string', example: 'MESSAGE_NOT_FOUND' },
                  message: { type: 'string', example: "Message '3EB084DC6F0385409BFEDC' not found" },
                },
              },
            },
          },
        },
      },
    },
    MessageController.getMessageById
  );

  fastify.get(
    '/messages/:id',
    {
      schema: {
        tags: ['Messages'],
        summary: 'Fetch message by ID (Direct Route).',
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', example: '3EB084DC6F0385409BFEDC' },
          },
        },
      },
    },
    MessageController.getMessageById
  );

  // 4. Query Historical Messages for a Tenant Session
  fastify.get(
    '/v1/sessions/:sessionId/messages',
    {
      schema: {
        tags: ['Messages'],
        summary: 'Historical messages query with filtering and pagination.',
        description: 'Queries stored inbound and outbound messages with pagination and filtering by direction or recipient.',
        params: {
          type: 'object',
          required: ['sessionId'],
          properties: {
            sessionId: {
              type: 'string',
              minLength: 1,
              example: 'tenant-botla-1',
              description: 'Tenant session identifier',
            },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            direction: {
              type: 'string',
              enum: ['INBOUND', 'OUTBOUND'],
              description: 'Filter messages by direction',
            },
            remoteJid: {
              type: 'string',
              description: 'Filter messages by recipient or sender JID',
            },
            limit: {
              type: 'integer',
              default: 50,
              maximum: 200,
              description: 'Maximum number of messages to return',
            },
            offset: {
              type: 'integer',
              default: 0,
              description: 'Pagination offset',
            },
          },
        },
        response: {
          200: {
            description: 'Paginated list of messages',
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              data: {
                type: 'object',
                properties: {
                  count: { type: 'number', example: 25 },
                  messages: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', example: '3EB084DC6F0385409BFEDC' },
                        sessionId: { type: 'string', example: 'tenant-botla-1' },
                        remoteJid: { type: 'string', example: '8801995329555@s.whatsapp.net' },
                        direction: { type: 'string', example: 'OUTBOUND' },
                        status: { type: 'string', example: 'READ' },
                        text: { type: 'string', nullable: true, example: 'Hello!' },
                        createdAt: { type: 'string', format: 'date-time' },
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
    MessageController.listSessionMessages
  );

  fastify.get(
    '/sessions/:id/messages',
    {
      schema: {
        tags: ['Messages'],
        summary: 'List session messages (Direct Route).',
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', example: 'tenant-botla-1' },
          },
        },
      },
    },
    MessageController.listSessionMessages
  );

  // 5. Direct / Legacy Message Dispatch Routes
  fastify.post(
    '/sessions/:id/send',
    {
      schema: {
        tags: ['Messages'],
        summary: 'Dispatch text message (Direct Route).',
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', example: 'tenant-botla-1' },
          },
        },
        body: {
          type: 'object',
          required: ['jid', 'text'],
          properties: {
            jid: { type: 'string', minLength: 1, example: '8801995329555@s.whatsapp.net' },
            text: { type: 'string', minLength: 1, example: 'Hello from Botla!' },
          },
        },
      },
    },
    MessageController.sendTextMessage
  );

  fastify.post(
    '/sessions/:id/send-media',
    {
      schema: {
        tags: ['Messages'],
        summary: 'Dispatch media message (Direct Route).',
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', example: 'tenant-botla-1' },
          },
        },
        body: {
          type: 'object',
          required: ['jid', 'type', 'url'],
          properties: {
            jid: { type: 'string', minLength: 1, example: '8801995329555@s.whatsapp.net' },
            type: { type: 'string', enum: ['image', 'audio', 'document', 'video'], example: 'image' },
            url: { type: 'string', minLength: 4, example: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=600' },
            caption: { type: 'string', example: 'Sample image' },
            filename: { type: 'string', example: 'photo.jpg' },
            ptt: { type: 'boolean', example: false },
          },
        },
      },
    },
    MessageController.sendMediaMessage
  );
};
