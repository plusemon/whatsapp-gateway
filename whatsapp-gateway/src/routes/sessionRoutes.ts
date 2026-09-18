import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import QRCode from 'qrcode';
import { sessionManager } from '../manager/sessionManager.js';
import type {
  ApiDeleteResponse,
  ApiInitResponse,
  ApiPairCodeResponse,
  ApiQrResponse,
  ApiSendMediaResponse,
  ApiSendResponse,
  PairCodeBody,
  SendMediaBody,
  SendMessageBody,
  SessionParams,
} from '../types/index.js';

/**
 * Fastify routes plugin exposing REST APIs for managing multi-tenant WhatsApp sessions.
 */
export const sessionRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  /**
   * 1. POST /api/sessions/:id/init
   * Initializes / boots the WhatsApp Baileys socket session.
   */
  fastify.post<{ Params: SessionParams; Reply: ApiInitResponse }>(
    '/sessions/:id/init',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              sessionId: { type: 'string' },
              status: { type: 'string' },
              message: { type: 'string' },
              qr: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      try {
        const sessionMeta = await sessionManager.initSession(id);
        return reply.status(200).send({
          success: true,
          sessionId: id,
          status: sessionMeta.status,
          message:
            sessionMeta.status === 'connected'
              ? 'Session is already connected'
              : 'Session socket initialized; waiting for QR scan or connection',
          qr: sessionMeta.qr,
        });
      } catch (err: any) {
        request.log.error({ sessionId: id, err: err.message }, 'Failed to initialize session');
        return reply.status(500).send({
          success: false,
          sessionId: id,
          status: 'disconnected',
          message: `Failed to initialize session: ${err.message}`,
          qr: null,
        });
      }
    }
  );

  /**
   * 2. GET /api/sessions/:id/qr
   * Returns current raw QR string (or null if connected/waiting).
   * Also optionally returns a rendered base64 data URL for easy viewing.
   */
  fastify.get<{
    Params: SessionParams;
    Querystring: { format?: string };
    Reply: ApiQrResponse;
  }>(
    '/sessions/:id/qr',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1 },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: ['raw', 'image', 'json'] },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              sessionId: { type: 'string' },
              qr: { type: ['string', 'null'] },
              status: { type: 'string' },
              qrDataUrl: { type: ['string', 'null'] },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const meta = sessionManager.getSession(id);
      const rawQr = await sessionManager.getQR(id);

      if (!meta && !rawQr) {
        return reply.status(404).send({
          sessionId: id,
          qr: null,
          status: 'disconnected',
          message: `Session '${id}' does not exist. Call POST /api/sessions/${id}/init first.`,
        });
      }

      let qrDataUrl: string | null = null;
      if (rawQr) {
        try {
          qrDataUrl = await QRCode.toDataURL(rawQr, { margin: 2, scale: 6 });
        } catch {
          // Ignore QR render error
        }
      }

      let message = 'Waiting for QR generation or device connection...';
      if (meta?.status === 'connected') {
        message = 'Device is already authenticated & connected';
      } else if (meta?.status === 'qr_expired') {
        message = 'QR code pairing timed out without being scanned. Re-initialize session to generate a new QR code.';
      } else if (rawQr) {
        message = 'Scan this QR code with WhatsApp';
      }

      return reply.status(200).send({
        sessionId: id,
        qr: rawQr,
        status: meta?.status || (rawQr ? 'qr_ready' : 'idle'),
        qrDataUrl,
        message,
      });
    }
  );

  /**
   * 3. POST /api/sessions/:id/send
   * Dispatches outbound message via the tenant's socket with anti-ban guardrails.
   */
  fastify.post<{
    Params: SessionParams;
    Body: SendMessageBody;
    Reply: ApiSendResponse;
  }>(
    '/sessions/:id/send',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1 },
          },
        },
        body: {
          type: 'object',
          required: ['jid', 'text'],
          properties: {
            jid: { type: 'string', minLength: 3 },
            text: { type: 'string', minLength: 1 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              sessionId: { type: 'string' },
              jid: { type: 'string' },
              messageId: { type: 'string' },
              timestamp: { type: 'number' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { jid, text } = request.body;

      try {
        const result = await sessionManager.sendMessage(id, jid, text);
        return reply.status(200).send({
          success: true,
          sessionId: id,
          jid,
          messageId: result.messageId,
          timestamp: result.timestamp,
        });
      } catch (err: any) {
        request.log.error({ sessionId: id, jid, err: err.message }, 'Failed to send message');
        return reply.status(400).send({
          success: false,
          sessionId: id,
          jid,
          messageId: '',
          timestamp: Date.now(),
        });
      }
    }
  );

  /**
   * 3b. POST /api/sessions/:id/pair-code
   * Alternative to QR code: generates an 8-character pairing code for phone number pairing.
   */
  fastify.post<{
    Params: SessionParams;
    Body: PairCodeBody;
    Reply: ApiPairCodeResponse;
  }>(
    '/sessions/:id/pair-code',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1 },
          },
        },
        body: {
          type: 'object',
          required: ['phoneNumber'],
          properties: {
            phoneNumber: { type: 'string', minLength: 6 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              sessionId: { type: 'string' },
              code: { type: ['string', 'null'] },
              message: { type: 'string' },
            },
          },
          400: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              sessionId: { type: 'string' },
              code: { type: ['string', 'null'] },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { phoneNumber } = request.body;

      try {
        const formattedCode = await sessionManager.requestPairingCode(id, phoneNumber);
        return reply.status(200).send({
          success: true,
          sessionId: id,
          code: formattedCode,
          message: 'Pairing code generated. Enter this code in WhatsApp > Linked Devices > Link with phone number.',
        });
      } catch (err: any) {
        request.log.error({ sessionId: id, phoneNumber, err: err.message }, 'Failed to generate pairing code');
        return reply.status(400).send({
          success: false,
          sessionId: id,
          code: null,
          message: err.message || 'Failed to request pairing code',
        });
      }
    }
  );

  /**
   * 3c. POST /api/sessions/:id/send-media
   * Dispatches outbound media (image, audio, document) with presence simulation.
   */
  fastify.post<{
    Params: SessionParams;
    Body: SendMediaBody;
    Reply: ApiSendMediaResponse;
  }>(
    '/sessions/:id/send-media',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1 },
          },
        },
        body: {
          type: 'object',
          required: ['jid', 'type', 'url'],
          properties: {
            jid: { type: 'string', minLength: 3 },
            type: { type: 'string', enum: ['image', 'audio', 'document'] },
            url: { type: 'string', minLength: 4 },
            caption: { type: 'string' },
            filename: { type: 'string' },
            ptt: { type: 'boolean' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              sessionId: { type: 'string' },
              jid: { type: 'string' },
              type: { type: 'string' },
              messageId: { type: 'string' },
              timestamp: { type: 'number' },
            },
          },
          400: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              sessionId: { type: 'string' },
              jid: { type: 'string' },
              type: { type: 'string' },
              messageId: { type: 'string' },
              timestamp: { type: 'number' },
              error: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { jid, type, url, caption, filename, ptt } = request.body;

      try {
        const result = await sessionManager.sendMedia(id, jid, type, url, {
          caption,
          filename,
          ptt,
        });

        return reply.status(200).send({
          success: true,
          sessionId: id,
          jid,
          type,
          messageId: result.messageId,
          timestamp: result.timestamp,
        });
      } catch (err: any) {
        request.log.error(
          { sessionId: id, jid, type, url, err: err.message },
          'Failed to send outbound media'
        );
        return reply.status(400).send({
          success: false,
          sessionId: id,
          jid,
          type,
          messageId: '',
          timestamp: Date.now(),
          error: err.message || 'Failed to dispatch outbound media message',
        });
      }
    }
  );

  /**
   * 4. DELETE /api/sessions/:id
   * Disconnects socket and purges tenant session state from Redis.
   */
  fastify.delete<{ Params: SessionParams; Reply: ApiDeleteResponse }>(
    '/sessions/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              sessionId: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      try {
        await sessionManager.deleteSession(id);
        return reply.status(200).send({
          success: true,
          sessionId: id,
          message: `Session '${id}' disconnected and purged from Redis and memory.`,
        });
      } catch (err: any) {
        request.log.error({ sessionId: id, err: err.message }, 'Failed to delete session');
        return reply.status(500).send({
          success: false,
          sessionId: id,
          message: `Error purging session '${id}': ${err.message}`,
        });
      }
    }
  );

  /**
   * Helper: GET /api/sessions
   * Lists all active or registered sessions.
   */
  fastify.get('/sessions', async () => {
    const sessions = sessionManager.listSessions();
    return {
      count: sessions.length,
      sessions,
    };
  });

  /**
   * Helper: GET /api/sessions/:id/status
   */
  fastify.get<{ Params: SessionParams }>('/sessions/:id/status', async (request, reply) => {
    const { id } = request.params;
    const session = sessionManager.getSession(id);
    if (!session) {
      return reply.status(404).send({
        success: false,
        message: `Session '${id}' not found`,
      });
    }
    return {
      success: true,
      session,
    };
  });

  /**
   * Helper: GET /api/events
   * Returns recent gateway events (inbound, outbound, webhooks, lifecycle).
   */
  fastify.get('/events', async () => {
    return {
      events: sessionManager.getRecentEvents(),
    };
  });
};
