/**
 * Inbound Webhook Relay Service
 * Signs and dispatches WhatsApp event payloads to the Botla Core Laravel application.
 * Supports dynamic global & tenant-level overrides, event filtering, and exponential backoff retries.
 */
import crypto from 'crypto';
import { config } from '../config/env.js';
import { getRedisClient } from '../config/redis.js';
import { createSessionLogger, logger } from '../utils/logger.js';
import type { WebhookPayload } from '../types/message.types.js';

export interface WebhookConfig {
  url: string;
  secret: string;
  token: string;
  enabled: boolean;
  events: {
    inbound: boolean;
    ack: boolean;
    status: boolean;
  };
  retryStats: {
    totalSent: number;
    successCount: number;
    failCount: number;
    lastAttempt: string | null;
    lastSuccess: string | null;
    lastError: string | null;
  };
}

const GLOBAL_WEBHOOK_KEY = 'wa:settings:webhook';

export class WebhookService {
  /**
   * Get global webhook config from Redis or fallback to env.
   */
  public static async getGlobalConfig(): Promise<WebhookConfig & { source: 'global' | 'env' }> {
    try {
      const redis = await getRedisClient();
      const raw = await redis.get(GLOBAL_WEBHOOK_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          url: parsed.url ?? config.botlaWebhookUrl,
          secret: parsed.secret ?? config.webhookSecret,
          token: parsed.token ?? config.webhookToken,
          enabled: parsed.enabled ?? false,
          events: {
            inbound: parsed.events?.inbound ?? true,
            ack: parsed.events?.ack ?? true,
            status: parsed.events?.status ?? true,
          },
          retryStats: parsed.retryStats ?? {
            totalSent: 0,
            successCount: 0,
            failCount: 0,
            lastAttempt: null,
            lastSuccess: null,
            lastError: null,
          },
          source: 'global',
        };
      }
    } catch (err: any) {
      logger.debug({ err: err.message }, '[WebhookService] Failed to load global webhook config from Redis');
    }

    return {
      url: config.botlaWebhookUrl,
      secret: config.webhookSecret,
      token: config.webhookToken,
      enabled: false,
      events: { inbound: true, ack: true, status: true },
      retryStats: { totalSent: 0, successCount: 0, failCount: 0, lastAttempt: null, lastSuccess: null, lastError: null },
      source: 'env',
    };
  }

  /**
   * Get session-specific webhook override.
   */
  public static async getSessionConfig(sessionId: string): Promise<WebhookConfig | null> {
    try {
      const redis = await getRedisClient();
      const raw = await redis.get(`wa:session:${sessionId}:webhook`);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          url: parsed.url || '',
          secret: parsed.secret || '',
          token: parsed.token || '',
          enabled: parsed.enabled ?? false,
          events: {
            inbound: parsed.events?.inbound ?? true,
            ack: parsed.events?.ack ?? true,
            status: parsed.events?.status ?? true,
          },
          retryStats: parsed.retryStats ?? {
            totalSent: 0,
            successCount: 0,
            failCount: 0,
            lastAttempt: null,
            lastSuccess: null,
            lastError: null,
          },
        };
      }
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * Resolve active webhook configuration for a given session.
   */
  public static async resolveWebhook(sessionId?: string): Promise<WebhookConfig & { source: 'tenant' | 'global' | 'env' }> {
    if (sessionId) {
      const sessionConfig = await this.getSessionConfig(sessionId);
      if (sessionConfig && sessionConfig.url) {
        const globalConfig = await this.getGlobalConfig();
        return {
          url: sessionConfig.url,
          secret: sessionConfig.secret || globalConfig.secret,
          token: sessionConfig.token || globalConfig.token,
          enabled: sessionConfig.enabled,
          events: sessionConfig.events,
          retryStats: sessionConfig.retryStats,
          source: 'tenant',
        };
      }
    }

    return await this.getGlobalConfig();
  }

  /**
   * Update global webhook configuration in Redis.
   */
  public static async updateGlobalConfig(newConfig: Partial<WebhookConfig>): Promise<WebhookConfig> {
    const current = await this.getGlobalConfig();
    const updated: WebhookConfig = {
      url: newConfig.url !== undefined ? newConfig.url : current.url,
      secret: newConfig.secret !== undefined ? newConfig.secret : current.secret,
      token: newConfig.token !== undefined ? newConfig.token : current.token,
      enabled: newConfig.enabled !== undefined ? newConfig.enabled : current.enabled,
      events: {
        inbound: newConfig.events?.inbound !== undefined ? newConfig.events.inbound : current.events.inbound,
        ack: newConfig.events?.ack !== undefined ? newConfig.events.ack : current.events.ack,
        status: newConfig.events?.status !== undefined ? newConfig.events.status : current.events.status,
      },
      retryStats: current.retryStats,
    };

    const redis = await getRedisClient();
    await redis.set(GLOBAL_WEBHOOK_KEY, JSON.stringify(updated));
    logger.info({ url: updated.url, enabled: updated.enabled }, '[WebhookService] Global webhook configuration updated');
    return updated;
  }

  /**
   * Set or clear tenant-specific webhook configuration.
   */
  public static async setSessionConfig(sessionId: string, newConfig: Partial<WebhookConfig> | null): Promise<void> {
    const redis = await getRedisClient();
    const key = `wa:session:${sessionId}:webhook`;
    if (!newConfig || !newConfig.url) {
      await redis.del(key);
      logger.info({ sessionId }, '[WebhookService] Session webhook override cleared');
    } else {
      const existing = (await this.getSessionConfig(sessionId)) || {
        url: '',
        secret: '',
        token: '',
        enabled: true,
        events: { inbound: true, ack: true, status: true },
        retryStats: { totalSent: 0, successCount: 0, failCount: 0, lastAttempt: null, lastSuccess: null, lastError: null },
      };
      const merged: WebhookConfig = {
        url: newConfig.url,
        secret: newConfig.secret !== undefined ? newConfig.secret : existing.secret,
        token: newConfig.token !== undefined ? newConfig.token : existing.token,
        enabled: newConfig.enabled !== undefined ? newConfig.enabled : existing.enabled,
        events: {
          inbound: newConfig.events?.inbound !== undefined ? newConfig.events.inbound : existing.events.inbound,
          ack: newConfig.events?.ack !== undefined ? newConfig.events.ack : existing.events.ack,
          status: newConfig.events?.status !== undefined ? newConfig.events.status : existing.events.status,
        },
        retryStats: existing.retryStats,
      };
      await redis.set(key, JSON.stringify(merged));
      logger.info({ sessionId, url: merged.url }, '[WebhookService] Session webhook override saved');
    }
  }

  /**
   * Update retry stats in Redis for global and session.
   */
  private static async updateStats(sessionId: string | undefined, success: boolean, errorMsg?: string): Promise<void> {
    try {
      const redis = await getRedisClient();
      const now = new Date().toISOString();
      if (sessionId) {
        const key = `wa:session:${sessionId}:webhook`;
        const raw = await redis.get(key);
        if (raw) {
          const cfg = JSON.parse(raw);
          cfg.retryStats = cfg.retryStats || { totalSent: 0, successCount: 0, failCount: 0, lastAttempt: null, lastSuccess: null, lastError: null };
          cfg.retryStats.totalSent++;
          cfg.retryStats.lastAttempt = now;
          if (success) {
            cfg.retryStats.successCount++;
            cfg.retryStats.lastSuccess = now;
          } else {
            cfg.retryStats.failCount++;
            cfg.retryStats.lastError = errorMsg || 'Unknown error';
          }
          await redis.set(key, JSON.stringify(cfg));
        }
      }
      const globalRaw = await redis.get(GLOBAL_WEBHOOK_KEY);
      if (globalRaw) {
        const gCfg = JSON.parse(globalRaw);
        gCfg.retryStats = gCfg.retryStats || { totalSent: 0, successCount: 0, failCount: 0, lastAttempt: null, lastSuccess: null, lastError: null };
        gCfg.retryStats.totalSent++;
        gCfg.retryStats.lastAttempt = now;
        if (success) {
          gCfg.retryStats.successCount++;
          gCfg.retryStats.lastSuccess = now;
        } else {
          gCfg.retryStats.failCount++;
          gCfg.retryStats.lastError = errorMsg || 'Unknown error';
        }
        await redis.set(GLOBAL_WEBHOOK_KEY, JSON.stringify(gCfg));
      }
    } catch {
      // ignore
    }
  }

  /**
   * Asynchronously posts payload to webhook with exponential backoff retry (up to 3 attempts: 1s, 3s, 9s).
   */
  public static async dispatch(
    payload: WebhookPayload | Record<string, any>,
    onDispatched?: (event: 'dispatched' | 'failed', details: Record<string, any>) => void
  ): Promise<boolean> {
    const sessionId = (payload as any).sessionId;
    const active = await this.resolveWebhook(sessionId);
    const sessionLog = sessionId ? createSessionLogger(sessionId) : logger;

    if (!active.enabled) {
      return false;
    }

    if (!active.url) {
      sessionLog.warn('[Webhook] No webhook URL configured; skipping dispatch');
      return false;
    }

    const eventName = (payload as any).event || ((payload as any).message ? 'inbound_message' : 'session_event');
    if (eventName === 'inbound_message' && !active.events.inbound) return false;
    if (eventName === 'message.ack' && !active.events.ack) return false;
    if (eventName === 'session_event' && !active.events.status) return false;

    const bodyString = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Botla-WhatsApp-Gateway/1.2',
    };

    if (active.token) {
      headers['Authorization'] = `Bearer ${active.token}`;
    }

    if (active.secret) {
      const signature = crypto
        .createHmac('sha256', active.secret)
        .update(bodyString)
        .digest('hex');
      headers['X-Botla-Signature'] = signature;
      headers['X-Hub-Signature-256'] = `sha256=${signature}`;
    }

    const maxRetries = 3;
    const backoffDelays = [1000, 3000, 9000];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(active.url, {
          method: 'POST',
          headers,
          body: bodyString,
          signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) {
          throw new Error(`Webhook returned HTTP ${response.status}: ${response.statusText}`);
        }

        sessionLog.info(
          { event: eventName, url: active.url, status: response.status, attempt: attempt + 1 },
          '[Webhook] Payload successfully delivered to webhook'
        );

        await this.updateStats(sessionId, true);

        if (onDispatched) {
          onDispatched('dispatched', {
            url: active.url,
            event: eventName,
            statusCode: response.status,
            attempt: attempt + 1,
          });
        }
        return true;
      } catch (err: any) {
        const isLastAttempt = attempt === maxRetries;
        if (!isLastAttempt) {
          const delay = backoffDelays[attempt] || 3000;
          sessionLog.warn(
            { err: err.message, attempt: attempt + 1, retryInMs: delay },
            `[Webhook] Dispatch failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms...`
          );
          await new Promise((res) => setTimeout(res, delay));
          continue;
        }

        const isDefaultLocalUrl = active.url.includes('127.0.0.1:8000') || active.url.includes('localhost:8000');
        const logMethod = isDefaultLocalUrl ? 'warn' : 'error';
        const logMsg = isDefaultLocalUrl
          ? `[Webhook] Webhook receiver at ${active.url} unreachable or returned error (${err.message}).`
          : '[Webhook] Failed to deliver payload to webhook after max retries';

        sessionLog[logMethod](
          { event: eventName, url: active.url, error: err.message, attempts: maxRetries + 1 },
          logMsg
        );

        await this.updateStats(sessionId, false, err.message);

        if (onDispatched) {
          onDispatched('failed', {
            url: active.url,
            event: eventName,
            error: err.message,
            attempts: maxRetries + 1,
          });
        }
        return false;
      }
    }
    return false;
  }

  /**
   * Test ping tool.
   */
  public static async testPing(
    targetUrl?: string,
    secret?: string,
    token?: string,
    sessionId?: string
  ): Promise<{ success: boolean; statusCode?: number; headers?: Record<string, string>; latencyMs: number; error?: string }> {
    const active = await this.resolveWebhook(sessionId);
    const url = targetUrl || active.url;
    const hmacSecret = secret !== undefined ? secret : active.secret;
    const bearerToken = token !== undefined ? token : active.token;

    if (!url) {
      return { success: false, latencyMs: 0, error: 'No webhook URL provided' };
    }

    const testPayload = {
      event: 'webhook_ping',
      timestamp: new Date().toISOString(),
      gateway: 'Botla-WhatsApp-Gateway',
      sessionId: sessionId || 'global-ping',
    };
    const bodyString = JSON.stringify(testPayload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Botla-WhatsApp-Gateway-Ping/1.2',
    };

    if (bearerToken) {
      headers['Authorization'] = `Bearer ${bearerToken}`;
    }

    if (hmacSecret) {
      const signature = crypto
        .createHmac('sha256', hmacSecret)
        .update(bodyString)
        .digest('hex');
      headers['X-Botla-Signature'] = signature;
      headers['X-Hub-Signature-256'] = `sha256=${signature}`;
    }

    const startTime = Date.now();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: bodyString,
        signal: AbortSignal.timeout(8000),
      });
      const latencyMs = Date.now() - startTime;
      const respHeaders: Record<string, string> = {};
      response.headers.forEach((val, key) => {
        respHeaders[key] = val;
      });

      return {
        success: response.ok,
        statusCode: response.status,
        headers: respHeaders,
        latencyMs,
        error: response.ok ? undefined : `HTTP ${response.status}: ${response.statusText}`,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      return {
        success: false,
        latencyMs,
        error: err.message || 'Connection timeout or network failure',
      };
    }
  }
}
