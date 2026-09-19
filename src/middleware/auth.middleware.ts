/**
 * Authentication Middleware
 * Validates API key or Bearer token against API_GATEWAY_KEY / GATEWAY_API_KEY / API_KEY configuration.
 * Enforces unified 401 response contract:
 * { "success": false, "error": { "code": "UNAUTHORIZED", "message": "Invalid or missing API key." } }
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config/env.js';
import { ResponseUtil } from '../utils/response.util.js';

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const pathWithoutQuery = request.url.split('?')[0];

  // Whitelist public system, health, version, telemetry, and mock webhook routes
  const publicPaths = [
    '/api/health',
    '/api/v1/health',
    '/api/system/version',
    '/api/events',
    '/api/logs',
    '/api/logs/stream',
    '/api/logs/files',
    '/api/logs/view',
    '/api/logs/download',
    '/api/logs/clear',
    '/api/logs/cleanup',
    '/api/media/cleanup',
    '/api/webhook/mock',
    '/api/settings/webhook',
    '/api/settings/webhook/test',
  ];

  if (publicPaths.includes(pathWithoutQuery)) {
    return;
  }

  // Determine expected API key from environment dynamically
  const expectedKey =
    process.env.API_GATEWAY_KEY ||
    process.env.API_KEY ||
    process.env.GATEWAY_API_KEY ||
    config.apiKey;

  const apiKeyHeader = request.headers['x-api-key'] as string | undefined;
  const authHeader = request.headers.authorization;
  let bearerToken: string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    bearerToken = authHeader.slice(7).trim();
  }

  const queryApiKey = (request.query as any)?.apiKey || (request.query as any)?.api_key;
  const providedKey = apiKeyHeader || bearerToken || queryApiKey;

  // If API key is missing
  if (!providedKey) {
    return ResponseUtil.error(
      reply,
      'Invalid or missing API key.',
      401,
      'UNAUTHORIZED'
    ) as unknown as void;
  }

  // If expectedKey is configured and providedKey doesn't match
  if (expectedKey && providedKey !== expectedKey) {
    return ResponseUtil.error(
      reply,
      'Invalid or missing API key.',
      401,
      'UNAUTHORIZED'
    ) as unknown as void;
  }
}
