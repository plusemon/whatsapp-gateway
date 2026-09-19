/**
 * Authentication Middleware
 * Validates API key or Bearer token against GATEWAY_API_KEY / API_KEY configuration.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config/env.js';
import { ResponseUtil } from '../utils/response.util.js';

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // If no API key is configured on the gateway, allow permissive access
  if (!config.apiKey) {
    return;
  }

  // Bypass auth for health, version, SSE streams, event buffer, log telemetry, and maintenance
  const publicPaths = [
    '/api/health',
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
  ];
  
  const pathWithoutQuery = request.url.split('?')[0];

  // Allow read-only public paths and GET /api/sessions without requiring auth header
  if (
    publicPaths.includes(pathWithoutQuery) ||
    (request.method === 'GET' && pathWithoutQuery === '/api/sessions')
  ) {
    return;
  }

  const apiKeyHeader = request.headers['x-api-key'] as string | undefined;
  const authHeader = request.headers.authorization;
  const queryApiKey = (request.query as any)?.apiKey || (request.query as any)?.api_key;
  let bearerToken: string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    bearerToken = authHeader.slice(7).trim();
  }

  const providedKey = apiKeyHeader || bearerToken || queryApiKey;

  if (!providedKey || providedKey !== config.apiKey) {
    return ResponseUtil.error(
      reply,
      'Unauthorized: Valid API Key or Bearer token is required',
      401,
      'UNAUTHORIZED'
    ) as unknown as void;
  }
}
