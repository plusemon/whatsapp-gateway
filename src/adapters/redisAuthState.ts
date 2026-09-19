/**
 * Custom Redis-backed Baileys AuthState Adapter
 *
 * Implements persistent multi-tenant session storage for Baileys inside Redis:
 * - Credentials: `wa:session:${sessionId}:creds`
 * - Individual Keys: `wa:session:${sessionId}:${category}:${id}`
 * - Safe BufferJSON serialization / deserialization
 * - Handles proto.Message.AppStateSyncKeyData rehydration for 'app-state-sync-key'
 */
import {
  AuthenticationCreds,
  AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import type Redis from 'ioredis';

export interface RedisAuthStateResult {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}

/**
 * Custom Redis-backed Baileys AuthState adapter.
 */
export async function useRedisAuthState(
  redisClient: Redis,
  sessionId: string
): Promise<RedisAuthStateResult> {
  const credsKey = `wa:session:${sessionId}:creds`;
  const getKey = (category: string, id: string) => `wa:session:${sessionId}:${category}:${id}`;

  /**
   * Reads and deserializes JSON from Redis using Baileys BufferJSON reviver.
   */
  const readData = async (key: string): Promise<any> => {
    try {
      const data = await redisClient.get(key);
      if (!data) return null;
      return JSON.parse(data, BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  /**
   * Serializes and writes data to Redis using Baileys BufferJSON replacer.
   */
  const writeData = async (key: string, value: any): Promise<void> => {
    try {
      const serialized = JSON.stringify(value, BufferJSON.replacer);
      await redisClient.set(key, serialized);
    } catch (err) {
      throw err;
    }
  };

  /**
   * Deletes a key from Redis.
   */
  const removeData = async (key: string): Promise<void> => {
    try {
      await redisClient.del(key);
    } catch {
      // Ignore key not found
    }
  };

  // 1. Rehydrate existing credentials or initialize new credentials for the session
  const storedCreds = await readData(credsKey);
  const creds: AuthenticationCreds = storedCreds || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(
          type: T,
          ids: string[]
        ): Promise<{ [key: string]: SignalDataTypeMap[T] }> => {
          const data: { [key: string]: SignalDataTypeMap[T] } = {};

          await Promise.all(
            ids.map(async (id) => {
              const key = getKey(type, id);
              let value = await readData(key);

              // AppStateSyncKeyData deserialization
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }

              data[id] = value;
            })
          );

          return data;
        },

        set: async (data: any): Promise<void> => {
          const tasks: Promise<void>[] = [];

          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = getKey(category, id);

              if (value) {
                tasks.push(writeData(key, value));
              } else {
                tasks.push(removeData(key));
              }
            }
          }

          await Promise.all(tasks);
        },
      },
    },

    /**
     * Persists the current session credentials to Redis
     */
    saveCreds: async (): Promise<void> => {
      await writeData(credsKey, creds);
    },
  };
}

/**
 * Purges all Redis state associated with a given tenant sessionId.
 * Scans and removes `wa:session:${sessionId}:*` keys.
 */
export async function clearRedisSession(
  redisClient: Redis,
  sessionId: string
): Promise<number> {
  try {
    const pattern = `wa:session:${sessionId}:*`;
    const keys = await redisClient.keys(pattern);

    if (keys && keys.length > 0) {
      await redisClient.del(...keys);
      return keys.length;
    }
    return 0;
  } catch {
    // Fallback direct cleanup of primary keys
    await redisClient.del(
      `wa:session:${sessionId}:creds`,
      `wa:session:${sessionId}:qr`
    );
    return 1;
  }
}
