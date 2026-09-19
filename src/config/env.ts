/**
 * Validated Environment Configuration
 */
import dotenv from 'dotenv';

// Load environment variables from .env if present
dotenv.config();

export interface GatewayConfig {
  port: number;
  host: string;
  publicUrl: string;
  redisUrl: string;
  botlaWebhookUrl: string;
  webhookSecret: string;
  webhookToken: string;
  webhookEnabled: boolean;
  apiKey: string;
  logLevel: string;
  logRetentionDays: number;
  mediaRetentionHours: number;
  mediaCleanupIntervalHours: number;
}

function parseNumber(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

export const config: GatewayConfig = {
  port: parseNumber(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  publicUrl: process.env.PUBLIC_URL || process.env.BASE_URL || '',
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  botlaWebhookUrl: process.env.BOTLA_WEBHOOK_URL || 'http://127.0.0.1:8000/api/whatsapp/webhook',
  webhookSecret: process.env.WEBHOOK_SECRET || 'your_hmac_secret_here',
  webhookToken: process.env.BOTLA_WEBHOOK_TOKEN || process.env.WEBHOOK_BEARER_TOKEN || '',
  webhookEnabled: process.env.BOTLA_WEBHOOK_ENABLED === 'true' || process.env.WEBHOOK_ENABLED === 'true',
  apiKey: process.env.API_KEY || process.env.GATEWAY_API_KEY || '',
  logLevel: process.env.LOG_LEVEL || 'info',
  logRetentionDays: parseNumber(process.env.LOG_RETENTION_DAYS, 14),
  mediaRetentionHours: parseNumber(process.env.MEDIA_RETENTION_HOURS, 48),
  mediaCleanupIntervalHours: parseNumber(process.env.MEDIA_CLEANUP_INTERVAL_HOURS, 6),
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
