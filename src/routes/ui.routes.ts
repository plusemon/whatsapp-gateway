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
        const content = fs.readFileSync(p, 'utf-8');
        cachedDashboardHtml = content;
        return content;
      } catch {
        // Fallback
      }
    }
  }

  return `<!DOCTYPE html>
<html>
<head><title>Botla WhatsApp Gateway</title></head>
<body style="font-family:sans-serif;padding:2rem;background:#0f172a;color:#fff;">
  <h1>Botla WhatsApp Gateway</h1>
  <p>Gateway service is running. Dashboard view file not located.</p>
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
