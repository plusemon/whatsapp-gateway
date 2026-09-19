import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';

const darkThemeCss = `
body { background-color: #090d16 !important; color: #f1f5f9 !important; }
.swagger-ui { color: #f1f5f9; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
.swagger-ui .topbar { display: none; }
.swagger-ui .info { margin: 24px 0 32px; }
.swagger-ui .info .title { color: #f8fafc; font-weight: 800; letter-spacing: -0.025em; }
.swagger-ui .info p, .swagger-ui .info li, .swagger-ui .info table { color: #94a3b8; font-size: 14px; line-height: 1.6; }
.swagger-ui .scheme-container { background: #0f172a; box-shadow: none; border-bottom: 1px solid #1e293b; border-radius: 8px; padding: 14px 18px; margin-bottom: 24px; }
.swagger-ui .opblock-tag { color: #f8fafc; border-bottom: 1px solid #1e293b; font-size: 1.25rem; font-weight: 700; padding: 12px 0; }
.swagger-ui .opblock-tag small { color: #64748b; font-weight: 400; }
.swagger-ui .opblock { border-radius: 8px; box-shadow: none; background: #0f172a; margin-bottom: 12px; border-width: 1px; }
.swagger-ui .opblock .opblock-summary { border-color: #1e293b; padding: 10px 14px; }
.swagger-ui .opblock .opblock-summary-path { color: #f8fafc; font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.swagger-ui .opblock .opblock-summary-description { color: #94a3b8; font-size: 13px; }
.swagger-ui .opblock .opblock-section-header { background: #1e293b; color: #f8fafc; border-radius: 6px 6px 0 0; }
.swagger-ui .opblock-body { background: #0b1120; border-radius: 0 0 8px 8px; }
.swagger-ui .tab li button.tablinks { color: #94a3b8; font-weight: 500; }
.swagger-ui .tab li button.tablinks.active { color: #38bdf8; font-weight: 600; }
.swagger-ui table thead tr td, .swagger-ui table thead tr th { color: #cbd5e1; border-bottom: 1px solid #334155; font-size: 12px; }
.swagger-ui .parameters-col_name { color: #f8fafc; font-weight: 600; }
.swagger-ui .parameter__name { color: #f8fafc; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.swagger-ui .parameter__type { color: #38bdf8; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.swagger-ui .parameter__deprecated { color: #ef4444; }
.swagger-ui .parameter__in { color: #94a3b8; font-size: 12px; }
.swagger-ui input[type=text], .swagger-ui textarea, .swagger-ui select { background: #1e293b; color: #f8fafc; border: 1px solid #334155; border-radius: 6px; padding: 6px 10px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.swagger-ui input[type=text]:focus, .swagger-ui textarea:focus, .swagger-ui select:focus { border-color: #38bdf8; outline: none; }
.swagger-ui .btn { border-radius: 6px; font-weight: 600; transition: all 0.15s ease-in-out; }
.swagger-ui .btn.execute { background-color: #0284c7; border-color: #0284c7; color: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.2); }
.swagger-ui .btn.execute:hover { background-color: #0369a1; border-color: #0369a1; }
.swagger-ui .btn.authorize { background-color: rgba(16, 185, 129, 0.1); border-color: #10b981; color: #10b981; }
.swagger-ui .btn.authorize:hover { background-color: rgba(16, 185, 129, 0.2); }
.swagger-ui .btn.authorize svg { fill: #10b981; }
.swagger-ui .btn.cancel { border-color: #ef4444; color: #ef4444; background-color: rgba(239, 68, 68, 0.1); }
.swagger-ui .response-col_status { color: #f8fafc; font-weight: 700; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.swagger-ui .response-col_description { color: #94a3b8; }
.swagger-ui .responses-inner h4, .swagger-ui .responses-inner h5 { color: #f8fafc; font-weight: 600; }
.swagger-ui .model-box { background: #1e293b; border-radius: 6px; padding: 10px; border: 1px solid #334155; }
.swagger-ui .model { color: #cbd5e1; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.swagger-ui .prop-type { color: #38bdf8; }
.swagger-ui .prop-format { color: #a855f7; }
.swagger-ui section.models { border-color: #1e293b; border-radius: 8px; border-width: 1px; background: #0f172a; margin-top: 24px; }
.swagger-ui section.models h4 { color: #f8fafc; font-weight: 700; }
.swagger-ui .model-title { color: #f8fafc; }
.swagger-ui .model-toggle:after { filter: invert(1); }
.swagger-ui .dialog-ux .modal-ux { background: #0f172a; border: 1px solid #334155; border-radius: 12px; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); }
.swagger-ui .dialog-ux .modal-ux-header { border-bottom: 1px solid #1e293b; }
.swagger-ui .dialog-ux .modal-ux-header h3 { color: #f8fafc; font-weight: 700; }
.swagger-ui .dialog-ux .modal-ux-content h4 { color: #f8fafc; }
.swagger-ui .dialog-ux .modal-ux-content p { color: #94a3b8; }
.swagger-ui .auth-container { border-bottom: 1px solid #1e293b; }
.swagger-ui .auth-container:last-of-type { border-bottom: none; }
.swagger-ui svg:not(:root) { fill: #94a3b8; }
.swagger-ui .opblock.opblock-post { border-color: #10b981; background: rgba(16, 185, 129, 0.05); }
.swagger-ui .opblock.opblock-post .opblock-summary-method { background: #10b981; color: #022c22; font-weight: 700; border-radius: 4px; }
.swagger-ui .opblock.opblock-get { border-color: #0ea5e9; background: rgba(14, 165, 233, 0.05); }
.swagger-ui .opblock.opblock-get .opblock-summary-method { background: #0ea5e9; color: #082f49; font-weight: 700; border-radius: 4px; }
.swagger-ui .opblock.opblock-delete { border-color: #ef4444; background: rgba(239, 68, 68, 0.05); }
.swagger-ui .opblock.opblock-delete .opblock-summary-method { background: #ef4444; color: #450a0a; font-weight: 700; border-radius: 4px; }
.swagger-ui .opblock.opblock-put { border-color: #f59e0b; background: rgba(245, 158, 11, 0.05); }
.swagger-ui .opblock.opblock-put .opblock-summary-method { background: #f59e0b; color: #451a03; font-weight: 700; border-radius: 4px; }
.swagger-ui .download-contents { background: #1e293b; color: #38bdf8; border: 1px solid #334155; }
.swagger-ui .copy-to-clipboard { background: #1e293b; border-color: #334155; }
.swagger-ui .copy-to-clipboard button { filter: invert(0.8); }
.swagger-ui .microlight { background: #020617 !important; color: #38bdf8 !important; border-radius: 6px; padding: 12px !important; border: 1px solid #1e293b; }
.swagger-ui .response-control-media-type__title { color: #94a3b8; }
.swagger-ui .response-control-media-type--accept-controller select { background: #1e293b; color: #f8fafc; border-color: #334155; }
.swagger-ui .markdown p, .swagger-ui .renderedMarkdown p { color: #94a3b8; }
.swagger-ui .markdown code, .swagger-ui .renderedMarkdown code { background: #1e293b; color: #38bdf8; border-radius: 4px; padding: 2px 5px; }
`;

export default fp(async (fastify: FastifyInstance) => {
  await fastify.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Botla WhatsApp Gateway REST API',
        description: 'High-performance, headless WhatsApp API microservice powered by Baileys, Redis, and Prisma.',
        version: '1.2.0',
        contact: {
          name: 'Botla Engineering Support',
          email: 'support@botla.ai',
        },
      },
      servers: [
        {
          url: '/',
          description: 'Current Gateway Server (Dynamic / Relative Host)',
        },
      ],
      components: {
        securitySchemes: {
          ApiKeyAuth: {
            type: 'apiKey',
            name: 'x-api-key',
            in: 'header',
            description: 'Provide your secret gateway API key (e.g. x-api-key: secret-key).',
          },
        },
      },
      security: [{ ApiKeyAuth: [] }],
      tags: [
        { name: 'Sessions', description: 'Tenant socket lifecycle and multi-device authentication' },
        { name: 'Messages', description: 'Outbound messaging, interactive payload dispatch, and delivery status' },
        { name: 'Webhooks', description: 'Webhook configuration and dispatch telemetry' },
        { name: 'System', description: 'Gateway telemetry, health metrics, and storage management' },
      ],
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      displayRequestDuration: true,
    },
    theme: {
      title: 'Botla WhatsApp Gateway - API Documentation',
      css: [
        {
          filename: 'custom-dark-theme.css',
          content: darkThemeCss,
        },
      ],
    },
    staticCSP: true,
    transformStaticCSP: (header) => header,
  });
});
