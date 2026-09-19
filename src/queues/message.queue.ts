import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { processOutboundJob } from './message.worker.js';

export interface OutboundMessageJob {
  sessionId: string;
  to: string;
  type: 'text' | 'media';
  message?: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'video' | 'audio' | 'document';
  caption?: string;
  fileName?: string;
  presence?: boolean;
}

const redisUrl = process.env.REDIS_URL || config.redisUrl || 'redis://127.0.0.1:6379';

export const redisConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
  connectTimeout: 1000,
  retryStrategy(times) {
    if (times > 2) return null;
    return 500;
  },
});

redisConnection.on('error', (err) => {
  logger.debug({ err: err.message }, '[MessageQueue] Redis connection event');
});

export const messageQueue = new Queue<OutboundMessageJob>('outbound_messages', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: 500,
    removeOnFail: 1000,
  },
});

messageQueue.on('error', (err) => {
  logger.debug({ err: err.message }, '[MessageQueue] BullMQ queue event');
});

let fallbackJobCounter = 0;

export const enqueueMessageJob = async (
  name: string,
  data: OutboundMessageJob
): Promise<{ id: string }> => {
  try {
    const job = await messageQueue.add(name, data);
    return { id: String(job?.id || ++fallbackJobCounter) };
  } catch (err: any) {
    logger.debug(
      { err: err.message, name, sessionId: data.sessionId },
      '[MessageQueue] BullMQ add offline/fallback; queueing in-memory job'
    );
    const id = String(++fallbackJobCounter);
    setTimeout(async () => {
      try {
        await processOutboundJob({
          id,
          attemptsMade: 0,
          data,
        });
      } catch (procErr: any) {
        logger.debug(
          { err: procErr.message, id, sessionId: data.sessionId },
          '[MessageQueue] In-memory job execution handled'
        );
      }
    }, 10);
    return { id };
  }
};
