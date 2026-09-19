/**
 * Centralized Redis Client Manager
 * Provides durable persistence connection with resilient in-memory fallback.
 */
import net from 'net';
import Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import { logger } from '../utils/logger.js';
import { config } from './env.js';

let redisInstance: Redis | null = null;
let isMockRedis = false;

/**
 * Checks if a TCP socket can connect to the target Redis host and port within a timeout.
 */
export function canConnectToRedis(url: string, timeoutMs = 800): Promise<boolean> {
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
 * Returns a configured Redis client instance.
 * Probes the configured REDIS_URL first with automatic, non-blocking fallback
 * to an in-memory Redis adapter if the remote daemon is unavailable.
 */
export async function getRedisClient(): Promise<Redis> {
  if (redisInstance) {
    return redisInstance;
  }

  // Check if explicit mock requested via environment
  if (process.env.USE_MOCK_REDIS === 'true') {
    logger.info('[Redis] USE_MOCK_REDIS is set. Operating with in-memory Redis adapter.');
    redisInstance = new (RedisMock as unknown as typeof Redis)();
    isMockRedis = true;
    return redisInstance;
  }

  // Pre-probe network availability so startup doesn't stall if Redis daemon is absent
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
 * Returns whether the active Redis instance is the in-memory fallback mock.
 */
export function isUsingMockRedis(): boolean {
  return isMockRedis;
}

/**
 * Disconnects the Redis client cleanly during graceful server shutdown.
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
