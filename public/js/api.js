/**
 * Botla WhatsApp Gateway - API Client Module
 * Provides unified HTTP fetch wrappers and endpoint invocations.
 */

/**
 * Safely fetches a URL and parses JSON, returning fallback object on network or parse failures.
 * @param {string} url 
 * @param {RequestInit} [options] 
 * @returns {Promise<any>}
 */
export async function safeFetchJson(url, options = {}) {
  try {
    const headers = new Headers(options.headers || {});
    const apiKey = typeof window !== 'undefined' ? (localStorage.getItem('botla_api_key') || window.__BOTLA_API_KEY__) : null;
    if (apiKey && !headers.has('x-api-key') && !headers.has('authorization')) {
      headers.set('x-api-key', apiKey);
    }
    
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
    console.warn(`[API] Fetch notice on ${url}:`, err?.message || err);
    return null;
  }
}

/**
 * System & Diagnostics APIs
 */
export const SystemApi = {
  getHealth: () => safeFetchJson('/api/health'),
  cleanupMedia: () => safeFetchJson('/api/media/cleanup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  cleanupLogs: () => safeFetchJson('/api/logs/cleanup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  getLogFiles: () => safeFetchJson('/api/logs/files'),
  viewLogFile: (file, lines = 200) => safeFetchJson(`/api/logs/view?file=${encodeURIComponent(file)}&lines=${encodeURIComponent(lines)}`),
  clearLogFile: (file) => safeFetchJson('/api/logs/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }) }),
  getRecentEvents: () => safeFetchJson('/api/events'),
};

/**
 * WhatsApp Session Management APIs
 */
export const SessionApi = {
  listSessions: () => safeFetchJson('/api/sessions'),
  initSession: (sessionId) => safeFetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/init`, { method: 'POST' }),
  getQr: (sessionId) => safeFetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/qr`),
  requestPairingCode: (sessionId, phoneNumber) => safeFetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/pair-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber }),
  }),
  deleteSession: async (sessionId) => {
    let res = await safeFetchJson(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: { 'Accept': 'application/json' },
    });
    // Fallback if DELETE is blocked by proxy
    if (!res || (!res.success && (res.status === 405 || res.status === 404))) {
      res = await safeFetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/purge`, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
    }
    return res;
  },
};

/**
 * Message & Media Dispatcher APIs
 */
export const MessageApi = {
  sendTextMessage: (sessionId, jid, text) => safeFetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jid, text }),
  }),
  sendMediaMessage: (sessionId, payload) => safeFetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/send-media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }),
};
