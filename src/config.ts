import dotenv from 'dotenv';
import Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import pino from 'pino';

// Load environment variables from .env
dotenv.config();

export interface GatewayConfig {
  port: number;
  host: string;
  redisUrl: string;
  botlaWebhookUrl: string;
  webhookSecret: string;
  logLevel: string;
}

export const config: GatewayConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  botlaWebhookUrl: process.env.BOTLA_WEBHOOK_URL || 'http://127.0.0.1:8000/api/whatsapp/webhook',
  webhookSecret: process.env.WEBHOOK_SECRET || 'your_hmac_secret_here',
  logLevel: process.env.LOG_LEVEL || 'info',
};

export const logger = pino({
  level: config.logLevel,
  timestamp: pino.stdTimeFunctions.isoTime,
});

let redisInstance: Redis | null = null;
let isMockRedis = false;

/**
 * Returns a configured Redis client.
 * Connects to the provided REDIS_URL with automatic fallback to an in-memory
 * Redis adapter if connection cannot be established (e.g. in sandboxed test environments).
 */
export async function getRedisClient(): Promise<Redis> {
  if (redisInstance) {
    return redisInstance;
  }

  // Check if explicit mock requested or attempt live connection
  if (process.env.USE_MOCK_REDIS === 'true') {
    logger.warn('[Redis] USE_MOCK_REDIS is set. Using in-memory RedisMock adapter.');
    redisInstance = new (RedisMock as unknown as typeof Redis)();
    isMockRedis = true;
    return redisInstance;
  }

  try {
    const client = new Redis(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      connectTimeout: 4000,
      retryStrategy(times) {
        if (times > 3) {
          return null; // Stop retrying after 3 attempts
        }
        return Math.min(times * 300, 1500);
      },
    });

    client.on('error', (err) => {
      logger.warn({ err: err.message }, '[Redis] Connection event warning');
    });

    await client.connect();
    logger.info({ url: config.redisUrl }, '[Redis] Connected successfully to Redis store');
    redisInstance = client;
    isMockRedis = false;
    return redisInstance;
  } catch (err: any) {
    logger.warn(
      { err: err.message, url: config.redisUrl },
      '[Redis] Failed to connect to Redis server. Falling back to in-memory Redis adapter for uninterrupted operation.'
    );
    redisInstance = new (RedisMock as unknown as typeof Redis)();
    isMockRedis = true;
    return redisInstance;
  }
}

/**
 * Returns whether the active Redis instance is the fallback mock.
 */
export function isUsingMockRedis(): boolean {
  return isMockRedis;
}
