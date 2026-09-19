import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { apiRoutes } from '../../src/routes/api.routes.js';
import { sessionService } from '../../src/services/session.service.js';
import { prisma, MessageStatus, MessageDirection } from '../../src/services/db.service.js';
import { initMessageWorker, closeMessageWorker, processOutboundJob } from '../../src/queues/message.worker.js';
import { messageQueue } from '../../src/queues/message.queue.js';

import { registerErrorHandlers } from '../../src/middleware/errorHandler.js';

describe('Anti-Ban Outbound Message Queue with BullMQ & Redis', () => {
  let app: FastifyInstance;
  const TEST_KEY = 'test-api-key-queue-999';
  const originalKey = process.env.API_GATEWAY_KEY;

  beforeAll(() => {
    process.env.API_GATEWAY_KEY = TEST_KEY;
  });

  afterAll(() => {
    if (originalKey !== undefined) {
      process.env.API_GATEWAY_KEY = originalKey;
    } else {
      delete process.env.API_GATEWAY_KEY;
    }
  });

  beforeEach(async () => {
    app = Fastify({
      logger: false,
      ajv: {
        customOptions: {
          strict: false,
        },
      },
    });
    registerErrorHandlers(app, () => '');
    await app.register(apiRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await closeMessageWorker();
  });

  describe('REST API v1 Message Queue Enqueueing', () => {
    it('POST /api/v1/messages/send-text should return HTTP 202 Accepted and QUEUED status', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/messages/send-text',
        headers: { 'x-api-key': TEST_KEY },
        payload: {
          sessionId: 'tenant-test-1',
          to: '8801995329555',
          message: 'Test queued message',
          presence: true,
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('QUEUED');
      expect(body.data.jobId).toBeDefined();
      expect(body.data.estimatedDelayMs).toBe(1500);
    });

    it('POST /api/v1/messages/send-text should validate missing required parameters', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/messages/send-text',
        headers: { 'x-api-key': TEST_KEY },
        payload: {
          sessionId: 'tenant-test-1',
          // missing 'to' and 'message'
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('POST /api/v1/messages/send-media should return HTTP 202 Accepted and QUEUED status', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/messages/send-media',
        headers: { 'x-api-key': TEST_KEY },
        payload: {
          sessionId: 'tenant-test-1',
          to: '8801995329555',
          mediaUrl: 'https://example.com/invoice.pdf',
          mediaType: 'document',
          caption: 'Your Monthly Invoice',
          fileName: 'invoice-sep.pdf',
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('QUEUED');
      expect(body.data.jobId).toBeDefined();
      expect(body.data.estimatedDelayMs).toBe(2000);
    });

    it('POST /api/v1/messages/send-media should reject invalid mediaType', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/messages/send-media',
        headers: { 'x-api-key': TEST_KEY },
        payload: {
          sessionId: 'tenant-test-1',
          to: '8801995329555',
          mediaUrl: 'https://example.com/file.exe',
          mediaType: 'executable' as any,
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Message Worker Anti-Ban & Socket Processing Logic', () => {
    it('should simulate presence and dispatch text message when session is connected', async () => {
      const mockSendMessage = vi.fn().mockResolvedValue({
        key: { id: 'WA_MSG_12345' },
      });
      const mockSendPresenceUpdate = vi.fn().mockResolvedValue(undefined);

      // Register connected mock session in sessionService
      (sessionService as any).metadataMap.set('tenant-worker-1', {
        sessionId: 'tenant-worker-1',
        status: 'connected',
        authMode: 'qr',
        reconnectAttempts: 0,
      });
      (sessionService as any).activeSockets.set('tenant-worker-1', {
        sendMessage: mockSendMessage,
        sendPresenceUpdate: mockSendPresenceUpdate,
      });

      // Directly invoke processOutboundJob with mock Job
      const mockJob = {
        id: 'job-999',
        attemptsMade: 0,
        data: {
          sessionId: 'tenant-worker-1',
          to: '8801995329555',
          type: 'text' as const,
          message: 'Hello anti-ban test',
          presence: true,
        },
      };

      const result = await processOutboundJob(mockJob);

      expect(result.status).toBe('SERVER_ACK');
      expect(result.messageId).toBe('WA_MSG_12345');
      expect(mockSendPresenceUpdate).toHaveBeenCalledWith('composing', '8801995329555@s.whatsapp.net');
      expect(mockSendPresenceUpdate).toHaveBeenCalledWith('paused', '8801995329555@s.whatsapp.net');
      expect(mockSendMessage).toHaveBeenCalledWith('8801995329555@s.whatsapp.net', {
        text: 'Hello anti-ban test',
      });
    });

    it('should throw error when session is not connected so BullMQ can retry', async () => {
      // Session does not exist in sessionService
      const mockJob = {
        id: 'job-err-1',
        attemptsMade: 0,
        data: {
          sessionId: 'non-existent-tenant',
          to: '8801995329555',
          type: 'text' as const,
          message: 'Will fail',
          presence: true,
        },
      };

      await expect(processOutboundJob(mockJob)).rejects.toThrow(/is not connected or socket is unavailable/);
    });
  });
});
