/**
 * Botla WhatsApp Gateway - Webhook Settings Module
 * Handles loading, updating, and testing webhook configurations and retry stats in the dashboard.
 */
import { safeFetchJson } from '../api.js';
import { showToast } from './ui.js';

let cachedWebhookSettings = null;

export async function loadWebhookSettings() {
  const data = await safeFetchJson('/api/settings/webhook');
  if (data && data.success && data.data) {
    cachedWebhookSettings = data.data;
    const { url, enabled, retryStats } = cachedWebhookSettings;
    
    const targetEl = document.getElementById('webhook-target');
    if (targetEl) targetEl.textContent = url || 'Not configured';

    const badgeEl = document.getElementById('webhook-badge-status');
    if (badgeEl) {
      if (enabled && url) {
        badgeEl.textContent = 'Active';
        badgeEl.className = 'text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono';
      } else {
        badgeEl.textContent = 'Disabled';
        badgeEl.className = 'text-[10px] px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 font-mono';
      }
    }

    if (retryStats) {
      const totalSentEl = document.getElementById('stat-total-sent');
      const successEl = document.getElementById('stat-success');
      const failuresEl = document.getElementById('stat-failures');
      if (totalSentEl) totalSentEl.textContent = retryStats.totalSent || 0;
      if (successEl) successEl.textContent = retryStats.successCount || 0;
      if (failuresEl) failuresEl.textContent = retryStats.failCount || 0;
    }
  }
}

export async function openWebhookSettingsModal() {
  const modal = document.getElementById('webhook-settings-modal');
  if (!modal) return;
  modal.classList.remove('hidden');

  const data = await safeFetchJson('/api/settings/webhook');
  if (data && data.success && data.data) {
    cachedWebhookSettings = data.data;
    const { url, secret, token, enabled, events, source, retryStats } = cachedWebhookSettings;

    const urlEl = document.getElementById('wh-url');
    const secretEl = document.getElementById('wh-secret');
    const tokenEl = document.getElementById('wh-token');
    const enabledEl = document.getElementById('wh-enabled');
    const sourceEl = document.getElementById('wh-source-badge');
    const evInbound = document.getElementById('wh-ev-inbound');
    const evAck = document.getElementById('wh-ev-ack');
    const evStatus = document.getElementById('wh-ev-status');

    if (urlEl) urlEl.value = url || '';
    if (secretEl) secretEl.value = secret || '';
    if (tokenEl) tokenEl.value = token || '';
    if (enabledEl) enabledEl.checked = !!enabled;
    if (sourceEl) sourceEl.textContent = `Source: ${source?.toUpperCase() || 'GLOBAL'}`;
    if (evInbound) evInbound.checked = events?.inbound ?? true;
    if (evAck) evAck.checked = events?.ack ?? true;
    if (evStatus) evStatus.checked = events?.status ?? true;

    if (retryStats) {
      const totalSentEl = document.getElementById('stat-total-sent');
      const successEl = document.getElementById('stat-success');
      const failuresEl = document.getElementById('stat-failures');
      if (totalSentEl) totalSentEl.textContent = retryStats.totalSent || 0;
      if (successEl) successEl.textContent = retryStats.successCount || 0;
      if (failuresEl) failuresEl.textContent = retryStats.failCount || 0;
    }
  }

  const pingBox = document.getElementById('test-ping-result-box');
  if (pingBox) pingBox.classList.add('hidden');
}

export function closeWebhookSettingsModal() {
  const modal = document.getElementById('webhook-settings-modal');
  if (modal) modal.classList.add('hidden');
}

export function toggleWebhookSecretVisibility() {
  const secretInput = document.getElementById('wh-secret');
  if (!secretInput) return;
  if (secretInput.type === 'password') {
    secretInput.type = 'text';
  } else {
    secretInput.type = 'password';
  }
}

export async function saveWebhookSettings(e) {
  if (e) e.preventDefault();
  const url = document.getElementById('wh-url')?.value?.trim();
  const secret = document.getElementById('wh-secret')?.value;
  const token = document.getElementById('wh-token')?.value;
  const enabled = document.getElementById('wh-enabled')?.checked;
  const inbound = document.getElementById('wh-ev-inbound')?.checked;
  const ack = document.getElementById('wh-ev-ack')?.checked;
  const status = document.getElementById('wh-ev-status')?.checked;

  const btn = document.getElementById('btn-save-webhook');
  if (btn) btn.textContent = 'Saving...';

  try {
    const res = await safeFetchJson('/api/settings/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        secret,
        token,
        enabled,
        events: { inbound, ack, status },
      }),
    });

    if (res && res.success) {
      showToast('Webhook settings saved successfully');
      closeWebhookSettingsModal();
      loadWebhookSettings();
    } else {
      showToast(res?.error?.message || 'Failed to save webhook settings', 'error');
    }
  } catch (err) {
    showToast('Failed to save webhook settings: ' + err.message, 'error');
  } finally {
    if (btn) btn.textContent = 'Save Settings';
  }
}

export async function testWebhookPing() {
  const url = document.getElementById('wh-url')?.value?.trim();
  const secret = document.getElementById('wh-secret')?.value;
  const token = document.getElementById('wh-token')?.value;

  const btn = document.getElementById('btn-test-ping');
  if (btn) btn.textContent = 'Testing...';

  const pingBox = document.getElementById('test-ping-result-box');
  const badge = document.getElementById('test-ping-badge');
  const latencyEl = document.getElementById('test-ping-latency');
  const errorEl = document.getElementById('test-ping-error');

  try {
    const res = await safeFetchJson('/api/settings/webhook/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, secret, token }),
    });

    if (pingBox) pingBox.classList.remove('hidden');

    if (res && res.success && res.data) {
      const { success, statusCode, latencyMs, error } = res.data;
      if (badge) {
        badge.textContent = `${statusCode || 200} ${success ? 'OK' : 'Error'}`;
        badge.className = success
          ? 'px-2 py-0.5 rounded font-mono font-bold text-[11px] bg-emerald-500/20 text-emerald-400'
          : 'px-2 py-0.5 rounded font-mono font-bold text-[11px] bg-rose-500/20 text-rose-400';
      }
      if (latencyEl) latencyEl.textContent = `${latencyMs}ms`;
      if (errorEl) errorEl.textContent = error || '';
      showToast(success ? `Test ping successful (${latencyMs}ms)` : `Test ping failed: ${error}`, success ? 'success' : 'error');
    } else {
      if (badge) {
        badge.textContent = 'Failed';
        badge.className = 'px-2 py-0.5 rounded font-mono font-bold text-[11px] bg-rose-500/20 text-rose-400';
      }
      if (errorEl) errorEl.textContent = res?.error?.message || 'Network unreachable';
      showToast('Test ping failed', 'error');
    }
  } catch (err) {
    if (pingBox) pingBox.classList.remove('hidden');
    if (badge) badge.textContent = 'Error';
    if (errorEl) errorEl.textContent = err.message;
    showToast('Test ping error: ' + err.message, 'error');
  } finally {
    if (btn) btn.textContent = 'Test Ping';
  }
}
