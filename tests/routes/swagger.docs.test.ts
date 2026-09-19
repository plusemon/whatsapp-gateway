import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server.js';

describe('OpenAPI / Swagger Documentation (/docs & /docs/json)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /docs should serve the interactive Swagger UI page with 200 OK', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    const body = response.body;
    expect(body).toContain('swagger-ui');
  });

  it('GET /docs/json should return the raw OpenAPI 3.0 specification JSON', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs/json',
    });

    expect(response.statusCode).toBe(200);
    const spec = response.json();

    // Verify OpenAPI version and basic metadata
    expect(spec.openapi).toMatch(/^3\.0\./);
    expect(spec.info).toBeDefined();
    expect(spec.info.title).toBe('Botla WhatsApp Gateway REST API');
    expect(spec.info.version).toBe('1.2.0');

    // Verify servers configuration uses relative/dynamic root for CORS & mobile/cloud safety
    expect(spec.servers).toBeDefined();
    expect(spec.servers[0].url).toBe('/');

    // Verify securitySchemes definition
    expect(spec.components).toBeDefined();
    expect(spec.components.securitySchemes).toBeDefined();
    expect(spec.components.securitySchemes.ApiKeyAuth).toBeDefined();
    expect(spec.components.securitySchemes.ApiKeyAuth.type).toBe('apiKey');
    expect(spec.components.securitySchemes.ApiKeyAuth.name).toBe('x-api-key');
    expect(spec.components.securitySchemes.ApiKeyAuth.in).toBe('header');

    // Verify documented tags
    const tagNames = spec.tags.map((t: any) => t.name);
    expect(tagNames).toContain('Sessions');
    expect(tagNames).toContain('Messages');
    expect(tagNames).toContain('Webhooks');

    // Verify core endpoints are documented in paths
    expect(spec.paths).toBeDefined();
    expect(spec.paths['/api/v1/sessions/init']).toBeDefined();
    expect(spec.paths['/api/v1/sessions/init'].post).toBeDefined();
    expect(spec.paths['/api/v1/sessions/pair-code']).toBeDefined();
    expect(spec.paths['/api/v1/sessions/pair-code'].post).toBeDefined();
    expect(spec.paths['/api/v1/sessions']).toBeDefined();
    expect(spec.paths['/api/v1/sessions'].get).toBeDefined();
    expect(spec.paths['/api/v1/sessions/{sessionId}/status']).toBeDefined();
    expect(spec.paths['/api/v1/sessions/{sessionId}/status'].get).toBeDefined();
    expect(spec.paths['/api/v1/sessions/{sessionId}/logout']).toBeDefined();
    expect(spec.paths['/api/v1/sessions/{sessionId}/logout'].post).toBeDefined();
    expect(spec.paths['/api/v1/sessions/{sessionId}']).toBeDefined();
    expect(spec.paths['/api/v1/sessions/{sessionId}'].delete).toBeDefined();

    // Verify messaging endpoints
    expect(spec.paths['/api/v1/messages/send-text']).toBeDefined();
    expect(spec.paths['/api/v1/messages/send-text'].post).toBeDefined();
    expect(spec.paths['/api/v1/messages/send-media']).toBeDefined();
    expect(spec.paths['/api/v1/messages/send-media'].post).toBeDefined();
    expect(spec.paths['/api/v1/messages/{messageId}']).toBeDefined();
    expect(spec.paths['/api/v1/messages/{messageId}'].get).toBeDefined();
    expect(spec.paths['/api/v1/sessions/{sessionId}/messages']).toBeDefined();
    expect(spec.paths['/api/v1/sessions/{sessionId}/messages'].get).toBeDefined();
  });

  it('GET /docs/yaml should return the raw OpenAPI spec in YAML format', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs/yaml',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('yaml');
    expect(response.body).toContain('openapi: 3.0.');
    expect(response.body).toContain('Botla WhatsApp Gateway REST API');
  });
});
