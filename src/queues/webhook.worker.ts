import crypto from 'crypto';
import { Worker, Job } from 'bullmq';
import { prisma } from '../services/db.service.js';
import { logger } from '../utils/logger.js';
import type { WebhookJobPayload } from './webhook.queue.js';

export interface WebhookJobData {
  id?: string;
  attemptsMade: number;
  opts?: { attempts?: number };
  data: WebhookJobPayload;
}

/**
 * Core processor for webhook dispatch jobs.
 * Signs payloads with HMAC-SHA256, applies timeout guards, and tracks database audit logs.
 */
export const processWebhookJob = async (job: WebhookJobData | Job<WebhookJobPayload>) => {
  const { sessionId, targetUrl, secret, token, event, data, timestamp, logId } = job.data;

  const payloadBody = JSON.stringify({
    event,
    sessionId,
    timestamp,
    data,
  });

  // 1. Generate Cryptographic HMAC-SHA256 Signature
  const signature = crypto
    .createHmac('sha256', secret || '')
    .update(payloadBody)
    .digest('hex');

  // 2. HTTP POST with timeout guard (8000ms)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Botla-WhatsApp-Gateway/1.2',
    'X-Signature-256': `sha256=${signature}`,
    'X-Gateway-Signature-256': `sha256=${signature}`,
    'X-Botla-Signature': `sha256=${signature}`,
    'X-Gateway-Event': event,
    'X-Delivery-Attempt': String((job.attemptsMade || 0) + 1),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: payloadBody,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Target returned non-2xx status: ${response.status} ${response.statusText}`);
    }

    // 3. Record successful dispatch in Database
    if (logId) {
      try {
        await prisma.webhookLog.update({
          where: { id: logId },
          data: {
            statusCode: response.status,
            attempts: (job.attemptsMade || 0) + 1,
            success: true,
            error: null,
          },
        });
      } catch {
        // In case logId was already purged or fallback is used
        await prisma.webhookLog.create({
          data: {
            sessionId,
            event,
            payload: JSON.parse(payloadBody),
            statusCode: response.status,
            attempts: (job.attemptsMade || 0) + 1,
            success: true,
          },
        });
      }
    } else {
      await prisma.webhookLog.create({
        data: {
          sessionId,
          event,
          payload: JSON.parse(payloadBody),
          statusCode: response.status,
          attempts: (job.attemptsMade || 0) + 1,
          success: true,
        },
      });
    }

    logger.info(
      {
        sessionId,
        event,
        targetUrl,
        statusCode: response.status,
        attempt: (job.attemptsMade || 0) + 1,
      },
      '[WebhookWorker] Outbound webhook payload delivered successfully'
    );

    return { statusCode: response.status, success: true };
  } catch (err: any) {
    clearTimeout(timeoutId);
    logger.warn(
      {
        sessionId,
        event,
        targetUrl,
        attempt: (job.attemptsMade || 0) + 1,
        err: err.message,
      },
      `[WebhookWorker] Webhook delivery attempt failed: ${err.message}`
    );
    throw err; // Trigger BullMQ retry backoff
  }
};

let activeWebhookWorker: Worker<WebhookJobPayload> | null = null;

/**
 * Initializes BullMQ Webhook Dispatch Worker with concurrency and Dead-Letter Queue (DLQ) listener.
 */
export const initWebhookWorker = (connection: any) => {
  if (activeWebhookWorker) {
    return activeWebhookWorker;
  }

  try {
    activeWebhookWorker = new Worker<WebhookJobPayload>(
      'webhook_dispatch_queue',
      async (job: Job<WebhookJobPayload>) => {
        return processWebhookJob(job);
      },
      {
        connection,
        concurrency: 5, // Concurrent webhook deliveries
      }
    );

    // DLQ (Dead-Letter Queue) Event Listener
    activeWebhookWorker.on('failed', async (job, err) => {
      if (!job) return;

      const maxAttempts = job.opts?.attempts || 4;
      const isExhausted = job.attemptsMade >= maxAttempts;

      logger.warn(
        {
          jobId: job.id,
          sessionId: job.data.sessionId,
          event: job.data.event,
          attemptsMade: job.attemptsMade,
          maxAttempts,
          isExhausted,
          err: err.message,
        },
        `[WebhookWorker] Webhook job failed (attempt ${job.attemptsMade}/${maxAttempts})`
      );

      if (isExhausted) {
        // Job has exhausted all retries -> permanently failed (DLQ reached)
        try {
          if (job.data.logId) {
            await prisma.webhookLog.update({
              where: { id: job.data.logId },
              data: {
                attempts: job.attemptsMade,
                success: false,
                error: err.message || 'Exhausted maximum retry attempts',
              },
            });
          } else {
            await prisma.webhookLog.create({
              data: {
                sessionId: job.data.sessionId,
                event: job.data.event,
                payload: job.data.data,
                attempts: job.attemptsMade,
                success: false,
                error: err.message || 'Exhausted maximum retry attempts',
              },
            });
          }

          logger.error(
            {
              jobId: job.id,
              sessionId: job.data.sessionId,
              event: job.data.event,
              attempts: job.attemptsMade,
            },
            '[WebhookWorker] Webhook dispatch exhausted maximum retries. Moved to Dead-Letter Queue (DLQ).'
          );
        } catch (dbErr: any) {
          logger.error(
            { err: dbErr.message },
            '[WebhookWorker] Failed to write DLQ failure audit record to database'
          );
        }
      }
    });

    activeWebhookWorker.on('completed', (job) => {
      logger.info(
        { jobId: job.id, sessionId: job.data.sessionId, event: job.data.event },
        '[WebhookWorker] Webhook job completed successfully'
      );
    });

    logger.info('[WebhookWorker] BullMQ Webhook Dispatch Worker initialized');
  } catch (err: any) {
    logger.debug({ err: err.message }, '[WebhookWorker] BullMQ worker initialization handled');
  }

  return activeWebhookWorker;
};

/**
 * Closes the active Webhook worker cleanly on shutdown.
 */
export const closeWebhookWorker = async () => {
  if (activeWebhookWorker) {
    try {
      await activeWebhookWorker.close();
      activeWebhookWorker = null;
      logger.info('[WebhookWorker] Webhook worker stopped cleanly');
    } catch {
      // ignore
    }
  }
};
