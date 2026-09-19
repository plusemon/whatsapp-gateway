import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { processWebhookJob } from './webhook.worker.js';

export interface WebhookJobPayload {
  logId?: string;
  sessionId: string;
  targetUrl: string;
  secret: string;
  token?: string;
  event: 'message.inbound' | 'message.ack' | 'session.status' | string;
  data: Record<string, any>;
  timestamp: string;
}

const redisUrl = process.env.REDIS_URL || config.redisUrl || 'redis://127.0.0.1:6379';

export const webhookRedisConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
  connectTimeout: 1000,
  retryStrategy(times) {
    if (times > 2) return null;
    return 500;
  },
});

webhookRedisConnection.on('error', (err) => {
  logger.debug({ err: err.message }, '[WebhookQueue] Redis connection event');
});

export const webhookQueue = new Queue<WebhookJobPayload>('webhook_dispatch_queue', {
  connection: webhookRedisConnection,
  defaultJobOptions: {
    attempts: 4,
    backoff: {
      type: 'exponential',
      delay: 3000, // 3s, 6s, 12s, 24s
    },
    removeOnComplete: 200,
    removeOnFail: false, // Keep in failed set for Dead-Letter Queue (DLQ) tracking
  },
});

webhookQueue.on('error', (err) => {
  logger.debug({ err: err.message }, '[WebhookQueue] BullMQ queue event');
});

let fallbackJobCounter = 0;

/**
 * Enqueues a webhook event payload into the BullMQ webhook dispatch queue.
 * Includes automatic non-blocking in-memory fallback execution if Redis daemon is absent.
 */
export const enqueueWebhookJob = async (
  name: string,
  data: WebhookJobPayload
): Promise<{ id: string }> => {
  try {
    const job = await webhookQueue.add(name, data);
    return { id: String(job?.id || ++fallbackJobCounter) };
  } catch (err: any) {
    logger.debug(
      { err: err.message, name, sessionId: data.sessionId },
      '[WebhookQueue] BullMQ offline/fallback; executing in-memory webhook dispatch'
    );
    const id = String(++fallbackJobCounter);
    setTimeout(async () => {
      try {
        await processWebhookJob({
          id,
          attemptsMade: 0,
          data,
        });
      } catch (procErr: any) {
        logger.debug(
          { err: procErr.message, id, sessionId: data.sessionId },
          '[WebhookQueue] In-memory job execution handled'
        );
      }
    }, 10);
    return { id };
  }
};
