/**
 * Webhook Queue & Dead-Letter Queue (DLQ) Management Routes
 * Exposes administrative endpoints to inspect failed deliveries, query audit logs, and trigger retries.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../services/db.service.js';
import { WebhookService } from '../services/webhook.service.js';
import { enqueueWebhookJob } from '../queues/webhook.queue.js';
import { logger } from '../utils/logger.js';

interface FailedWebhooksQuery {
  sessionId?: string;
  event?: string;
  limit?: string | number;
  offset?: string | number;
}

interface RetryWebhookParams {
  logId: string;
}

interface WebhookLogsQuery {
  sessionId?: string;
  event?: string;
  success?: string | boolean;
  limit?: string | number;
  offset?: string | number;
}

export const webhookRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  /**
   * Handler for listing failed webhook deliveries (DLQ items).
   */
  const getFailedWebhooks = async (
    req: FastifyRequest<{ Querystring: FailedWebhooksQuery }>,
    reply: FastifyReply
  ) => {
    try {
      const { sessionId, event, limit = 50, offset = 0 } = req.query;
      const take = Math.min(Number(limit) || 50, 100);
      const skip = Math.max(Number(offset) || 0, 0);

      const where: any = {
        success: false,
      };

      if (sessionId) where.sessionId = sessionId;
      if (event) where.event = event;

      const [logs, total] = await Promise.all([
        prisma.webhookLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take,
          skip,
        }),
        prisma.webhookLog.count({ where }),
      ]);

      return reply.send({
        success: true,
        data: {
          count: logs.length,
          total,
          limit: take,
          offset: skip,
          logs,
        },
      });
    } catch (err: any) {
      logger.error({ err: err.message }, '[WebhookRoutes] Failed to fetch failed webhook logs');
      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to retrieve failed webhook logs from database',
        },
      });
    }
  };

  /**
   * Handler for re-dispatching / retrying a specific failed webhook from DLQ.
   */
  const retryWebhook = async (
    req: FastifyRequest<{ Params: RetryWebhookParams }>,
    reply: FastifyReply
  ) => {
    try {
      const { logId } = req.params;

      const log = await prisma.webhookLog.findUnique({
        where: { id: logId },
      });

      if (!log) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `Webhook log with id "${logId}" not found`,
          },
        });
      }

      // Resolve webhook configuration for the target session
      const webhookConfig = await WebhookService.resolveWebhook(log.sessionId);
      if (!webhookConfig || !webhookConfig.url) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'CONFIG_ERROR',
            message: `No active webhook destination configured for session "${log.sessionId}"`,
          },
        });
      }

      // Re-enqueue job into BullMQ Webhook Queue
      const payloadData = typeof log.payload === 'object' && log.payload !== null
        ? (log.payload as Record<string, any>)
        : { raw: log.payload };

      const job = await enqueueWebhookJob(`retry:${log.id}`, {
        logId: log.id,
        sessionId: log.sessionId,
        targetUrl: webhookConfig.url,
        secret: webhookConfig.secret,
        token: webhookConfig.token,
        event: log.event,
        data: payloadData,
        timestamp: new Date().toISOString(),
      });

      logger.info(
        { logId: log.id, sessionId: log.sessionId, event: log.event, jobId: job.id },
        '[WebhookRoutes] Re-enqueued failed webhook for delivery'
      );

      return reply.send({
        success: true,
        message: 'Webhook job re-enqueued for delivery',
        data: {
          logId: log.id,
          jobId: job.id,
          sessionId: log.sessionId,
          event: log.event,
          targetUrl: webhookConfig.url,
        },
      });
    } catch (err: any) {
      logger.error({ err: err.message }, '[WebhookRoutes] Failed to retry webhook job');
      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: err.message || 'Failed to retry webhook job',
        },
      });
    }
  };

  /**
   * Handler for listing all webhook audit logs with pagination and filters.
   */
  const getWebhookLogs = async (
    req: FastifyRequest<{ Querystring: WebhookLogsQuery }>,
    reply: FastifyReply
  ) => {
    try {
      const { sessionId, event, success, limit = 50, offset = 0 } = req.query;
      const take = Math.min(Number(limit) || 50, 100);
      const skip = Math.max(Number(offset) || 0, 0);

      const where: any = {};
      if (sessionId) where.sessionId = sessionId;
      if (event) where.event = event;
      if (success !== undefined) {
        where.success = success === 'true' || success === true;
      }

      const [logs, total] = await Promise.all([
        prisma.webhookLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take,
          skip,
        }),
        prisma.webhookLog.count({ where }),
      ]);

      return reply.send({
        success: true,
        data: {
          count: logs.length,
          total,
          limit: take,
          offset: skip,
          logs,
        },
      });
    } catch (err: any) {
      logger.error({ err: err.message }, '[WebhookRoutes] Failed to fetch webhook logs');
      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to retrieve webhook logs',
        },
      });
    }
  };

  /**
   * Handler for purging webhook logs.
   */
  const deleteWebhookLogs = async (
    req: FastifyRequest<{ Querystring: { sessionId?: string } }>,
    reply: FastifyReply
  ) => {
    try {
      const { sessionId } = req.query;
      const where: any = {};
      if (sessionId) where.sessionId = sessionId;

      const result = await prisma.webhookLog.deleteMany({ where });

      return reply.send({
        success: true,
        message: 'Webhook logs purged successfully',
        data: {
          deleted: result.count,
        },
      });
    } catch (err: any) {
      logger.error({ err: err.message }, '[WebhookRoutes] Failed to purge webhook logs');
      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to purge webhook logs',
        },
      });
    }
  };

  /* -------------------------------------------------------------------------- */
  /* Register API Endpoints (V1 and root alias)                                 */
  /* -------------------------------------------------------------------------- */

  const failedSchema = {
    schema: {
      tags: ['Webhooks'],
      summary: 'List failed webhook deliveries (Dead-Letter Queue)',
      description: 'Returns a paginated list of failed outbound webhook payloads with error details and attempt counts.',
      querystring: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          event: { type: 'string' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  };

  const retrySchema = {
    schema: {
      tags: ['Webhooks'],
      summary: 'Retry a failed webhook delivery',
      description: 'Re-enqueues a failed webhook log from the Dead-Letter Queue back into the BullMQ webhook dispatch queue.',
      params: {
        type: 'object',
        required: ['logId'],
        properties: {
          logId: { type: 'string' },
        },
      },
    },
  };

  const logsSchema = {
    schema: {
      tags: ['Webhooks'],
      summary: 'Query webhook delivery audit logs',
      description: 'Retrieve real-time audit logs of webhook dispatches with status codes and delivery outcomes.',
      querystring: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          event: { type: 'string' },
          success: { type: 'string' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  };

  fastify.get('/webhooks/failed', failedSchema, getFailedWebhooks);
  fastify.get('/v1/webhooks/failed', failedSchema, getFailedWebhooks);

  fastify.post('/webhooks/retry/:logId', retrySchema, retryWebhook);
  fastify.post('/v1/webhooks/retry/:logId', retrySchema, retryWebhook);

  fastify.get('/webhooks/logs', logsSchema, getWebhookLogs);
  fastify.get('/v1/webhooks/logs', logsSchema, getWebhookLogs);

  fastify.delete('/webhooks/logs', deleteWebhookLogs);
  fastify.delete('/v1/webhooks/logs', deleteWebhookLogs);
};
