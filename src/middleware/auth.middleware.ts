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

  // Bypass auth for health, version, SSE streams, UI routes and mock webhook
  const publicPaths = ['/api/health', '/api/system/version', '/api/webhook/mock', '/api/logs/stream'];
  if (publicPaths.includes(request.url.split('?')[0])) {
    return;
  }

  const apiKeyHeader = request.headers['x-api-key'] as string | undefined;
  const authHeader = request.headers.authorization;
  let bearerToken: string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    bearerToken = authHeader.slice(7).trim();
  }

  const providedKey = apiKeyHeader || bearerToken;

  if (!providedKey || providedKey !== config.apiKey) {
    ResponseUtil.error(
      reply,
      'Unauthorized: Valid API Key or Bearer token is required',
      401,
      'UNAUTHORIZED'
    );
  }
}
