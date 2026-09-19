import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { authMiddleware } from '../../src/middleware/auth.middleware.js';
import { apiRoutes } from '../../src/routes/api.routes.js';
import { ResponseUtil } from '../../src/utils/response.util.js';

describe('Fastify API Auth Middleware (api.auth.test.ts)', () => {
  let app: FastifyInstance;
  const TEST_API_KEY = 'secret-test-botla-api-key-999';
  const originalApiKey = process.env.API_GATEWAY_KEY;

  beforeAll(async () => {
    process.env.API_GATEWAY_KEY = TEST_API_KEY;

    app = Fastify({
      logger: false,
      ajv: {
        customOptions: {
          strict: false,
        },
      },
    });

    // Handle empty JSON bodies gracefully
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      if (!body || typeof body !== 'string' || body.trim() === '') {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body));
      } catch (err: any) {
        err.statusCode = 400;
        done(err, undefined);
      }
    });

    // Register routes under /api prefix exactly as in server.ts
    await app.register(apiRoutes, { prefix: '/api' });

    // Register a test protected endpoint under /api/v1
    app.get('/api/v1/test-secure', { preHandler: authMiddleware }, async (_req, reply) => {
      return ResponseUtil.success(reply, { message: 'Access Granted' });
    });

    await app.ready();
  });

  afterAll(async () => {
    if (originalApiKey !== undefined) {
      process.env.API_GATEWAY_KEY = originalApiKey;
    } else {
      delete process.env.API_GATEWAY_KEY;
    }
    await app.close();
  });

  describe('Missing API Key', () => {
    it('should return HTTP 401 with UNAUTHORIZED code when x-api-key header is absent', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/test-secure',
      });

      expect(response.statusCode).toBe(401);
      const json = response.json();
      expect(json.success).toBe(false);
      expect(json.error).toBeDefined();
      expect(json.error.code).toBe('UNAUTHORIZED');
      expect(json.error.message).toContain('API key');
    });

    it('should return HTTP 401 when accessing v1 session routes without API key', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/demo-session/status',
      });

      expect(response.statusCode).toBe(401);
      const json = response.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('UNAUTHORIZED');
    });
  });

  describe('Invalid API Key', () => {
    it('should return HTTP 401 with UNAUTHORIZED code when x-api-key is incorrect', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/test-secure',
        headers: {
          'x-api-key': 'incorrect-wrong-key-xyz',
        },
      });

      expect(response.statusCode).toBe(401);
      const json = response.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('UNAUTHORIZED');
    });

    it('should return HTTP 401 when Authorization Bearer token is invalid', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/test-secure',
        headers: {
          authorization: 'Bearer invalid-bearer-token',
        },
      });

      expect(response.statusCode).toBe(401);
      const json = response.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('UNAUTHORIZED');
    });
  });

  describe('Valid API Key Authorization', () => {
    it('should successfully pass through to route handler when valid x-api-key header is supplied', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/test-secure',
        headers: {
          'x-api-key': TEST_API_KEY,
        },
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.success).toBe(true);
      expect(json.data.message).toBe('Access Granted');
    });

    it('should successfully authenticate when valid Bearer token is supplied in authorization header', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/test-secure',
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.success).toBe(true);
      expect(json.data.message).toBe('Access Granted');
    });

    it('should allow public routes like /api/health without requiring an API key', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.status).toBe('ok');
    });

    it('should gracefully handle DELETE requests with content-type application/json and empty body', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/sessions/non-existent-session-test',
        headers: {
          'x-api-key': TEST_API_KEY,
          'content-type': 'application/json',
        },
      });

      // Should not throw 400 "Body cannot be empty when content-type is set to 'application/json'"
      expect(response.statusCode).not.toBe(400);
    });
  });
});
