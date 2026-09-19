import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { processWebhookJob, initWebhookWorker, closeWebhookWorker } from '../../src/queues/webhook.worker.js';
import { prisma } from '../../src/services/db.service.js';

describe('Webhook Worker Processor & HMAC Signer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await closeWebhookWorker();
  });

  it('should sign payload with HMAC-SHA256, attach required headers, and record success audit in DB', async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = '';

    global.fetch = vi.fn().mockImplementation(async (url, init) => {
      capturedHeaders = init.headers;
      capturedBody = init.body;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
      };
    });

    const secret = 'super-secret-botla-key';
    const jobData = {
      id: 'job-wh-100',
      attemptsMade: 0,
      data: {
        sessionId: 'tenant-hmac-1',
        targetUrl: 'https://core.botla.ai/api/webhooks/whatsapp',
        secret,
        token: 'bearer-token-abc',
        event: 'message.inbound',
        data: {
          from: '8801995329555',
          text: 'HMAC signature test message',
        },
        timestamp: '2026-09-19T20:00:00.000Z',
      },
    };

    const result = await processWebhookJob(jobData);
    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);

    // Verify HMAC-SHA256 Signature
    const expectedSig = crypto.createHmac('sha256', secret).update(capturedBody).digest('hex');
    expect(capturedHeaders['X-Signature-256']).toBe(`sha256=${expectedSig}`);
    expect(capturedHeaders['X-Botla-Signature']).toBe(`sha256=${expectedSig}`);
    expect(capturedHeaders['X-Gateway-Event']).toBe('message.inbound');
    expect(capturedHeaders['X-Delivery-Attempt']).toBe('1');
    expect(capturedHeaders['Authorization']).toBe('Bearer bearer-token-abc');

    // Verify database log entry was created
    const log = await prisma.webhookLog.findFirst({
      where: { sessionId: 'tenant-hmac-1' },
      orderBy: { createdAt: 'desc' },
    });
    expect(log).toBeDefined();
    expect(log?.event).toBe('message.inbound');
    expect(log?.success).toBe(true);
    expect(log?.statusCode).toBe(200);
  });

  it('should throw error when target responds with non-2xx status code', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
    });

    const jobData = {
      id: 'job-wh-fail-1',
      attemptsMade: 1,
      data: {
        sessionId: 'tenant-err-1',
        targetUrl: 'https://core.botla.ai/api/webhooks/whatsapp',
        secret: 'test-secret',
        event: 'message.inbound',
        data: { text: 'Will fail' },
        timestamp: new Date().toISOString(),
      },
    };

    await expect(processWebhookJob(jobData)).rejects.toThrow(/Target returned non-2xx status: 502/);
  });
});
