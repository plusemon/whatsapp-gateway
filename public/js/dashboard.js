/**
 * Botla WhatsApp Gateway - Frontend Application
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
    // 1. Navigation & Tab Views
    // --------------------------------------------------------------------------
    const activeTab = ref('sessions'); // 'sessions' | 'console' | 'live-logs'
    const liveLogTab = ref('logs'); // 'logs' | 'events'
    const consoleTab = ref('text'); // 'text' | 'media'

    // --------------------------------------------------------------------------
    // 2. Metrics & Telemetry
    // --------------------------------------------------------------------------
    const metrics = reactive({
      activeSockets: 0,
      statePersistence: 'Redis Adapter',
      antiBan: 'Human Emulation',
      gatewayStatus: 'Online',
      redisStatus: 'checking',
      waVersion: 'loading',
      retention: '24h',
      isRefreshing: false,
    });

    // --------------------------------------------------------------------------
    // 3. Sessions State
    // --------------------------------------------------------------------------
    const sessions = ref([]);
    const newTenantId = ref('tenant-botla-1');
    const isBooting = ref(false);

    // --------------------------------------------------------------------------
    // 4. Pairing Modal State
    // --------------------------------------------------------------------------
    const pairingModal = reactive({
      isOpen: false,
      sessionId: '',
      mode: 'phone', // 'phone' | 'qr'
      phoneNumber: '',
      pairingCode: '',
      qrImage: '',
      qrStatus: 'connecting',
      pollTimer: null,
      isFetchingCode: false,
      isConnected: false,
      statusText: '',
      copied: false,
    });

    // --------------------------------------------------------------------------
    // 5. Webhook Settings State
    // --------------------------------------------------------------------------
    const webhookModal = reactive({
      isOpen: false,
      enabled: false,
      url: 'http://localhost:8000/api/whatsapp/webhook',
      secret: '',
      token: '',
      showSecret: false,
      events: { inbound: true, ack: true, status: true },
      stats: { totalSent: 0, success: 0, failures: 0 },
      source: 'GLOBAL',
      isSaving: false,
      pingStatus: null,
      isPinging: false,
      copied: false,
    });

    // --------------------------------------------------------------------------
    // 6. Console / Outbound Message & Media Dispatcher
    // --------------------------------------------------------------------------
    const quickSend = reactive({
      sessionId: 'tenant-botla-1',
      jid: '6281234567890@s.whatsapp.net',
      text: 'Hello from Botla WhatsApp Gateway! 🚀',
      isSending: false,
      status: '',
      statusType: '',
    });

    const advancedSend = reactive({
      sessionId: 'tenant-botla-1',
      jid: '6281234567890@s.whatsapp.net',
      text: 'Hello from Botla WhatsApp Gateway! 🚀',
      isSending: false,
      status: '',
      statusType: '',
    });

    const mediaSend = reactive({
      sessionId: 'tenant-botla-1',
      jid: '6281234567890@s.whatsapp.net',
      type: 'image',
      url: 'https://images.unsplash.com/photo-1579546929518-9e396f3cc809?w=400',
      caption: 'Here is your attached receipt.',
      filename: 'monthly-statement.pdf',
      ptt: false,
      isSending: false,
      status: '',
      statusType: '',
    });

    // --------------------------------------------------------------------------
    // 7. Confirmation Modals (Logout & Purge)
    // --------------------------------------------------------------------------
    const logoutModal = reactive({
      isOpen: false,
      sessionId: '',
      isLoggingOut: false,
    });

    const purgeModal = reactive({
      isOpen: false,
      sessionId: '',
      isPurging: false,
    });

    // --------------------------------------------------------------------------
    // 8. Live Logs & Telemetry
    // --------------------------------------------------------------------------
    const logs = ref([]);
    const gatewayEvents = ref([]);
    const autoScroll = ref(true);
    const eventsAutoScroll = ref(true);
    const logLevelFilter = ref('all');
    const logSessionFilter = ref('');
    const logsPaused = ref(false);
    const eventFilter = ref('all');
    const eventSessionFilter = ref('');
    const eventsPaused = ref(false);
    let sseSource = null;
    let pollIntervals = [];

    // --------------------------------------------------------------------------
    // 9. Toast Notifications
    // --------------------------------------------------------------------------
    const toasts = ref([]);
    let toastIdCounter = 0;

    const showToast = (message, type = 'info') => {
      const id = ++toastIdCounter;
      toasts.value.push({ id, message, type });
      setTimeout(() => {
        toasts.value = toasts.value.filter(t => t.id !== id);
      }, 3500);
    };

    // --------------------------------------------------------------------------
    // HTTP Helpers
    // --------------------------------------------------------------------------
    const getAuthHeaders = () => {
      const apiKey = (typeof window !== 'undefined' && (localStorage.getItem('botla_api_key') || window.__BOTLA_API_KEY__)) || 'botla-gateway-api-key';
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
        console.warn(`[API] Network notice on ${url}:`, err?.message || err);
        return null;
      }
    };

    // Formatting Helpers
    const formatDisplayPhone = (jid) => {
      if (!jid) return 'Awaiting authentication';
      const raw = typeof jid === 'object' ? (jid.id || jid.jid || jid.phone || jid.name || '') : String(jid);
      if (!raw) return 'Awaiting authentication';
      const cleanNumber = raw.split('@')[0].split(':')[0].replace(/\D/g, '');
      if (!cleanNumber) return raw;
      return `+${cleanNumber.slice(0, 3)} ${cleanNumber.slice(3, 7)}-${cleanNumber.slice(7)}`;
    };

    const formatSessionTarget = (user) => {
      if (!user) return 'Awaiting authentication';
      if (typeof user === 'string') {
        return formatDisplayPhone(user);
      }
      const phone = formatDisplayPhone(user.id || user.jid || user.phone);
      const pushName = user.name || user.pushName || user.notify;
      if (pushName && phone !== 'Awaiting authentication' && !phone.includes(pushName)) {
        return `${phone} (${pushName})`;
      }
      if (pushName && phone === 'Awaiting authentication') {
        return pushName;
      }
      return phone;
    };

    const getRelativeTime = (timestamp) => {
      if (!timestamp) return '';
      const now = Date.now();
      const time = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
      const diffSec = Math.floor((now - time) / 1000);
      if (diffSec < 5) return 'just now';
      if (diffSec < 60) return `${diffSec}s ago`;
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) return `${diffMin}m ago`;
      const diffHr = Math.floor(diffMin / 60);
      if (diffHr < 24) return `${diffHr}h ago`;
      const diffDays = Math.floor(diffHr / 24);
      return `${diffDays}d ago`;
    };

    const getClockTime = (timestamp) => {
      if (!timestamp) return '';
      const d = new Date(timestamp);
      return isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
    };

    const stripAnsi = (str) => {
      if (!str) return '';
      return str.replace(/\x1b\[[0-9;]*m/g, '');
    };

    // --------------------------------------------------------------------------
    // Core Methods & Data Fetchers
    // --------------------------------------------------------------------------
    const fetchHealth = async () => {
      const data = await safeFetchJson('/api/health');
      if (data && data.success) {
        metrics.gatewayStatus = 'Online';
        metrics.redisStatus = data.redis?.status || (data.redis?.connected ? 'connected' : 'memory');
        metrics.retention = data.storage?.mediaRetentionHours ? `${data.storage.mediaRetentionHours}h` : '24h';
      } else {
        metrics.gatewayStatus = 'Degraded';
      }

      const versionData = await safeFetchJson('/api/system/version');
      if (versionData && versionData.success && versionData.data) {
        metrics.waVersion = versionData.data.version || 'v2.3000.x';
      }
    };

    const fetchSessions = async () => {
      const data = await safeFetchJson('/api/sessions');
      if (data && data.success) {
        const list = data.data?.sessions || data.sessions || [];
        sessions.value = list;
        metrics.activeSockets = list.filter(s => s.status === 'connected').length;

        // Keep quick send dropdown / default session updated
        if (list.length > 0 && !list.find(s => s.id === quickSend.sessionId)) {
          quickSend.sessionId = list[0].id;
          advancedSend.sessionId = list[0].id;
          mediaSend.sessionId = list[0].id;
        }
      }
    };

    const setSessionInput = (tenant) => {
      newTenantId.value = tenant;
    };

    const initSession = async () => {
      const id = newTenantId.value?.trim();
      if (!id) {
        showToast('Please specify a session identifier', 'warn');
        return;
      }

      isBooting.value = true;
      try {
        const res = await safeFetchJson(`/api/sessions/${encodeURIComponent(id)}/init`, {
          method: 'POST',
          body: JSON.stringify({ authMode: 'pairing_code' }),
        });

        if (res && res.success) {
          showToast(`Session '${id}' booted successfully!`, 'success');
          await fetchSessions();
          openPairing({ id, sessionId: id }, 'phone');
        } else {
          showToast(res?.error?.message || res?.message || 'Failed to initialize session', 'error');
        }
      } catch (err) {
        showToast(`Error initializing: ${err.message}`, 'error');
      } finally {
        isBooting.value = false;
      }
    };

    // --------------------------------------------------------------------------
    // Pairing Lifecycle & Polling Isolation
    // --------------------------------------------------------------------------
    const stopPairingTimers = () => {
      if (pairingModal.pollTimer) {
        clearInterval(pairingModal.pollTimer);
        pairingModal.pollTimer = null;
      }
    };

    const closePairingModal = () => {
      stopPairingTimers();
      pairingModal.isOpen = false;
      pairingModal.pairingCode = '';
      pairingModal.qrImage = '';
      pairingModal.isConnected = false;
      pairingModal.statusText = '';
      pairingModal.isFetchingCode = false;
    };

    // Auto-stop QR polling if user switches to Phone Code mode
    watch(() => pairingModal.mode, (newMode) => {
      if (newMode !== 'qr') {
        stopPairingTimers();
      } else {
        startQrPolling();
      }
    });

    const fetchQrCode = async (sessionId) => {
      if (!sessionId || pairingModal.mode !== 'qr') return;
      const res = await safeFetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/qr`);
      if (res && res.success && res.data) {
        if (res.data.qrDataUrl) {
          pairingModal.qrImage = res.data.qrDataUrl;
        }
        pairingModal.qrStatus = res.data.status || 'qr_ready';
        if (res.data.status === 'connected') {
          pairingModal.isConnected = true;
          stopPairingTimers();
          showToast(`Session '${sessionId}' linked and connected!`, 'success');
          setTimeout(() => closePairingModal(), 1500);
          fetchSessions();
        }
      }
    };

    const startQrPolling = () => {
      stopPairingTimers();
      if (!pairingModal.sessionId) return;
      pairingModal.qrImage = '';
      pairingModal.qrStatus = 'connecting';
      fetchQrCode(pairingModal.sessionId);
      pairingModal.pollTimer = setInterval(() => {
        if (pairingModal.mode === 'qr' && pairingModal.isOpen) {
          fetchQrCode(pairingModal.sessionId);
        } else {
          stopPairingTimers();
        }
      }, 3000);
    };

    const openPairing = (session, defaultMode = 'phone') => {
      const sessId = session.sessionId || session.id;
      pairingModal.sessionId = sessId;
      pairingModal.mode = defaultMode;
      pairingModal.phoneNumber = session.phone || '';
      pairingModal.pairingCode = '';
      pairingModal.qrImage = '';
      pairingModal.isConnected = session.status === 'connected';
      pairingModal.statusText = '';
      pairingModal.isOpen = true;

      if (defaultMode === 'qr') {
        startQrPolling();
      } else {
        stopPairingTimers();
      }
    };

    const requestPairingCode = async () => {
      if (!pairingModal.phoneNumber || pairingModal.phoneNumber.trim().length < 6) {
        showToast('Please enter a valid phone number with country code', 'warn');
        return;
      }
      pairingModal.isFetchingCode = true;
      pairingModal.statusText = 'Generating pairing code...';
      stopPairingTimers(); // Ensure QR poll is terminated to prevent pre-key race condition

      try {
        let res = await safeFetchJson('/api/v1/sessions/pair-code', {
          method: 'POST',
          body: JSON.stringify({
            sessionId: pairingModal.sessionId,
            phoneNumber: pairingModal.phoneNumber.trim(),
          }),
        });

        // Fallback to legacy endpoint if v1 returns non-success
        if (!res || !res.success) {
          res = await safeFetchJson(`/api/sessions/${encodeURIComponent(pairingModal.sessionId)}/pair-code`, {
            method: 'POST',
            body: JSON.stringify({
              phoneNumber: pairingModal.phoneNumber.trim(),
            }),
          });
        }

        if (res && res.success) {
          const code = res.data?.pairingCode || res.code || res.data?.code;
          if (code) {
            pairingModal.pairingCode = code;
            pairingModal.statusText = 'Pairing code generated. Enter this into WhatsApp Linked Devices.';
            showToast('Pairing code generated!', 'success');
          } else {
            pairingModal.statusText = 'Received response without code. Please try again.';
          }
        } else {
          const err = res?.error?.message || res?.message || 'Failed to request pairing code';
          pairingModal.statusText = `Error: ${err}`;
          showToast(err, 'error');
        }
      } catch (err) {
        pairingModal.statusText = `Request error: ${err.message}`;
        showToast(`Request failed: ${err.message}`, 'error');
      } finally {
        pairingModal.isFetchingCode = false;
      }
    };

    // --------------------------------------------------------------------------
    // Logout & Purge Modals
    // --------------------------------------------------------------------------
    const openLogoutModal = (sessionId) => {
      logoutModal.sessionId = sessionId;
      logoutModal.isOpen = true;
    };

    const closeLogoutModal = () => {
      logoutModal.isOpen = false;
      logoutModal.sessionId = '';
      logoutModal.isLoggingOut = false;
    };

    const executeLogoutSession = async () => {
      if (!logoutModal.sessionId) return;
      logoutModal.isLoggingOut = true;
      try {
        const res = await safeFetchJson(`/api/sessions/${encodeURIComponent(logoutModal.sessionId)}/logout`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        if (res && res.success) {
          showToast(`Session '${logoutModal.sessionId}' logged out successfully`, 'success');
          closeLogoutModal();
          await fetchSessions();
        } else {
          showToast(res?.error?.message || 'Failed to logout session', 'error');
        }
      } catch (err) {
        showToast(`Logout failed: ${err.message}`, 'error');
      } finally {
        logoutModal.isLoggingOut = false;
      }
    };

    const openPurgeModal = (sessionId) => {
      purgeModal.sessionId = sessionId;
      purgeModal.isOpen = true;
    };

    const closePurgeModal = () => {
      purgeModal.isOpen = false;
      purgeModal.sessionId = '';
      purgeModal.isPurging = false;
    };

    const executePurgeSession = async () => {
      if (!purgeModal.sessionId) return;
      purgeModal.isPurging = true;
      try {
        let res = await safeFetchJson(`/api/sessions/${encodeURIComponent(purgeModal.sessionId)}`, {
          method: 'DELETE',
        });
        if (!res || !res.success) {
          res = await safeFetchJson(`/api/sessions/${encodeURIComponent(purgeModal.sessionId)}/purge`, {
            method: 'POST',
            body: JSON.stringify({}),
          });
        }

        if (res && res.success) {
          showToast(`Session '${purgeModal.sessionId}' purged from memory and Redis`, 'success');
          closePurgeModal();
          await fetchSessions();
        } else {
          showToast(res?.error?.message || 'Failed to purge session', 'error');
        }
      } catch (err) {
        showToast(`Purge failed: ${err.message}`, 'error');
      } finally {
        purgeModal.isPurging = false;
      }
    };

    // --------------------------------------------------------------------------
    // Console Message Dispatchers
    // --------------------------------------------------------------------------
    const openTestSend = (session) => {
      const id = session.sessionId || session.id;
      quickSend.sessionId = id;
      advancedSend.sessionId = id;
      mediaSend.sessionId = id;
      activeTab.value = 'console';
    };

    const sendQuickMessage = async () => {
      if (!quickSend.sessionId || !quickSend.jid || !quickSend.text) {
        showToast('Please complete all required fields', 'warn');
        return;
      }
      quickSend.isSending = true;
      quickSend.status = 'Emulating typing presence & dispatching...';
      quickSend.statusType = 'info';

      try {
        const res = await safeFetchJson(`/api/sessions/${encodeURIComponent(quickSend.sessionId)}/send`, {
          method: 'POST',
          body: JSON.stringify({
            jid: quickSend.jid.trim(),
            text: quickSend.text.trim(),
          }),
        });

        if (res && res.success) {
          quickSend.status = 'Message dispatched successfully!';
          quickSend.statusType = 'success';
          showToast('Message dispatched successfully!', 'success');
        } else {
          const msg = res?.error?.message || res?.message || 'Failed to send message';
          quickSend.status = `Failed: ${msg}`;
          quickSend.statusType = 'error';
          showToast(msg, 'error');
        }
      } catch (err) {
        quickSend.status = `Error: ${err.message}`;
        quickSend.statusType = 'error';
        showToast(err.message, 'error');
      } finally {
        quickSend.isSending = false;
      }
    };

    const sendAdvancedMessage = async () => {
      if (!advancedSend.sessionId || !advancedSend.jid || !advancedSend.text) {
        showToast('Please complete all required fields', 'warn');
        return;
      }
      advancedSend.isSending = true;
      advancedSend.status = 'Emulating user typing presence...';
      advancedSend.statusType = 'info';

      try {
        const res = await safeFetchJson(`/api/sessions/${encodeURIComponent(advancedSend.sessionId)}/send`, {
          method: 'POST',
          body: JSON.stringify({
            jid: advancedSend.jid.trim(),
            text: advancedSend.text.trim(),
          }),
        });

        if (res && res.success) {
          advancedSend.status = 'Message delivered to Baileys socket queue.';
          advancedSend.statusType = 'success';
          showToast('Text message dispatched', 'success');
        } else {
          const msg = res?.error?.message || res?.message || 'Failed to send message';
          advancedSend.status = `Error: ${msg}`;
          advancedSend.statusType = 'error';
          showToast(msg, 'error');
        }
      } catch (err) {
        advancedSend.status = `Error: ${err.message}`;
        advancedSend.statusType = 'error';
        showToast(err.message, 'error');
      } finally {
        advancedSend.isSending = false;
      }
    };

    const sendMediaMessage = async () => {
      if (!mediaSend.sessionId || !mediaSend.jid || !mediaSend.url) {
        showToast('Session, destination, and media URL are required', 'warn');
        return;
      }
      mediaSend.isSending = true;
      mediaSend.status = 'Downloading remote asset, verifying MIME, and transmitting...';
      mediaSend.statusType = 'info';

      try {
        const res = await safeFetchJson(`/api/sessions/${encodeURIComponent(mediaSend.sessionId)}/send-media`, {
          method: 'POST',
          body: JSON.stringify({
            jid: mediaSend.jid.trim(),
            type: mediaSend.type,
            url: mediaSend.url.trim(),
            caption: mediaSend.caption || undefined,
            filename: mediaSend.filename || undefined,
            ptt: mediaSend.ptt || false,
          }),
        });

        if (res && res.success) {
          mediaSend.status = 'Media payload successfully dispatched!';
          mediaSend.statusType = 'success';
          showToast('Media attachment dispatched', 'success');
        } else {
          const msg = res?.error?.message || res?.message || 'Failed to dispatch media';
          mediaSend.status = `Error: ${msg}`;
          mediaSend.statusType = 'error';
          showToast(msg, 'error');
        }
      } catch (err) {
        mediaSend.status = `Error: ${err.message}`;
        mediaSend.statusType = 'error';
        showToast(err.message, 'error');
      } finally {
        mediaSend.isSending = false;
      }
    };

    // --------------------------------------------------------------------------
    // Webhook Settings Modal & Test Ping
    // --------------------------------------------------------------------------
    const loadWebhookSettings = async () => {
      const res = await safeFetchJson('/api/settings/webhook');
      if (res && res.success && res.data) {
        const d = res.data;
        webhookModal.url = d.url || '';
        webhookModal.enabled = !!d.enabled;
        webhookModal.secret = d.secret || '';
        webhookModal.token = d.token || '';
        webhookModal.source = d.source || 'GLOBAL';
        if (d.events) {
          webhookModal.events.inbound = d.events.inbound ?? true;
          webhookModal.events.ack = d.events.ack ?? true;
          webhookModal.events.status = d.events.status ?? true;
        }
        if (d.retryStats) {
          webhookModal.stats.totalSent = d.retryStats.totalSent || 0;
          webhookModal.stats.success = d.retryStats.successCount || 0;
          webhookModal.stats.failures = d.retryStats.failCount || 0;
        }
      }
    };

    const openWebhookSettingsModal = async () => {
      webhookModal.isOpen = true;
      webhookModal.pingStatus = null;
      await loadWebhookSettings();
    };

    const closeWebhookSettingsModal = () => {
      webhookModal.isOpen = false;
      webhookModal.pingStatus = null;
    };

    const saveWebhookSettings = async () => {
      webhookModal.isSaving = true;
      try {
        const res = await safeFetchJson('/api/settings/webhook', {
          method: 'POST',
          body: JSON.stringify({
            url: webhookModal.url?.trim(),
            secret: webhookModal.secret,
            token: webhookModal.token,
            enabled: webhookModal.enabled,
            events: webhookModal.events,
          }),
        });

        if (res && res.success) {
          showToast('Webhook settings saved successfully', 'success');
          closeWebhookSettingsModal();
        } else {
          showToast(res?.error?.message || 'Failed to save settings', 'error');
        }
      } catch (err) {
        showToast(`Save error: ${err.message}`, 'error');
      } finally {
        webhookModal.isSaving = false;
      }
    };

    const testWebhookPing = async () => {
      webhookModal.isPinging = true;
      webhookModal.pingStatus = null;
      try {
        const res = await safeFetchJson('/api/settings/webhook/test', {
          method: 'POST',
          body: JSON.stringify({
            url: webhookModal.url?.trim(),
            secret: webhookModal.secret,
            token: webhookModal.token,
          }),
        });

        if (res && res.success && res.data) {
          webhookModal.pingStatus = res.data;
          showToast(res.data.success ? `Ping successful (${res.data.latencyMs}ms)` : `Ping failed: ${res.data.error}`, res.data.success ? 'success' : 'error');
        } else {
          webhookModal.pingStatus = { success: false, statusCode: 500, latencyMs: 0, error: res?.error?.message || 'Failed to reach endpoint' };
          showToast('Ping failed', 'error');
        }
      } catch (err) {
        webhookModal.pingStatus = { success: false, statusCode: 500, latencyMs: 0, error: err.message };
        showToast(`Ping error: ${err.message}`, 'error');
      } finally {
        webhookModal.isPinging = false;
      }
    };

    // --------------------------------------------------------------------------
    // SSE Live Logging & Telemetry Streams
    // --------------------------------------------------------------------------
    const fetchEvents = async () => {
      if (eventsPaused.value) return;
      const res = await safeFetchJson('/api/events');
      if (res && Array.isArray(res.events)) {
        // Merge preserving expanded states
        const existingMap = new Map(gatewayEvents.value.map(e => [e.id, e.expanded]));
        gatewayEvents.value = res.events.map((evt, idx) => ({
          ...evt,
          id: evt.id || `evt-${idx}-${evt.timestamp}`,
          expanded: existingMap.get(evt.id) || false,
        }));
      }
    };

    const initSSE = () => {
      if (sseSource) {
        try { sseSource.close(); } catch {}
      }

      try {
        sseSource = new EventSource('/api/logs/stream');

        sseSource.onmessage = (event) => {
          if (!event.data) return;
          try {
            const payload = JSON.parse(event.data);

            // Handle session_connected event to auto-resolve modal
            const action = payload.action || payload.meta?.action || payload.event;
            const targetSession = payload.sessionId || payload.meta?.sessionId;

            if (
              (action === 'session_connected' || action === 'connected' || (payload.message && payload.message.includes('successfully connected'))) &&
              targetSession &&
              pairingModal.sessionId === targetSession
            ) {
              pairingModal.isConnected = true;
              stopPairingTimers();
              showToast(`Device for session '${targetSession}' linked!`, 'success');
              setTimeout(() => closePairingModal(), 1500);
              fetchSessions();
            }

            if (payload.type === 'gateway_event') {
              if (!eventsPaused.value) {
                gatewayEvents.value.unshift({ ...payload, id: Date.now() + Math.random(), expanded: false });
                if (gatewayEvents.value.length > 250) gatewayEvents.value.pop();
              }
            } else {
              if (!logsPaused.value) {
                logs.value.unshift({
                  ...payload,
                  id: payload.id || `log-${Date.now()}-${Math.random()}`,
                  expanded: false,
                });
                if (logs.value.length > 300) logs.value.pop();
              }
            }

            if (autoScroll.value) {
              nextTick(() => {
                const el = document.getElementById('log-stream-container');
                if (el) el.scrollTop = 0;
              });
            }
          } catch {
            // Plain text heartbeat fallback
          }
        };

        sseSource.onerror = () => {
          // Reconnection is automatic in EventSource
        };
      } catch (err) {
        console.warn('SSE initialization failed, falling back to background polling', err);
      }
    };

    // --------------------------------------------------------------------------
    // Filtered Computeds
    // --------------------------------------------------------------------------
    const filteredLogs = computed(() => {
      let list = logs.value;
      if (logLevelFilter.value !== 'all') {
        list = list.filter(l => (l.level || '').toLowerCase() === logLevelFilter.value);
      }
      if (logSessionFilter.value.trim()) {
        const query = logSessionFilter.value.trim().toLowerCase();
        list = list.filter(l => (l.sessionId || '').toLowerCase().includes(query) || (l.message || '').toLowerCase().includes(query));
      }
      return list;
    });

    const filteredEvents = computed(() => {
      let list = gatewayEvents.value;
      if (eventFilter.value !== 'all') {
        list = list.filter(e => {
          const type = (e.type || '').toLowerCase();
          if (eventFilter.value === 'inbound') return type.includes('inbound');
          if (eventFilter.value === 'outbound') return type.includes('outbound');
          if (eventFilter.value === 'ack') return type.includes('ack');
          if (eventFilter.value === 'webhook') return type.includes('webhook');
          if (eventFilter.value === 'session') return type.includes('session');
          return true;
        });
      }
      if (eventSessionFilter.value.trim()) {
        const query = eventSessionFilter.value.trim().toLowerCase();
        list = list.filter(e => (e.sessionId || '').toLowerCase().includes(query));
      }
      return list;
    });

    // --------------------------------------------------------------------------
    // Clipboard & Utility Actions
    // --------------------------------------------------------------------------
    const copyToClipboard = async (text, item = null) => {
      try {
        const content = typeof text === 'object' ? JSON.stringify(text, null, 2) : String(text);
        await navigator.clipboard.writeText(content);
        if (item) {
          item.copied = true;
          setTimeout(() => { item.copied = false; }, 1500);
        }
        showToast('Copied to clipboard', 'info');
      } catch {
        showToast('Failed to copy to clipboard', 'error');
      }
    };

    const copyAllLogs = (format = 'text') => {
      const list = filteredLogs.value;
      if (!list || list.length === 0) {
        showToast('No logs to copy', 'warn');
        return;
      }
      let content = '';
      if (format === 'json') {
        content = JSON.stringify(list, null, 2);
      } else {
        content = list.map(l => `[${l.timestamp || ''}] [${(l.level || 'INFO').toUpperCase()}] ${l.sessionId ? `[${l.sessionId}] ` : ''}${stripAnsi(l.message || '')}`).join('\n');
      }
      copyToClipboard(content);
    };

    const copyAllEvents = () => {
      const list = filteredEvents.value;
      if (!list || list.length === 0) {
        showToast('No events to copy', 'warn');
        return;
      }
      copyToClipboard(JSON.stringify(list, null, 2));
    };

    const clearLogs = () => {
      logs.value = [];
      showToast('Log buffer cleared');
    };

    const clearEvents = () => {
      gatewayEvents.value = [];
      showToast('Events buffer cleared');
    };

    const manualRefreshAll = async () => {
      metrics.isRefreshing = true;
      try {
        await Promise.all([
          fetchHealth(),
          fetchSessions(),
          loadWebhookSettings(),
          fetchEvents(),
        ]);
        showToast('Telemetry & sessions refreshed', 'info');
      } finally {
        setTimeout(() => { metrics.isRefreshing = false; }, 400);
      }
    };

    // --------------------------------------------------------------------------
    // Lifecycle Management
    // --------------------------------------------------------------------------
    onMounted(() => {
      fetchHealth();
      fetchSessions();
      loadWebhookSettings();
      fetchEvents();
      initSSE();

      // Setup scheduled intervals
      pollIntervals.push(setInterval(fetchHealth, 10000));
      pollIntervals.push(setInterval(fetchSessions, 15000));
      pollIntervals.push(setInterval(fetchEvents, 4000));

      // Global keyboard handler for modal dismissal
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          closePairingModal();
          closeWebhookSettingsModal();
          closeLogoutModal();
          closePurgeModal();
        }
      });
    });

    onBeforeUnmount(() => {
      stopPairingTimers();
      if (sseSource) {
        try { sseSource.close(); } catch {}
      }
      pollIntervals.forEach(clearInterval);
      pollIntervals = [];
    });

    // Aliases for compatibility
    const bootSession = initSession;
    const setTenantPreset = setSessionInput;
    const switchPairingMode = (mode) => { pairingModal.mode = mode; };
    const copyPairingCode = () => copyToClipboard(pairingModal.pairingCode, pairingModal);
    const copyWebhookUrl = () => copyToClipboard(webhookModal.url, webhookModal);
    const copyEventPayload = (ev) => copyToClipboard(ev.payload || ev.details || ev, ev);
    const openWebhookSettings = openWebhookSettingsModal;
    const closeWebhookSettings = closeWebhookSettingsModal;
    const executeLogout = executeLogoutSession;
    const executePurge = executePurgeSession;
    const selectSessionForSend = openTestSend;
    const sendQuickTest = sendQuickMessage;
    const sendAdvancedText = sendAdvancedMessage;
    const sendAdvancedMedia = sendMediaMessage;
    const clearLogFeed = clearLogs;
    const clearEventFeed = clearEvents;

    return {
      // Navigation
      activeTab,
      liveLogTab,
      consoleTab,
      streamTab: liveLogTab,
      sendTab: consoleTab,

      // State
      metrics,
      sessions,
      newTenantId,
      isBooting,
      pairingModal,
      webhookModal,
      quickSend,
      advancedSend,
      mediaSend,
      logoutModal,
      purgeModal,
      logs,
      gatewayEvents,
      autoScroll,
      logAutoScroll: autoScroll,
      eventsAutoScroll,
      eventAutoScroll: eventsAutoScroll,
      logLevelFilter,
      logSessionFilter,
      logFilterSession: logSessionFilter,
      logsPaused,
      isLogsPaused: logsPaused,
      eventFilter,
      eventFilterType: eventFilter,
      eventSessionFilter,
      eventFilterQuery: eventSessionFilter,
      eventsPaused,
      isEventsPaused: eventsPaused,
      toasts,

      // Computeds
      filteredLogs,
      filteredEvents,

      // Formatters
      formatDisplayPhone,
      formatSessionTarget,
      getRelativeTime,
      getClockTime,
      stripAnsi,

      // Actions
      setSessionInput,
      setTenantPreset,
      initSession,
      bootSession,
      openPairing,
      closePairingModal,
      requestPairingCode,
      switchPairingMode,
      startQrPolling,
      openLogoutModal,
      closeLogoutModal,
      executeLogoutSession,
      executeLogout,
      openPurgeModal,
      closePurgeModal,
      executePurgeSession,
      executePurge,
      openTestSend,
      selectSessionForSend,
      sendQuickMessage,
      sendQuickTest,
      sendAdvancedMessage,
      sendAdvancedText,
      sendMediaMessage,
      sendAdvancedMedia,
      openWebhookSettingsModal,
      openWebhookSettings,
      closeWebhookSettingsModal,
      closeWebhookSettings,
      saveWebhookSettings,
      testWebhookPing,
      copyToClipboard,
      copyPairingCode,
      copyWebhookUrl,
      copyEventPayload,
      copyAllLogs,
      copyAllEvents,
      clearLogs,
      clearLogFeed,
      clearEvents,
      clearEventFeed,
      manualRefreshAll,
    };
  }
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
