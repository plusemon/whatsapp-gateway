/**
 * Settings Controller
 * Manages dynamic global & tenant-level webhook configurations and test pings.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { WebhookService, type WebhookConfig } from '../services/webhook.service.js';
import { ResponseUtil } from '../utils/response.util.js';

export class SettingsController {
  /**
   * GET /api/settings/webhook
   */
  public static async getWebhookSettings(
    request: FastifyRequest<{ Querystring: { sessionId?: string } }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    try {
      const sessionId = request.query.sessionId;
      const config = await WebhookService.resolveWebhook(sessionId);
      return ResponseUtil.success(
        reply,
        {
          url: config.url,
          hasSecret: !!config.secret,
          secret: config.secret,
          token: config.token,
          enabled: config.enabled,
          events: config.events,
          retryStats: config.retryStats,
          source: config.source,
          sessionId: sessionId || null,
        },
        200
      );
    } catch (err: any) {
      return ResponseUtil.error(reply, 'Failed to fetch webhook settings', 500, 'SETTINGS_FETCH_FAILED', err.message);
    }
  }

  /**
   * POST /api/settings/webhook
   */
  public static async updateWebhookSettings(
    request: FastifyRequest<{
      Body: {
        url?: string;
        secret?: string;
        token?: string;
        enabled?: boolean;
        events?: { inbound?: boolean; ack?: boolean; status?: boolean };
        sessionId?: string;
      };
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    try {
      const { sessionId, events, ...rest } = request.body || {};
      const payload: Partial<WebhookConfig> = {
        ...rest,
        ...(events
          ? {
              events: {
                inbound: !!events.inbound,
                ack: !!events.ack,
                status: !!events.status,
              },
            }
          : {}),
      };

      if (sessionId) {
        await WebhookService.setSessionConfig(sessionId, payload);
        const updated = await WebhookService.resolveWebhook(sessionId);
        return ResponseUtil.success(reply, { updated, sessionId }, 200, { message: 'Session webhook settings updated' });
      } else {
        const updated = await WebhookService.updateGlobalConfig(payload);
        return ResponseUtil.success(reply, updated, 200, { message: 'Global webhook settings updated' });
      }
    } catch (err: any) {
      return ResponseUtil.error(reply, 'Failed to update webhook settings', 500, 'SETTINGS_UPDATE_FAILED', err.message);
    }
  }

  /**
   * POST /api/settings/webhook/test
   */
  public static async testWebhook(
    request: FastifyRequest<{
      Body: {
        url?: string;
        secret?: string;
        token?: string;
        sessionId?: string;
      };
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    try {
      const { url, secret, token, sessionId } = request.body || {};
      const result = await WebhookService.testPing(url, secret, token, sessionId);
      const msg = result.success ? 'Webhook test ping successful' : 'Webhook test ping failed';
      return ResponseUtil.success(reply, result, 200, { message: msg });
    } catch (err: any) {
      return ResponseUtil.error(reply, 'Failed to execute test ping', 500, 'TEST_PING_FAILED', err.message);
    }
  }
}
