/**
 * User Interface & Static View Routes
 * Serves the mobile-first dark-mode Tailwind dashboard and views.
 */
import fs from 'fs';
import path from 'path';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

let cachedDashboardHtml: string | null = null;

/**
 * Loads the dashboard HTML from disk or returns cached in-memory buffer.
 */
export function getDashboardHtml(): string {
  if (cachedDashboardHtml && process.env.NODE_ENV === 'production') {
    return cachedDashboardHtml;
  }

  const possiblePaths = [
    path.resolve(process.cwd(), 'public/index.html'),
    path.resolve(process.cwd(), 'index.html'),
    path.resolve(process.cwd(), 'src/views/dashboard.html'),
    path.resolve(process.cwd(), 'dist/views/dashboard.html'),
    path.resolve(process.cwd(), 'views/dashboard.html'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      try {
        let content = fs.readFileSync(p, 'utf-8');
        const activeKey =
          process.env.GATEWAY_API_KEY ||
          process.env.API_GATEWAY_KEY ||
          process.env.API_KEY ||
          'gateway-api-key';
        const injection = `<script>window.__GATEWAY_API_KEY__ = ${JSON.stringify(activeKey)}; window.__BOTLA_API_KEY__ = ${JSON.stringify(activeKey)};</script>`;
        if (content.includes('</head>')) {
          content = content.replace('</head>', `${injection}\n</head>`);
        } else if (content.includes('<body>')) {
          content = content.replace('<body>', `<body>\n${injection}`);
        }
        return content;
      } catch {
        // Fallback
      }
    }
  }

  return `<!DOCTYPE html>
<html>
<head><title>WhatsApp Gateway</title></head>
<body style="font-family:sans-serif;padding:2rem;background:#0f172a;color:#fff;">
  <h1>WhatsApp Gateway</h1>
  <p>Gateway microservice is running. Dashboard view file not located.</p>
</body>
</html>`;
}

export const uiRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // Main dashboard route
  fastify.get('/', async (_request, reply) => {
    reply.type('text/html; charset=utf-8').send(getDashboardHtml());
  });

  // Alias /index.html
  fastify.get('/index.html', async (_request, reply) => {
    reply.type('text/html; charset=utf-8').send(getDashboardHtml());
  });
};
