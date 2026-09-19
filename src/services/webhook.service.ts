/**
 * Inbound Webhook Relay Service
 * Signs and dispatches WhatsApp event payloads to the Botla Core Laravel application.
 */
import crypto from 'crypto';
import { config } from '../config/env.js';
import { createSessionLogger, logger } from '../utils/logger.js';
import type { WebhookPayload } from '../types/message.types.js';

export class WebhookService {
  /**
   * Asynchronously posts an inbound message or ACK status payload to Botla's Laravel webhook.
   * Signs the payload using HMAC-SHA256 if WEBHOOK_SECRET is set.
   */
  public static async dispatch(
    payload: WebhookPayload | Record<string, any>,
    onDispatched?: (event: 'dispatched' | 'failed', details: Record<string, any>) => void
  ): Promise<boolean> {
    const webhookUrl = config.botlaWebhookUrl;
    const sessionLog = payload.sessionId ? createSessionLogger(payload.sessionId) : logger;

    if (!webhookUrl) {
      sessionLog.warn('[Webhook] No BOTLA_WEBHOOK_URL configured; skipping dispatch');
      return false;
    }

    const eventName = (payload as any).event || 'inbound_message';
    const bodyString = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Botla-WhatsApp-Gateway/1.0',
    };

    if (config.webhookSecret) {
      const signature = crypto
        .createHmac('sha256', config.webhookSecret)
        .update(bodyString)
        .digest('hex');
      headers['X-Botla-Signature'] = signature;
      headers['X-Hub-Signature-256'] = `sha256=${signature}`;
    }

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers,
        body: bodyString,
        signal: AbortSignal.timeout(10000), // 10s timeout
      });

      if (!response.ok) {
        throw new Error(`Webhook returned HTTP ${response.status}: ${response.statusText}`);
      }

      sessionLog.info(
        {
          event: eventName,
          url: webhookUrl,
          status: response.status,
        },
        '[Webhook] Payload successfully delivered to Laravel webhook'
      );

      if (onDispatched) {
        onDispatched('dispatched', {
          url: webhookUrl,
          event: eventName,
          statusCode: response.status,
        });
      }

      return true;
    } catch (err: any) {
      sessionLog.error(
        {
          event: eventName,
          url: webhookUrl,
          error: err.message,
          stack: err.stack,
        },
        '[Webhook] Failed to deliver payload to webhook'
      );

      if (onDispatched) {
        onDispatched('failed', {
          url: webhookUrl,
          event: eventName,
          error: err.message,
        });
      }

      return false;
    }
  }
}
