/**
 * Global Error Handler and 404 Guard Middleware
 * Ensures API endpoints strictly return standardized JSON envelopes, while web routes serve the UI.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../utils/logger.js';
import { ResponseUtil } from '../utils/response.util.js';

export function registerErrorHandlers(
  fastify: FastifyInstance,
  getDashboardHtml: () => string
): void {
  // Global Unhandled Error Handler
  fastify.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const statusCode = error.statusCode || 500;
    const isClientError = statusCode >= 400 && statusCode < 500;

    if (isClientError) {
      logger.warn(
        { url: request.url, method: request.method, statusCode, err: error.message },
        '[HTTP] Client request error'
      );
    } else {
      logger.error(
        { url: request.url, method: request.method, statusCode, err: error.message, stack: error.stack },
        '[HTTP] Unhandled server error'
      );
    }

    // Always respond with JSON error for API requests
    if (request.url.startsWith('/api')) {
      const errorCode =
        error.code === 'FST_ERR_VALIDATION' || error.validation
          ? 'VALIDATION_ERROR'
          : error.code || 'INTERNAL_ERROR';

      return ResponseUtil.error(
        reply,
        error.message || 'Internal Server Error',
        statusCode,
        errorCode,
        error.validation || null
      );
    }

    // Otherwise send text/html error or UI
    return reply.status(statusCode).type('text/html; charset=utf-8').send(getDashboardHtml());
  });

  // Global 404 Not Found Handler
  fastify.setNotFoundHandler(async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url.startsWith('/api')) {
      return ResponseUtil.error(
        reply,
        `Endpoint '${request.url}' not found`,
        404,
        'NOT_FOUND',
        { url: request.url }
      );
    }

    reply.type('text/html; charset=utf-8').send(getDashboardHtml());
  });
}
