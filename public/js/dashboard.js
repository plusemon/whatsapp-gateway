/**
 * Botla WhatsApp Gateway - Developer Diagnostic Dashboard
 * High-Density Dark-Mode Console (Postman-Lite + Live Terminal)
 * Zero-Build Vue 3 CDN (Composition API) Architecture
 */

(function () {
  'use strict';

  if (window.__BOTLA_DASHBOARD_INITIALIZED__) {
    return;
  }
  window.__BOTLA_DASHBOARD_INITIALIZED__ = true;

  const { createApp, ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } = Vue;

  const app = createApp({
    setup() {
      // --------------------------------------------------------------------------
      // 1. Navigation & Primary Views
      // --------------------------------------------------------------------------
      // 3 focused primary views: 'sessions' | 'console' | 'live-logs'
      const activeTab = ref('sessions');

      // --------------------------------------------------------------------------
      // 2. Metrics & Compact Header State
      // --------------------------------------------------------------------------
      const metrics = reactive({
        activeSockets: 0,
        gatewayStatus: 'Online',
        redisStatus: 'checking',
        waVersion: 'v2.3000.x',
        retention: '24h',
        isRefreshing: false,
      });

      // --------------------------------------------------------------------------
      // 3. Sessions State & Inline Pairing
      // --------------------------------------------------------------------------
      const sessions = ref([]);
      const newTenantId = ref('tenant-botla-1');
      const isBooting = ref(false);

      // Inline pairing state per session (prevents disorienting modals)
      // Keyed by sessionId: { isOpen, mode, phoneNumber, pairingCode, segments, qrImage, qrStatus, isFetchingCode, statusText, copied, pollTimer }
      const inlinePairing = reactive({});

      // Inline confirmation state for destructive actions (logout/purge)
      const confirmAction = reactive({
        type: null, // 'logout' | 'purge'
        sessionId: null,
        isProcessing: false,
      });

      // --------------------------------------------------------------------------
      // 4. View 2: API Console (Interactive Request Playground / Postman-Lite)
      // --------------------------------------------------------------------------
      const apiConsole = reactive({
        action: 'text', // 'text' | 'media' | 'webhook'
        sessionId: '',
        destination: '6281234567890@s.whatsapp.net',
        text: 'Hello from Botla WhatsApp Gateway! 🚀',
        presence: true, // anti-ban presence simulation (composing + randomized jitter)
        mediaType: 'image', // 'image' | 'document' | 'audio' | 'video'
        mediaUrl: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=600',
        caption: 'Diagnostic test asset attachment.',
        filename: 'botla-test-document.pdf',
        ptt: false,
        webhookUrl: 'http://localhost:8000/api/whatsapp/webhook',
        webhookSecret: '',
        webhookToken: '',
        webhookEvent: 'inbound_message',
        isDispatching: false,
        response: null, // { status, statusText, latencyMs, timestamp, method, endpoint, data, rawBody, copied }
      });

      // --------------------------------------------------------------------------
      // 5. View 3: Live Telemetry (Unified Terminal)
      // --------------------------------------------------------------------------
      const logs = ref([]);
      const gatewayEvents = ref([]);
      const telemetryFilter = ref('all'); // 'all' | 'inbound' | 'outbound' | 'ack' | 'error' | 'socket'
      const telemetrySearch = ref('');
      const autoScroll = ref(true);
      const isPaused = ref(false);
      // Non-destructive expansion map keyed by item id: { [id]: boolean }
      const expandedLogIds = reactive({});
      let sseSource = null;
      let pollIntervals = [];

      // --------------------------------------------------------------------------
      // 6. Toast Notifications
      // --------------------------------------------------------------------------
      const toasts = ref([]);
      let toastIdCounter = 0;

      const showToast = (message, type = 'info') => {
        const id = ++toastIdCounter;
        toasts.value.push({ id, message, type });
        setTimeout(() => {
          toasts.value = toasts.value.filter((t) => t.id !== id);
        }, 3200);
      };

      // --------------------------------------------------------------------------
      // HTTP Helpers
      // --------------------------------------------------------------------------
      const getAuthHeaders = () => {
        const apiKey =
          (typeof window !== 'undefined' &&
            (localStorage.getItem('botla_api_key') || window.__BOTLA_API_KEY__)) ||
          'botla-gateway-api-key';
        return {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        };
      };

      const safeFetchJson = async (url, options = {}) => {
        try {
          const headers = { ...getAuthHeaders(), ...(options.headers || {}) };
          const res = await fetch(url, { ...options, headers });
          const contentType = res.headers.get('content-type') || '';
          if (!res.ok) {
            if (contentType.includes('application/json')) {
              const body = await res.json().catch(() => null);
              return body || { success: false, status: res.status };
            }
            return { success: false, status: res.status, statusText: res.statusText };
          }
          if (!contentType.includes('application/json')) return null;
          return await res.json();
        } catch (err) {
          console.warn(`[API Network Error] ${url}:`, err?.message || err);
          return null;
        }
      };

      // --------------------------------------------------------------------------
      // Formatting Helpers
      // --------------------------------------------------------------------------
      const formatDisplayPhone = (userOrJid) => {
        if (!userOrJid) return 'Awaiting authentication';
        let raw = '';
        if (typeof userOrJid === 'object') {
          raw = userOrJid.id || userOrJid.jid || userOrJid.phone || userOrJid.name || '';
        } else {
          raw = String(userOrJid);
        }
        if (!raw) return 'Awaiting authentication';
        const cleanNumber = raw.split('@')[0].split(':')[0].replace(/\D/g, '');
        if (!cleanNumber) return raw;
        if (cleanNumber.length >= 10) {
          return `+${cleanNumber.slice(0, 3)} ${cleanNumber.slice(3, 7)}-${cleanNumber.slice(7)}`;
        }
        return `+${cleanNumber}`;
      };

      const getUserPushName = (user) => {
        if (!user || typeof user !== 'object') return null;
        return user.name || user.pushName || user.notify || null;
      };

      const stripAnsi = (str) => {
        if (!str) return '';
        return String(str).replace(/\x1b\[[0-9;]*m/g, '');
      };

      const formatClockTime = (timestamp) => {
        if (!timestamp) return '';
        const d = new Date(timestamp);
        return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
      };

      // --------------------------------------------------------------------------
      // Core Data Fetchers
      // --------------------------------------------------------------------------
      const fetchHealth = async () => {
        const data = await safeFetchJson('/api/health');
        if (data && data.success) {
          metrics.gatewayStatus = 'Online';
          const rStatus = data.data?.redis || data.redis;
          metrics.redisStatus = typeof rStatus === 'string' ? rStatus : rStatus?.status || (rStatus?.connected ? 'connected' : 'memory');
          metrics.retention = (data.data?.mediaRetentionHours || data.storage?.mediaRetentionHours) ? `${data.data?.mediaRetentionHours || data.storage?.mediaRetentionHours}h` : '24h';
        } else {
          metrics.gatewayStatus = 'Degraded';
        }

        const versionData = await safeFetchJson('/api/system/version');
        if (versionData && versionData.success && versionData.data) {
          metrics.waVersion = versionData.data.version || 'v2.3000.x';
        }
      };

      const fetchSessions = async () => {
        metrics.isRefreshing = true;
        try {
          const data = await safeFetchJson('/api/sessions');
          if (data && data.success) {
            const list = data.data?.sessions || data.sessions || [];
            sessions.value = list;
            metrics.activeSockets = list.filter((s) => s.status === 'connected').length;

            // Sync default target session in API Console
            if (list.length > 0) {
              const hasCurrent = list.some((s) => s.id === apiConsole.sessionId);
              if (!hasCurrent) {
                const connected = list.find((s) => s.status === 'connected');
                apiConsole.sessionId = connected ? connected.id : list[0].id;
              }
            }

            // Ensure inlinePairing state initialized for each session
            list.forEach((s) => {
              const sid = s.id;
              if (!inlinePairing[sid]) {
                inlinePairing[sid] = {
                  isOpen: false,
                  authTab: 'qr', // 'qr' | 'pair_code'
                  mode: 'qr',
                  phoneNumber: s.phone || '',
                  pairingCode: '',
                  pairingCodeSegments: [],
                  qrImage: '',
                  qrStatus: 'idle',
                  isFetchingCode: false,
                  statusText: '',
                  copied: false,
                  pollTimer: null,
                };
              }
            });
          }
        } finally {
          setTimeout(() => {
            metrics.isRefreshing = false;
          }, 350);
        }
      };

      const fetchWebhookSettings = async () => {
        const res = await safeFetchJson('/api/settings/webhook');
        if (res && res.success && res.data) {
          if (res.data.url) apiConsole.webhookUrl = res.data.url;
          if (res.data.secret) apiConsole.webhookSecret = res.data.secret;
          if (res.data.token) apiConsole.webhookToken = res.data.token;
        }
      };

      const fetchGatewayEvents = async () => {
        if (isPaused.value) return;
        const res = await safeFetchJson('/api/events');
        if (res && Array.isArray(res.events)) {
          gatewayEvents.value = res.events.map((evt, idx) => ({
            ...evt,
            id: evt.id || `evt-${idx}-${evt.timestamp || Date.now()}`,
          }));
        }
      };

      // --------------------------------------------------------------------------
      // Boot Tenant Session
      // --------------------------------------------------------------------------
      const bootSession = async () => {
        const id = newTenantId.value?.trim();
        if (!id) {
          showToast('Please specify a tenant identifier', 'warn');
          return;
        }

        isBooting.value = true;
        try {
          // Attempt v1 init then fallback to legacy (default naturally to QR)
          let res = await safeFetchJson('/api/v1/sessions/init', {
            method: 'POST',
            body: JSON.stringify({ sessionId: id, authMode: 'qr' }),
          });

          if (!res || !res.success) {
            res = await safeFetchJson(`/api/sessions/${encodeURIComponent(id)}/init`, {
              method: 'POST',
              body: JSON.stringify({ authMode: 'qr' }),
            });
          }

          if (res && res.success) {
            showToast(`Tenant session '${id}' booted!`, 'success');
            await fetchSessions();
            // Automatically open inline pairing for this session
            toggleInlinePairing(id, true);
          } else {
            showToast(res?.error?.message || res?.message || 'Failed to initialize session', 'error');
          }
        } catch (err) {
          showToast(`Boot error: ${err.message}`, 'error');
        } finally {
          isBooting.value = false;
        }
      };

      // --------------------------------------------------------------------------
      // Inline Pairing Accordion & LifeCycle (Flexible Dual-Mode Auth)
      // --------------------------------------------------------------------------
      const stopSessionQrPoll = (sessionId) => {
        const state = inlinePairing[sessionId];
        if (state && state.pollTimer) {
          clearInterval(state.pollTimer);
          state.pollTimer = null;
        }
      };

      const toggleInlinePairing = (sessionId, forceOpen = null) => {
        if (!inlinePairing[sessionId]) {
          inlinePairing[sessionId] = {
            isOpen: false,
            authTab: 'qr',
            mode: 'qr',
            phoneNumber: '',
            pairingCode: '',
            pairingCodeSegments: [],
            qrImage: '',
            qrStatus: 'idle',
            isFetchingCode: false,
            statusText: '',
            copied: false,
            pollTimer: null,
          };
        }

        const state = inlinePairing[sessionId];
        state.isOpen = forceOpen !== null ? forceOpen : !state.isOpen;

        // When closed, stop polling; when open on QR tab, start poll
        if (!state.isOpen) {
          stopSessionQrPoll(sessionId);
        } else if (state.authTab === 'qr' || state.mode === 'qr') {
          startSessionQrPoll(sessionId);
        }
      };

      const setAuthTab = (sessionId, tab) => {
        const state = inlinePairing[sessionId];
        if (!state) return;
        state.authTab = tab;
        state.mode = (tab === 'pair_code' || tab === 'phone') ? 'phone' : 'qr';
        if (state.authTab === 'qr' || state.mode === 'qr') {
          startSessionQrPoll(sessionId);
        }
      };

      const setPairingMode = (sessionId, mode) => {
        setAuthTab(sessionId, mode === 'phone' ? 'pair_code' : mode);
      };

      const fetchSessionQr = async (sessionId) => {
        const state = inlinePairing[sessionId];
        if (!state || (state.authTab !== 'qr' && state.mode !== 'qr')) return;
        const res = await safeFetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/qr`);
        if (res && res.success && res.data) {
          if (res.data.qrDataUrl) {
            state.qrImage = res.data.qrDataUrl;
          }
          state.qrStatus = res.data.status || 'qr_ready';
          if (res.data.status === 'connected') {
            stopSessionQrPoll(sessionId);
            showToast(`Session '${sessionId}' linked!`, 'success');
            state.isOpen = false;
            fetchSessions();
          }
        }
      };

      const startSessionQrPoll = (sessionId) => {
        stopSessionQrPoll(sessionId);
        const state = inlinePairing[sessionId];
        if (!state) return;
        if (!state.qrImage) {
          state.qrStatus = 'connecting';
        }
        fetchSessionQr(sessionId);
        state.pollTimer = setInterval(() => {
          if ((state.authTab === 'qr' || state.mode === 'qr') && state.isOpen) {
            fetchSessionQr(sessionId);
          } else {
            stopSessionQrPoll(sessionId);
          }
        }, 3000);
      };

      const requestPairingCode = async (sessionId) => {
        const state = inlinePairing[sessionId];
        if (!state) return;

        const cleanPhone = (state.phoneNumber || '').trim().replace(/\D/g, '');
        if (cleanPhone.length < 6) {
          showToast('Please enter a valid phone number with country code (e.g. 8801995329555)', 'warn');
          return;
        }

        state.isFetchingCode = true;
        state.statusText = 'Generating pairing code with desktop signature...';
        // HARDENED RULE: Suppress any QR timers to avoid pre-key corruption race condition
        stopSessionQrPoll(sessionId);

        try {
          let res = await safeFetchJson('/api/v1/sessions/pair-code', {
            method: 'POST',
            body: JSON.stringify({
              sessionId,
              phoneNumber: cleanPhone,
            }),
          });

          if (!res || !res.success) {
            res = await safeFetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/pair-code`, {
              method: 'POST',
              body: JSON.stringify({
                phoneNumber: cleanPhone,
              }),
            });
          }

          if (res && res.success) {
            const rawCode = res.data?.pairingCode || res.code || res.data?.code || '';
            if (rawCode) {
              // Clean into 8 characters
              const formatted = rawCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
              state.pairingCode = formatted.length === 8 ? `${formatted.slice(0, 4)}-${formatted.slice(4)}` : formatted;
              // Build 8 segmented characters
              const chars = formatted.slice(0, 8).split('');
              state.pairingCodeSegments = chars;
              state.statusText = 'Pairing code generated! Open WhatsApp > Linked Devices > Link with phone number.';
              showToast('Pairing code generated!', 'success');
            } else {
              state.statusText = 'Received response without code. Please try again.';
            }
          } else {
            const err = res?.error?.message || res?.message || 'Failed to request pairing code';
            state.statusText = `Error: ${err}`;
            showToast(err, 'error');
          }
        } catch (err) {
          state.statusText = `Request error: ${err.message}`;
          showToast(`Error: ${err.message}`, 'error');
        } finally {
          state.isFetchingCode = false;
        }
      };

      const copyPairingCode = (sessionId) => {
        const state = inlinePairing[sessionId];
        if (!state || !state.pairingCode) return;
        const codeToCopy = state.pairingCode.replace(/-/g, '');
        copyToClipboard(codeToCopy);
        state.copied = true;
        setTimeout(() => {
          state.copied = false;
        }, 1800);
      };

      // --------------------------------------------------------------------------
      // Disconnect & Purge Actions
      // --------------------------------------------------------------------------
      const promptConfirmAction = (type, sessionId) => {
        confirmAction.type = type;
        confirmAction.sessionId = sessionId;
      };

      const cancelConfirmAction = () => {
        confirmAction.type = null;
        confirmAction.sessionId = null;
        confirmAction.isProcessing = false;
      };

      const executeConfirmAction = async () => {
        const { type, sessionId } = confirmAction;
        if (!type || !sessionId) return;

        confirmAction.isProcessing = true;
        try {
          if (type === 'logout') {
            // Disconnect / logout
            let res = await safeFetchJson(`/api/v1/sessions/${encodeURIComponent(sessionId)}/logout`, {
              method: 'POST',
              body: JSON.stringify({}),
            });
            if (!res || !res.success) {
              res = await safeFetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/logout`, {
                method: 'POST',
                body: JSON.stringify({}),
              });
            }
            if (res && res.success) {
              showToast(`Session '${sessionId}' logged out cleanly`, 'success');
              await fetchSessions();
            } else {
              showToast(res?.error?.message || 'Logout failed', 'error');
            }
          } else if (type === 'purge') {
            // Purge memory and Redis keys
            let res = await safeFetchJson(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
              method: 'DELETE',
            });
            if (!res || !res.success) {
              res = await safeFetchJson(`/api/sessions/${encodeURIComponent(sessionId)}`, {
                method: 'DELETE',
              });
            }
            if (!res || !res.success) {
              res = await safeFetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/purge`, {
                method: 'POST',
                body: JSON.stringify({}),
              });
            }
            if (res && res.success) {
              showToast(`Session '${sessionId}' purged`, 'success');
              stopSessionQrPoll(sessionId);
              delete inlinePairing[sessionId];
              await fetchSessions();
            } else {
              showToast(res?.error?.message || 'Purge failed', 'error');
            }
          }
        } catch (err) {
          showToast(`Action failed: ${err.message}`, 'error');
        } finally {
          cancelConfirmAction();
        }
      };

      // --------------------------------------------------------------------------
      // Quick Transition to API Console
      // --------------------------------------------------------------------------
      const jumpToApiConsole = (session) => {
        const sid = session.id || session.sessionId;
        apiConsole.sessionId = sid;
        activeTab.value = 'console';
        showToast(`API Console opened with session '${sid}'`, 'info');
      };

      // --------------------------------------------------------------------------
      // View 2: API Console Request Execution
      // --------------------------------------------------------------------------
      const dispatchApiRequest = async () => {
        if (!apiConsole.sessionId && apiConsole.action !== 'webhook') {
          showToast('Please select a target session', 'warn');
          return;
        }

        apiConsole.isDispatching = true;
        apiConsole.response = null;

        const startTime = performance.now();
        let targetUrl = '';
        let reqMethod = 'POST';
        let reqBody = {};

        try {
          if (apiConsole.action === 'text') {
            targetUrl = '/api/v1/messages/send-text';
            reqBody = {
              sessionId: apiConsole.sessionId,
              to: apiConsole.destination.trim(),
              message: apiConsole.text.trim(),
              presence: !!apiConsole.presence,
            };
          } else if (apiConsole.action === 'media') {
            targetUrl = '/api/v1/messages/send-media';
            reqBody = {
              sessionId: apiConsole.sessionId,
              to: apiConsole.destination.trim(),
              mediaType: apiConsole.mediaType,
              mediaUrl: apiConsole.mediaUrl.trim(),
              caption: apiConsole.caption ? apiConsole.caption.trim() : undefined,
              fileName: apiConsole.filename ? apiConsole.filename.trim() : undefined,
            };
          } else if (apiConsole.action === 'webhook') {
            targetUrl = '/api/settings/webhook/test';
            reqBody = {
              url: apiConsole.webhookUrl.trim(),
              secret: apiConsole.webhookSecret,
              token: apiConsole.webhookToken,
            };
          }

          const headers = { ...getAuthHeaders() };
          const res = await fetch(targetUrl, {
            method: reqMethod,
            headers,
            body: JSON.stringify(reqBody),
          });

          const latencyMs = Math.round(performance.now() - startTime);
          const contentType = res.headers.get('content-type') || '';
          let data = null;

          if (contentType.includes('application/json')) {
            data = await res.json().catch(() => ({ error: 'Failed to parse JSON response' }));
          } else {
            const rawText = await res.text().catch(() => '');
            data = { rawText };
          }

          // Capture headers summary
          const respHeaders = {
            'content-type': contentType,
            'x-ratelimit-remaining': res.headers.get('x-ratelimit-remaining') || undefined,
            'x-request-id': res.headers.get('x-request-id') || undefined,
          };

          apiConsole.response = {
            status: res.status,
            statusText: res.statusText || (res.status === 200 ? 'OK' : 'Response'),
            latencyMs,
            timestamp: new Date().toISOString(),
            method: reqMethod,
            endpoint: targetUrl,
            headers: respHeaders,
            data,
            rawBody: JSON.stringify(data, null, 2),
            copied: false,
          };

          if (res.ok && (data?.success !== false)) {
            showToast(`Request successful (${latencyMs}ms)`, 'success');
          } else {
            showToast(`Request returned HTTP ${res.status}`, 'warn');
          }
        } catch (err) {
          const latencyMs = Math.round(performance.now() - startTime);
          apiConsole.response = {
            status: 0,
            statusText: 'Network Error',
            latencyMs,
            timestamp: new Date().toISOString(),
            method: reqMethod,
            endpoint: targetUrl,
            headers: {},
            data: { success: false, error: err.message },
            rawBody: JSON.stringify({ error: err.message }, null, 2),
            copied: false,
          };
          showToast(`Dispatch failed: ${err.message}`, 'error');
        } finally {
          apiConsole.isDispatching = false;
        }
      };

      const copyApiResponse = () => {
        if (!apiConsole.response || !apiConsole.response.rawBody) return;
        copyToClipboard(apiConsole.response.rawBody);
        apiConsole.response.copied = true;
        setTimeout(() => {
          if (apiConsole.response) apiConsole.response.copied = false;
        }, 1800);
      };

      // --------------------------------------------------------------------------
      // View 3: Live Telemetry Stream Processing & Non-Destructive Expansion
      // --------------------------------------------------------------------------
      const initSSE = () => {
        if (sseSource) {
          try {
            sseSource.close();
          } catch {}
        }

        try {
          sseSource = new EventSource('/api/logs/stream');

          sseSource.onmessage = (event) => {
            if (!event.data) return;
            try {
              const payload = JSON.parse(event.data);

              // Auto-resolve pairing if connected event fires for session
              const action = payload.action || payload.meta?.action || payload.event;
              const targetSession = payload.sessionId || payload.meta?.sessionId;

              if (
                (action === 'session_connected' ||
                  action === 'connected' ||
                  (payload.message && payload.message.includes('successfully connected'))) &&
                targetSession
              ) {
                if (inlinePairing[targetSession]) {
                  inlinePairing[targetSession].isOpen = false;
                  stopSessionQrPoll(targetSession);
                }
                showToast(`Session '${targetSession}' linked & connected!`, 'success');
                fetchSessions();
              }

              if (payload.type === 'gateway_event') {
                if (!isPaused.value) {
                  const evId = payload.id || `evt-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
                  gatewayEvents.value.unshift({ ...payload, id: evId });
                  if (gatewayEvents.value.length > 200) gatewayEvents.value.pop();
                }
              } else {
                if (!isPaused.value) {
                  const logId = payload.id || `log-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
                  logs.value.unshift({ ...payload, id: logId });
                  if (logs.value.length > 300) logs.value.pop();
                }
              }

              if (autoScroll.value && !isPaused.value) {
                nextTick(() => {
                  const container = document.getElementById('telemetry-terminal-feed');
                  if (container) container.scrollTop = 0;
                });
              }
            } catch {
              // Heartbeat
            }
          };

          sseSource.onerror = () => {
            // EventSource auto-reconnects
          };
        } catch (err) {
          console.warn('SSE stream unavailable:', err);
        }
      };

      // Level badge class resolver for compact telemetry badges
      const getLevelBadgeClass = (level) => {
        const l = (level || '').toLowerCase();
        if (l === 'error' || l === 'fatal') {
          return 'bg-rose-500/20 text-rose-300 border border-rose-500/30';
        }
        if (l === 'warn') {
          return 'bg-amber-500/20 text-amber-300 border border-amber-500/30';
        }
        if (l === 'inbound') {
          return 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
        }
        if (l === 'outbound') {
          return 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30';
        }
        if (l === 'ack') {
          return 'bg-purple-500/20 text-purple-300 border border-purple-500/30';
        }
        if (l === 'socket') {
          return 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30';
        }
        return 'bg-slate-800 text-slate-300 border border-slate-700/60';
      };

      // Unified Telemetry stream that maps logs & gateway events into a standardized item
      const unifiedStream = computed(() => {
        const combined = [];

        // Map logs
        logs.value.forEach((l) => {
          const rawMsg = l.message || l.msg || '';
          const msg = stripAnsi(rawMsg);
          const lvl = (l.level || 'info').toLowerCase();
          let kind = 'info';
          let levelLabel = 'INFO';
          if (lvl === 'error' || lvl === 'fatal') {
            kind = 'error';
            levelLabel = 'ERROR';
          } else if (lvl === 'warn') {
            kind = 'warn';
            levelLabel = 'WARN';
          } else {
            levelLabel = lvl.toUpperCase();
          }

          const ts = l.timestamp || new Date().toISOString();
          const timeFormatted = formatClockTime(ts);
          const metaPayload = l.meta || l.payload || (Object.keys(l).length > 4 ? l : null);
          const itemId = l.id || `log-${ts}`;

          combined.push({
            id: itemId,
            timestamp: ts,
            timeFormatted,
            kind, // 'info' | 'warn' | 'error' | 'inbound' | 'outbound' | 'ack' | 'socket'
            level: lvl,
            levelLabel,
            tag: levelLabel,
            sessionId: l.sessionId || l.meta?.sessionId || null,
            message: msg,
            msg,
            meta: metaPayload,
            payload: metaPayload,
            get expanded() {
              return !!expandedLogIds[itemId];
            },
            set expanded(val) {
              expandedLogIds[itemId] = !!val;
            },
            source: 'log',
          });
        });

        // Map gateway events
        gatewayEvents.value.forEach((e) => {
          const type = (e.type || '').toLowerCase();
          let kind = 'socket';
          let level = 'socket';
          let levelLabel = 'EVENT';

          if (type.includes('inbound') || e.event === 'message.received') {
            kind = 'inbound';
            level = 'inbound';
            levelLabel = 'INBOUND';
          } else if (type.includes('outbound') || e.event === 'message.sent') {
            kind = 'outbound';
            level = 'outbound';
            levelLabel = 'OUTBOUND';
          } else if (type.includes('ack') || e.event === 'message.ack') {
            kind = 'ack';
            level = 'ack';
            levelLabel = 'ACK';
          } else if (type.includes('error')) {
            kind = 'error';
            level = 'error';
            levelLabel = 'ERROR';
          } else if (type.includes('session') || e.event === 'session.state') {
            kind = 'socket';
            level = 'socket';
            levelLabel = 'SOCKET';
          }

          const ts = e.timestamp || new Date().toISOString();
          const timeFormatted = formatClockTime(ts);
          const rawMsg = e.message || e.msg || e.event || `${levelLabel} event received`;
          const msg = stripAnsi(rawMsg);
          const metaPayload = e.payload || e.meta || e.details || e;
          const itemId = e.id || `evt-${ts}`;

          combined.push({
            id: itemId,
            timestamp: ts,
            timeFormatted,
            kind,
            level,
            levelLabel,
            tag: levelLabel,
            sessionId: e.sessionId || null,
            message: msg,
            msg,
            meta: metaPayload,
            payload: metaPayload,
            get expanded() {
              return !!expandedLogIds[itemId];
            },
            set expanded(val) {
              expandedLogIds[itemId] = !!val;
            },
            source: 'event',
          });
        });

        // Sort descending by timestamp
        combined.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        // Apply filters
        let result = combined;
        if (telemetryFilter.value !== 'all') {
          result = result.filter((item) => {
            if (telemetryFilter.value === 'inbound') return item.kind === 'inbound';
            if (telemetryFilter.value === 'outbound') return item.kind === 'outbound';
            if (telemetryFilter.value === 'ack') return item.kind === 'ack';
            if (telemetryFilter.value === 'error') return item.kind === 'error' || item.kind === 'warn';
            if (telemetryFilter.value === 'socket') return item.kind === 'socket' || item.kind === 'info';
            return true;
          });
        }

        if (telemetrySearch.value.trim()) {
          const q = telemetrySearch.value.trim().toLowerCase();
          result = result.filter(
            (item) =>
              (item.message && item.message.toLowerCase().includes(q)) ||
              (item.sessionId && item.sessionId.toLowerCase().includes(q)) ||
              (item.tag && item.tag.toLowerCase().includes(q))
          );
        }

        return result;
      });

      // Toggle expanded JSON state without losing state on updates
      const toggleExpandLog = (itemOrId) => {
        const id = typeof itemOrId === 'object' && itemOrId !== null ? itemOrId.id : itemOrId;
        expandedLogIds[id] = !expandedLogIds[id];
      };

      const copyTelemetryStream = (format = 'text') => {
        const list = unifiedStream.value;
        if (!list || list.length === 0) {
          showToast('No logs to copy', 'warn');
          return;
        }

        let content = '';
        if (format === 'json') {
          content = JSON.stringify(list, null, 2);
        } else {
          content = list
            .map(
              (l) =>
                `[${formatClockTime(l.timestamp)}] [${l.tag}] ${l.sessionId ? `[${l.sessionId}] ` : ''}${l.message}`
            )
            .join('\n');
        }

        copyToClipboard(content);
        showToast(`Copied ${list.length} log lines`, 'info');
      };

      const clearTelemetry = () => {
        logs.value = [];
        gatewayEvents.value = [];
        showToast('Terminal buffer cleared', 'info');
      };

      // --------------------------------------------------------------------------
      // Utility Helpers
      // --------------------------------------------------------------------------
      const copyToClipboard = async (text) => {
        try {
          const content = typeof text === 'object' ? JSON.stringify(text, null, 2) : String(text);
          await navigator.clipboard.writeText(content);
          showToast('Copied to clipboard', 'info');
        } catch {
          showToast('Failed to copy to clipboard', 'error');
        }
      };

      const manualRefreshAll = async () => {
        metrics.isRefreshing = true;
        try {
          await Promise.all([
            fetchHealth(),
            fetchSessions(),
            fetchWebhookSettings(),
            fetchGatewayEvents(),
          ]);
          showToast('Telemetry and sessions synchronized', 'info');
        } finally {
          setTimeout(() => {
            metrics.isRefreshing = false;
          }, 350);
        }
      };

      // --------------------------------------------------------------------------
      // Lifecycle Hooks
      // --------------------------------------------------------------------------
      onMounted(() => {
        fetchHealth();
        fetchSessions();
        fetchWebhookSettings();
        fetchGatewayEvents();
        initSSE();

        pollIntervals.push(setInterval(fetchHealth, 8000));
        pollIntervals.push(setInterval(fetchSessions, 12000));
        pollIntervals.push(setInterval(fetchGatewayEvents, 5000));

        window.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            cancelConfirmAction();
          }
        });
      });

      onBeforeUnmount(() => {
        Object.keys(inlinePairing).forEach((sid) => stopSessionQrPoll(sid));
        if (sseSource) {
          try {
            sseSource.close();
          } catch {}
        }
        pollIntervals.forEach(clearInterval);
        pollIntervals = [];
      });

      return {
        // Navigation
        activeTab,

        // Header & Telemetry
        metrics,
        manualRefreshAll,
        fetchSessions,
        getLevelBadgeClass,

        // Sessions View
        sessions,
        newTenantId,
        isBooting,
        bootSession,
        inlinePairing,
        toggleInlinePairing,
        setPairingMode,
        setAuthTab,
        requestPairingCode,
        copyPairingCode,
        startSessionQrPoll,
        confirmAction,
        promptConfirmAction,
        cancelConfirmAction,
        executeConfirmAction,
        jumpToApiConsole,

        // API Console View
        apiConsole,
        dispatchApiRequest,
        copyApiResponse,

        // Telemetry View
        unifiedStream,
        telemetryFilter,
        telemetrySearch,
        autoScroll,
        isPaused,
        expandedLogIds,
        toggleExpandLog,
        copyTelemetryStream,
        clearTelemetry,

        // Helpers
        toasts,
        formatDisplayPhone,
        getUserPushName,
        formatClockTime,
        copyToClipboard,
      };
    },
  });

  function mountVueDashboard() {
    if (document.getElementById('app')) {
      app.mount('#app');
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        app.mount('#app');
      });
    }
  }

  mountVueDashboard();
})();
