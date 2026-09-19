import { fetchLatestBaileysVersion, WAVersion } from '@whiskeysockets/baileys';
import type Redis from 'ioredis';
import { logger } from './logger.js';

export interface ProtocolVersionInfo {
  version: WAVersion;
  isLatest: boolean;
  source: 'memory' | 'redis' | 'remote' | 'fallback';
  fetchedAt: number;
}

// Fallback safe WhatsApp Web protocol version
const DEFAULT_FALLBACK_VERSION: WAVersion = [2, 3000, 1015901307];
const VERSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REDIS_CACHE_KEY = 'wa:protocol:version';

let inMemoryVersionCache: ProtocolVersionInfo | null = null;

/**
 * Returns the resolved WhatsApp Web protocol version for socket initialization.
 *
 * Implements 24-hour caching in Redis and memory to avoid redundant GitHub / npm lookups
 * across multi-tenant session boots. Logs a warning if the protocol version is not the latest.
 */
export async function getWhatsAppVersion(redisClient?: Redis | null): Promise<ProtocolVersionInfo> {
  const now = Date.now();

  // 1. Check in-memory cache
  if (inMemoryVersionCache && now - inMemoryVersionCache.fetchedAt < VERSION_CACHE_TTL_MS) {
    return {
      ...inMemoryVersionCache,
      source: 'memory',
    };
  }

  // 2. Check Redis cache if available
  if (redisClient) {
    try {
      const cached = await redisClient.get(REDIS_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed?.version && Array.isArray(parsed.version) && parsed.version.length === 3) {
          inMemoryVersionCache = {
            version: parsed.version as WAVersion,
            isLatest: !!parsed.isLatest,
            source: 'redis',
            fetchedAt: parsed.fetchedAt || now,
          };
          logger.debug(
            { version: inMemoryVersionCache.version.join('.') },
            '[VersionGuard] Rehydrated WhatsApp protocol version from Redis cache'
          );
          return inMemoryVersionCache;
        }
      }
    } catch (redisErr: any) {
      logger.debug(
        { err: redisErr.message },
        '[VersionGuard] Note reading version cache from Redis'
      );
    }
  }

  // 3. Fetch latest version from Baileys upstream
  try {
    logger.info('[VersionGuard] Fetching latest WhatsApp Web protocol version from upstream...');
    const result = await fetchLatestBaileysVersion();
    const version = result.version || DEFAULT_FALLBACK_VERSION;
    const isLatest = result.isLatest ?? true;

    const info: ProtocolVersionInfo = {
      version,
      isLatest,
      source: 'remote',
      fetchedAt: now,
    };

    inMemoryVersionCache = info;

    if (!isLatest) {
      logger.warn(
        { version: version.join('.'), isLatest },
        '[VersionGuard] WhatsApp protocol version is behind latest upstream version. Consider updating dependencies.'
      );
    } else {
      logger.info(
        { version: version.join('.'), isLatest },
        '[VersionGuard] WhatsApp Web protocol version resolved and synchronized'
      );
    }

    // Cache in Redis for 24 hours (86400 seconds)
    if (redisClient) {
      try {
        await redisClient.set(
          REDIS_CACHE_KEY,
          JSON.stringify({
            version,
            isLatest,
            fetchedAt: now,
          }),
          'EX',
          86400
        );
      } catch (cacheErr: any) {
        logger.warn(
          { err: cacheErr.message },
          '[VersionGuard] Failed to save protocol version in Redis cache'
        );
      }
    }

    return info;
  } catch (fetchErr: any) {
    logger.warn(
      { err: fetchErr.message },
      '[VersionGuard] Failed to fetch latest WhatsApp version from remote; applying fallback'
    );

    // If we have an existing cache (even if older than 24h), use it as a resilient fallback
    if (inMemoryVersionCache) {
      return inMemoryVersionCache;
    }

    const fallbackInfo: ProtocolVersionInfo = {
      version: DEFAULT_FALLBACK_VERSION,
      isLatest: true,
      source: 'fallback',
      fetchedAt: now,
    };
    inMemoryVersionCache = fallbackInfo;
    return fallbackInfo;
  }
}

/**
 * Returns currently cached version information synchronously if available.
 */
export function getCachedWhatsAppVersion(): ProtocolVersionInfo | null {
  return inMemoryVersionCache;
}
