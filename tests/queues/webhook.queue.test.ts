import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webhookQueue, enqueueWebhookJob, type WebhookJobPayload } from '../../src/queues/webhook.queue.js';

describe('Resilient Webhook Queue Definition & Enqueueing', () => {
  it('should initialize webhook queue with exponential backoff and DLQ retention', () => {
    expect(webhookQueue.name).toBe('webhook_dispatch_queue');
    expect(webhookQueue.defaultJobOptions).toBeDefined();
    expect(webhookQueue.defaultJobOptions?.attempts).toBe(4);
    expect(webhookQueue.defaultJobOptions?.backoff).toEqual({
      type: 'exponential',
      delay: 3000,
    });
    expect(webhookQueue.defaultJobOptions?.removeOnFail).toBe(false);
  });

  it('enqueueWebhookJob should enqueue job payload correctly', async () => {
    const payload: WebhookJobPayload = {
      sessionId: 'tenant-test-wh-1',
      targetUrl: 'https://core.botla.ai/api/webhooks/whatsapp',
      secret: 'secret-key-12345',
      token: 'jwt-bearer-token',
      event: 'message.inbound',
      data: {
        from: '8801995329555',
        text: 'Hello from queue test',
      },
      timestamp: new Date().toISOString(),
    };

    const result = await enqueueWebhookJob('webhook:tenant-test-wh-1:message.inbound', payload);
    expect(result).toBeDefined();
    expect(result.id).toBeDefined();
  });
});
