import cors from '@fastify/cors';
import Fastify from 'fastify';
import { config, getRedisClient, isUsingMockRedis, logger } from './config.js';
import { sessionManager } from './manager/sessionManager.js';
import { sessionRoutes } from './routes/sessionRoutes.js';

/**
 * Builds and starts the Fastify WhatsApp Gateway Microservice.
 */
export async function buildServer() {
  const fastify = Fastify({
    logger: false, // Managed via custom pino logger in config
    trustProxy: true,
  });

  // Enable CORS for cross-origin management access
  await fastify.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // Health check endpoints
  fastify.get('/api/health', async () => {
    return {
      status: 'ok',
      service: 'botla-whatsapp-gateway',
      version: '1.0.0',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      redis: isUsingMockRedis() ? 'in-memory-fallback' : 'connected-redis',
      webhookUrl: config.botlaWebhookUrl,
      activeSessions: sessionManager.listSessions().length,
    };
  });

  fastify.get('/health', async () => ({ status: 'ok' }));

  // Register session REST routes under /api
  await fastify.register(sessionRoutes, { prefix: '/api' });

  // Optional mock webhook receiver for local testing and demonstration
  fastify.post('/api/webhook/mock', async (request) => {
    const signature = request.headers['x-botla-signature'];
    logger.info({ signature, body: request.body }, '[MockWebhook] Received webhook payload');
    return { received: true, signatureMatched: !!signature };
  });

  // Interactive Web Gateway Console on root GET /
  fastify.get('/', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    return getDashboardHtml();
  });

  return fastify;
}

/**
 * Generates the clean Industrial Dark Mode Dashboard for Botla Gateway.
 */
function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Botla WhatsApp Gateway Microservice</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { background-color: #09090B; color: #FAFAFA; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .card { background-color: #121215; border: 1px solid #27272A; border-radius: 1rem; }
    .input-field { background-color: #18181B; border: 1px solid #27272A; color: #FAFAFA; }
    .input-field:focus { border-color: #10B981; outline: none; }
    .badge-online { background-color: rgba(16, 185, 129, 0.15); color: #10B981; border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-qr { background-color: rgba(245, 158, 11, 0.15); color: #F59E0B; border: 1px solid rgba(245, 158, 11, 0.3); }
    .badge-offline { background-color: rgba(244, 63, 94, 0.15); color: #F43F5E; border: 1px solid rgba(244, 63, 94, 0.3); }
  </style>
</head>
<body class="min-h-screen p-4 md:p-8">
  <div class="max-w-7xl mx-auto space-y-6">
    <!-- Header -->
    <header class="flex flex-col md:flex-row md:items-center md:justify-between pb-6 border-b border-zinc-800 gap-4">
      <div>
        <div class="flex items-center gap-3">
          <div class="w-3 h-3 rounded-full bg-emerald-500 animate-pulse"></div>
          <h1 class="text-2xl font-bold tracking-tight text-white">Botla WhatsApp Gateway</h1>
          <span class="px-2.5 py-0.5 text-xs font-medium rounded-full bg-zinc-800 text-zinc-300 border border-zinc-700">Baileys + Redis</span>
        </div>
        <p class="text-sm text-zinc-400 mt-1">Decoupled Multi-Tenant WhatsApp Microservice for Botla Platform</p>
      </div>

      <div class="flex items-center gap-3 text-xs">
        <div id="redis-badge" class="px-3 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400">
          Redis: <span id="redis-status" class="text-emerald-400 font-mono font-medium">Connecting...</span>
        </div>
        <div class="px-3 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400">
          Webhook: <span class="text-zinc-200 font-mono truncate max-w-[200px] inline-block align-bottom">${config.botlaWebhookUrl}</span>
        </div>
      </div>
    </header>

    <!-- Main Grid -->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
      
      <!-- Left Column: Session Controls & Active Tenants (7 Cols) -->
      <div class="lg:col-span-7 space-y-6">
        <!-- New Session Card -->
        <div class="card p-6">
          <h2 class="text-lg font-semibold text-white mb-2">Initialize Tenant Session</h2>
          <p class="text-xs text-zinc-400 mb-4">Boots Baileys socket with Redis AuthState adapter for the specified tenant identifier.</p>
          
          <div class="flex gap-3">
            <input id="new-session-id" type="text" placeholder="e.g. tenant-client-01" value="tenant-botla-1" class="input-field flex-1 rounded-xl px-4 py-2.5 text-sm" />
            <button id="btn-init-session" onclick="initSession()" class="bg-white hover:bg-zinc-200 text-black font-semibold text-sm px-5 py-2.5 rounded-xl transition cursor-pointer">
              Boot Session
            </button>
          </div>
        </div>

        <!-- Sessions List Card -->
        <div class="card p-6">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-lg font-semibold text-white">Active Tenant Sessions</h2>
            <button onclick="loadSessions()" class="text-xs text-zinc-400 hover:text-white transition cursor-pointer">↻ Refresh</button>
          </div>
          
          <div id="sessions-container" class="space-y-3">
            <div class="p-6 text-center text-zinc-500 text-sm">No active sessions loaded yet. Initialize one above.</div>
          </div>
        </div>

        <!-- Outbound Message Tester Card -->
        <div class="card p-6">
          <div class="flex items-center justify-between mb-2">
            <h2 class="text-lg font-semibold text-white">Outbound Message Dispatcher</h2>
            <span class="text-xs text-emerald-400 flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-full bg-emerald-400"></span> Anti-Ban Delay Active (600ms - 1400ms)
            </span>
          </div>
          <p class="text-xs text-zinc-400 mb-4">Sends message via active tenant socket simulating human composing presence.</p>

          <form id="send-form" onsubmit="handleSendMessage(event)" class="space-y-4">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label class="block text-xs text-zinc-400 mb-1.5">Tenant Session ID</label>
                <input id="send-session-id" type="text" placeholder="tenant-botla-1" required class="input-field w-full rounded-xl px-3.5 py-2 text-sm" />
              </div>
              <div>
                <label class="block text-xs text-zinc-400 mb-1.5">Recipient JID or Phone</label>
                <input id="send-jid" type="text" placeholder="e.g. 8801700000000@s.whatsapp.net" required class="input-field w-full rounded-xl px-3.5 py-2 text-sm" />
              </div>
            </div>
            <div>
              <label class="block text-xs text-zinc-400 mb-1.5">Message Content</label>
              <textarea id="send-text" rows="3" placeholder="Hello from Botla WhatsApp Gateway!" required class="input-field w-full rounded-xl px-3.5 py-2 text-sm"></textarea>
            </div>
            <div class="flex items-center justify-between pt-2">
              <span id="send-status" class="text-xs text-zinc-400"></span>
              <button type="submit" id="btn-send" class="bg-white hover:bg-zinc-200 text-black font-semibold text-sm px-5 py-2.5 rounded-xl transition cursor-pointer">
                Send Message
              </button>
            </div>
          </form>
        </div>
      </div>

      <!-- Right Column: Live QR Code & Event Stream (5 Cols) -->
      <div class="lg:col-span-5 space-y-6">
        
        <!-- Live QR Code Card -->
        <div class="card p-6 flex flex-col items-center justify-center text-center">
          <h2 class="text-lg font-semibold text-white mb-1">WhatsApp Web QR Scanner</h2>
          <p id="qr-session-label" class="text-xs text-zinc-400 mb-4">No active session selected</p>

          <div id="qr-box" class="w-64 h-64 bg-zinc-900 border border-zinc-800 rounded-2xl flex items-center justify-center p-4 relative overflow-hidden">
            <div id="qr-placeholder" class="text-zinc-600 text-xs text-center px-4">
              Initialize a session to generate and stream the pairing QR code.
            </div>
            <img id="qr-image" src="" alt="WhatsApp QR Code" class="hidden w-full h-full object-contain rounded-lg" />
          </div>

          <div id="qr-actions" class="mt-4 flex flex-col items-center gap-2 hidden">
            <span id="qr-status-badge" class="px-3 py-1 rounded-full text-xs font-medium badge-qr">Awaiting Scan</span>
            <p class="text-xs text-zinc-400">Open WhatsApp on your phone &gt; Linked Devices &gt; Scan QR Code</p>
          </div>
        </div>

        <!-- Live Webhook / Gateway Events Stream -->
        <div class="card p-6">
          <div class="flex items-center justify-between mb-3">
            <h2 class="text-lg font-semibold text-white">Live Event Stream</h2>
            <span class="text-xs font-mono text-zinc-500">Auto-polling (2s)</span>
          </div>
          <div id="events-feed" class="space-y-2.5 max-h-72 overflow-y-auto pr-1 text-xs font-mono">
            <div class="text-zinc-600 py-3 text-center">Listening for gateway events...</div>
          </div>
        </div>

      </div>
    </div>

    <!-- API Reference Accordion -->
    <div class="card p-6">
      <h2 class="text-lg font-semibold text-white mb-4">REST API Quick Reference</h2>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 text-xs font-mono">
        <div class="p-3 bg-zinc-950 border border-zinc-800 rounded-xl">
          <span class="text-emerald-400 font-bold">POST</span> /api/sessions/:id/init
          <p class="text-zinc-400 font-sans mt-1">Boots socket & Redis auth</p>
        </div>
        <div class="p-3 bg-zinc-950 border border-zinc-800 rounded-xl">
          <span class="text-blue-400 font-bold">GET</span> /api/sessions/:id/qr
          <p class="text-zinc-400 font-sans mt-1">Fetches raw QR string & image</p>
        </div>
        <div class="p-3 bg-zinc-950 border border-zinc-800 rounded-xl">
          <span class="text-amber-400 font-bold">POST</span> /api/sessions/:id/send
          <p class="text-zinc-400 font-sans mt-1">{ jid, text } with anti-ban delay</p>
        </div>
        <div class="p-3 bg-zinc-950 border border-zinc-800 rounded-xl">
          <span class="text-rose-400 font-bold">DELETE</span> /api/sessions/:id
          <p class="text-zinc-400 font-sans mt-1">Disconnects & purges Redis</p>
        </div>
      </div>
    </div>
  </div>

  <script>
    let activeQrSession = null;
    let qrPollInterval = null;

    async function checkHealth() {
      try {
        const res = await fetch('/api/health');
        const data = await res.json();
        document.getElementById('redis-status').textContent = data.redis;
        if (data.redis.includes('connected')) {
          document.getElementById('redis-status').className = 'text-emerald-400 font-mono font-medium';
        } else {
          document.getElementById('redis-status').className = 'text-amber-400 font-mono font-medium';
        }
      } catch (err) {
        document.getElementById('redis-status').textContent = 'offline';
        document.getElementById('redis-status').className = 'text-rose-400 font-mono font-medium';
      }
    }

    async function loadSessions() {
      try {
        const res = await fetch('/api/sessions');
        const data = await res.json();
        const container = document.getElementById('sessions-container');

        if (!data.sessions || data.sessions.length === 0) {
          container.innerHTML = '<div class="p-6 text-center text-zinc-500 text-sm">No active sessions. Initialize one above.</div>';
          return;
        }

        container.innerHTML = data.sessions.map(s => {
          let badgeClass = 'badge-offline';
          if (s.status === 'connected') badgeClass = 'badge-online';
          else if (s.status === 'qr_ready' || s.status === 'connecting') badgeClass = 'badge-qr';

          return \`
            <div class="flex items-center justify-between p-3.5 rounded-xl bg-zinc-900 border border-zinc-800/80">
              <div class="flex items-center gap-3">
                <div class="w-2.5 h-2.5 rounded-full \${s.status === 'connected' ? 'bg-emerald-400' : (s.status === 'qr_ready' ? 'bg-amber-400 animate-ping' : 'bg-zinc-600')}"></div>
                <div>
                  <div class="font-medium text-white text-sm flex items-center gap-2">
                    \${s.id}
                    <span class="text-[10px] px-2 py-0.5 rounded-full \${badgeClass}">\${s.status}</span>
                  </div>
                  <div class="text-[11px] text-zinc-400">
                    \${s.user ? ('User: ' + s.user.id) : 'Awaiting authentication'}
                  </div>
                </div>
              </div>
              <div class="flex items-center gap-2">
                <button onclick="viewQr('\${s.id}')" class="px-2.5 py-1.5 text-xs rounded-lg border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition cursor-pointer">
                  QR Code
                </button>
                <button onclick="fillSender('\${s.id}')" class="px-2.5 py-1.5 text-xs rounded-lg border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition cursor-pointer">
                  Use in Sender
                </button>
                <button onclick="deleteSession('\${s.id}')" class="px-2.5 py-1.5 text-xs rounded-lg border border-rose-900/50 bg-rose-950/30 hover:bg-rose-900/50 text-rose-300 transition cursor-pointer">
                  Purge
                </button>
              </div>
            </div>
          \`;
        }).join('');
      } catch (e) {
        console.error('Error loading sessions', e);
      }
    }

    async function initSession() {
      const input = document.getElementById('new-session-id');
      const id = input.value.trim();
      if (!id) return;

      const btn = document.getElementById('btn-init-session');
      btn.disabled = true;
      btn.textContent = 'Booting...';

      try {
        const res = await fetch(\`/api/sessions/\${encodeURIComponent(id)}/init\`, { method: 'POST' });
        const data = await res.json();
        viewQr(id);
        loadSessions();
      } catch (e) {
        alert('Failed to boot session: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Boot Session';
      }
    }

    function fillSender(sessionId) {
      document.getElementById('send-session-id').value = sessionId;
      document.getElementById('send-jid').focus();
    }

    async function viewQr(sessionId) {
      activeQrSession = sessionId;
      document.getElementById('qr-session-label').textContent = 'Session: ' + sessionId;

      if (qrPollInterval) clearInterval(qrPollInterval);
      await fetchAndDisplayQr();
      qrPollInterval = setInterval(fetchAndDisplayQr, 3000);
    }

    async function fetchAndDisplayQr() {
      if (!activeQrSession) return;
      try {
        const res = await fetch(\`/api/sessions/\${encodeURIComponent(activeQrSession)}/qr\`);
        const data = await res.json();
        const placeholder = document.getElementById('qr-placeholder');
        const img = document.getElementById('qr-image');
        const actions = document.getElementById('qr-actions');
        const badge = document.getElementById('qr-status-badge');

        if (data.status === 'connected') {
          img.classList.add('hidden');
          placeholder.classList.remove('hidden');
          placeholder.innerHTML = '<span class="text-emerald-400 font-semibold block text-base mb-1">✓ Connected</span>Session is actively authenticated with WhatsApp.';
          actions.classList.remove('hidden');
          badge.textContent = 'Active & Connected';
          badge.className = 'px-3 py-1 rounded-full text-xs font-medium badge-online';
          if (qrPollInterval) clearInterval(qrPollInterval);
          loadSessions();
        } else if (data.qrDataUrl) {
          img.src = data.qrDataUrl;
          img.classList.remove('hidden');
          placeholder.classList.add('hidden');
          actions.classList.remove('hidden');
          badge.textContent = 'Scan QR Code';
          badge.className = 'px-3 py-1 rounded-full text-xs font-medium badge-qr';
        } else {
          img.classList.add('hidden');
          placeholder.classList.remove('hidden');
          placeholder.textContent = data.message || 'Generating QR code string...';
          actions.classList.remove('hidden');
          badge.textContent = data.status || 'Waiting';
          badge.className = 'px-3 py-1 rounded-full text-xs font-medium bg-zinc-800 text-zinc-400';
        }
      } catch (err) {
        console.error('Error fetching QR', err);
      }
    }

    async function handleSendMessage(e) {
      e.preventDefault();
      const sessionId = document.getElementById('send-session-id').value.trim();
      const jid = document.getElementById('send-jid').value.trim();
      const text = document.getElementById('send-text').value.trim();
      const statusSpan = document.getElementById('send-status');
      const btn = document.getElementById('btn-send');

      btn.disabled = true;
      statusSpan.textContent = 'Simulating human composing (600-1400ms)...';
      statusSpan.className = 'text-xs text-amber-400';

      try {
        const res = await fetch(\`/api/sessions/\${encodeURIComponent(sessionId)}/send\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jid, text })
        });
        const data = await res.json();

        if (res.ok && data.success) {
          statusSpan.textContent = '✓ Message sent! ID: ' + data.messageId;
          statusSpan.className = 'text-xs text-emerald-400';
          document.getElementById('send-text').value = '';
        } else {
          statusSpan.textContent = 'Error: ' + (data.message || 'Failed to send');
          statusSpan.className = 'text-xs text-rose-400';
        }
      } catch (err) {
        statusSpan.textContent = 'Request failed: ' + err.message;
        statusSpan.className = 'text-xs text-rose-400';
      } finally {
        btn.disabled = false;
        fetchEvents();
      }
    }

    async function deleteSession(sessionId) {
      if (!confirm('Are you sure you want to disconnect and purge session ' + sessionId + '?')) return;
      try {
        await fetch(\`/api/sessions/\${encodeURIComponent(sessionId)}\`, { method: 'DELETE' });
        if (activeQrSession === sessionId) {
          activeQrSession = null;
          document.getElementById('qr-session-label').textContent = 'No session selected';
          document.getElementById('qr-image').classList.add('hidden');
          document.getElementById('qr-placeholder').classList.remove('hidden');
          document.getElementById('qr-placeholder').textContent = 'Session deleted.';
          document.getElementById('qr-actions').classList.add('hidden');
        }
        loadSessions();
        fetchEvents();
      } catch (err) {
        alert('Error deleting session: ' + err.message);
      }
    }

    async function fetchEvents() {
      try {
        const res = await fetch('/api/events');
        const data = await res.json();
        const feed = document.getElementById('events-feed');

        if (!data.events || data.events.length === 0) return;

        feed.innerHTML = data.events.slice(0, 15).map(ev => {
          let color = 'text-zinc-400';
          if (ev.type === 'inbound_message') color = 'text-cyan-400';
          else if (ev.type === 'outbound_message') color = 'text-emerald-400';
          else if (ev.type === 'webhook_dispatched') color = 'text-indigo-400';
          else if (ev.type === 'webhook_failed') color = 'text-rose-400';
          else if (ev.type === 'session_event') color = 'text-amber-400';

          const time = new Date(ev.timestamp).toLocaleTimeString();
          return \`
            <div class="p-2 rounded bg-zinc-950/80 border border-zinc-900 flex flex-col gap-0.5">
              <div class="flex items-center justify-between text-[11px]">
                <span class="\${color} font-semibold">[\${ev.type}]</span>
                <span class="text-zinc-600">\${time}</span>
              </div>
              <div class="text-zinc-400 truncate">
                \${ev.sessionId ? 'Session: ' + ev.sessionId + ' | ' : ''}\${JSON.stringify(ev.details)}
              </div>
            </div>
          \`;
        }).join('');
      } catch (err) {
        console.error('Error fetching events', err);
      }
    }

    // Initialize UI on load
    checkHealth();
    loadSessions();
    fetchEvents();
    setInterval(fetchEvents, 2000);
  </script>
</body>
</html>`;
}

/**
 * Direct launch entrypoint when run via node/tsx.
 */
export async function start() {
  try {
    // Pre-connect Redis
    await getRedisClient();

    const server = await buildServer();
    await server.listen({
      port: config.port,
      host: config.host,
    });

    logger.info(
      { port: config.port, host: config.host },
      `[Server] Botla WhatsApp Gateway running on http://${config.host}:${config.port}`
    );
  } catch (err: any) {
    logger.error({ err: err.message }, '[Server] Fatal startup error');
    process.exit(1);
  }
}

// Auto-boot if this file is the main entrypoint
start();
