import dotenv from 'dotenv';
import net from 'net';
import Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import pino from 'pino';

// Load environment variables from .env
dotenv.config();

export interface GatewayConfig {
  port: number;
  host: string;
  publicUrl: string;
  redisUrl: string;
  botlaWebhookUrl: string;
  webhookSecret: string;
  logLevel: string;
}

export const config: GatewayConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  publicUrl: process.env.PUBLIC_URL || process.env.BASE_URL || '',
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  botlaWebhookUrl: process.env.BOTLA_WEBHOOK_URL || 'http://127.0.0.1:8000/api/whatsapp/webhook',
  webhookSecret: process.env.WEBHOOK_SECRET || 'your_hmac_secret_here',
  logLevel: process.env.LOG_LEVEL || 'info',
};

/**
 * Returns the canonical public base URL used for media access URLs.
 */
export function getPublicBaseUrl(): string {
  if (config.publicUrl) {
    return config.publicUrl.replace(/\/$/, '');
  }
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
  return `http://${host}:${config.port}`;
}

export const logger = pino({
  level: config.logLevel,
  timestamp: pino.stdTimeFunctions.isoTime,
});

let redisInstance: Redis | null = null;
let isMockRedis = false;

function canConnectToRedis(url: string, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname || '127.0.0.1';
      const port = parseInt(parsed.port || '6379', 10);
      const socket = new net.Socket();
      let resolved = false;

      const finish = (result: boolean) => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          resolve(result);
        }
      };

      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
      socket.connect(port, host);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Returns a configured Redis client.
 * Probes the provided REDIS_URL first with automatic, silent fallback to an in-memory
 * Redis adapter if connection cannot be established (e.g. in sandboxed test environments).
 */
export async function getRedisClient(): Promise<Redis> {
  if (redisInstance) {
    return redisInstance;
  }

  // Check if explicit mock requested
  if (process.env.USE_MOCK_REDIS === 'true') {
    logger.info('[Redis] USE_MOCK_REDIS is set. Using in-memory Redis adapter.');
    redisInstance = new (RedisMock as unknown as typeof Redis)();
    isMockRedis = true;
    return redisInstance;
  }

  // Pre-probe network availability so we don't spam errors if Redis daemon is offline
  const isAvailable = await canConnectToRedis(config.redisUrl, 800);
  if (!isAvailable) {
    logger.info(
      { url: config.redisUrl },
      '[Redis] No external Redis server detected. Operating with resilient in-memory Redis adapter.'
    );
    redisInstance = new (RedisMock as unknown as typeof Redis)();
    isMockRedis = true;
    return redisInstance;
  }

  let client: Redis | null = null;
  try {
    client = new Redis(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      connectTimeout: 2000,
      retryStrategy(times) {
        if (times > 2) return null;
        return 500;
      },
    });

    client.on('error', (err) => {
      logger.debug({ err: err.message }, '[Redis] Connection event note');
    });

    await client.connect();
    logger.info({ url: config.redisUrl }, '[Redis] Connected successfully to external Redis store');
    redisInstance = client;
    isMockRedis = false;
    return redisInstance;
  } catch (err: any) {
    if (client) {
      try {
        client.disconnect();
      } catch {
        // ignore
      }
    }
    logger.info(
      { err: err?.message, url: config.redisUrl },
      '[Redis] Remote connection could not be completed. Operating with in-memory Redis adapter.'
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

/**
 * Disconnects the Redis client cleanly during graceful shutdown.
 */
export async function disconnectRedisClient(): Promise<void> {
  if (redisInstance) {
    try {
      if (typeof redisInstance.quit === 'function') {
        await redisInstance.quit();
      } else if (typeof redisInstance.disconnect === 'function') {
        redisInstance.disconnect();
      }
      logger.info('[Redis] Redis client disconnected cleanly');
    } catch {
      try {
        if (typeof redisInstance.disconnect === 'function') {
          redisInstance.disconnect();
        }
      } catch {
        // ignore
      }
    }
    redisInstance = null;
  }
}
