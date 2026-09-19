import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { apiRoutes } from '../../src/routes/api.routes.js';
import { registerErrorHandlers } from '../../src/middleware/errorHandler.js';
import { prisma } from '../../src/services/db.service.js';
import { WebhookService } from '../../src/services/webhook.service.js';

describe('Webhook DLQ & Management REST Routes', () => {
  let app: FastifyInstance;
  const TEST_KEY = 'test-api-key-wh-routes-999';
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
  });

  it('GET /api/v1/webhooks/failed should return failed webhook logs', async () => {
    // Seed a failed log
    const failedLog = await prisma.webhookLog.create({
      data: {
        sessionId: 'tenant-dlq-test-1',
        event: 'message.inbound',
        payload: { from: '8801995329555', text: 'Failed delivery message' },
        statusCode: 500,
        attempts: 4,
        success: false,
        error: 'Target returned non-2xx status: 500 Internal Server Error',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/webhooks/failed?sessionId=tenant-dlq-test-1',
      headers: { 'x-api-key': TEST_KEY },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.data.logs).toBeDefined();
    expect(body.data.logs.some((l: any) => l.id === failedLog.id)).toBe(true);
  });

  it('POST /api/v1/webhooks/retry/:logId should re-enqueue a failed webhook job', async () => {
    // Setup session webhook destination
    await WebhookService.setSessionConfig('tenant-retry-session-1', {
      url: 'https://core.example.com/api/webhooks/whatsapp',
      secret: 'retry-secret',
      enabled: true,
    });

    // Create a failed log
    const failedLog = await prisma.webhookLog.create({
      data: {
        sessionId: 'tenant-retry-session-1',
        event: 'message.inbound',
        payload: { from: '8801700000000', text: 'Retry me please' },
        statusCode: 503,
        attempts: 4,
        success: false,
        error: 'Service Unavailable',
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/retry/${failedLog.id}`,
      headers: { 'x-api-key': TEST_KEY },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.data.logId).toBe(failedLog.id);
    expect(body.data.sessionId).toBe('tenant-retry-session-1');
    expect(body.data.jobId).toBeDefined();
  });

  it('POST /api/v1/webhooks/retry/:logId should return 404 for non-existent log', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/retry/non-existent-log-id-999',
      headers: { 'x-api-key': TEST_KEY },
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('GET /api/v1/webhooks/logs should return all webhook logs with filters', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/webhooks/logs?limit=10',
      headers: { 'x-api-key': TEST_KEY },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.logs)).toBe(true);
  });
});
