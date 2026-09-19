/**
 * Botla WhatsApp Gateway - Sessions Lifecycle & Pairing Module
 * Handles session creation, active socket list, QR display, and phone pairing code.
 */
import { SessionApi } from '../api.js';
import { escapeHtml, showToast, switchTab } from './ui.js';

let activeQrSession = null;
let qrPollInterval = null;
let targetPurgeSessionId = null;

/**
 * Loads all active sessions from the gateway and renders the UI cards.
 */
export async function loadSessions() {
  const data = await SessionApi.listSessions();
  const container = document.getElementById('sessions-container');
  const totalCount = document.getElementById('sessions-total-count');
  const countBadge = document.getElementById('sessions-count-badge');
  const datalist = document.getElementById('active-sessions-datalist');

  if (!container) return;

  if (!data || !data.sessions) {
    container.innerHTML = '<div class="p-8 text-center text-zinc-500 text-sm">Failed to connect to gateway.</div>';
    return;
  }

  const sessions = data.sessions;
  if (totalCount) totalCount.textContent = sessions.length;
  if (countBadge) countBadge.textContent = sessions.length;

  if (datalist) {
    datalist.innerHTML = sessions.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.status)}</option>`).join('');
  }

  if (sessions.length === 0) {
    container.innerHTML = `
      <div class="p-8 text-center rounded-xl bg-zinc-950/60 border border-zinc-800/80 text-zinc-500 text-sm space-y-2">
        <div class="w-10 h-10 mx-auto rounded-full bg-zinc-900 flex items-center justify-center text-zinc-600">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path></svg>
        </div>
        <p class="font-medium text-zinc-400">No Active Sessions</p>
        <p class="text-xs text-zinc-500">Initialize a tenant session above to connect your WhatsApp account.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = sessions.map(s => {
    let badgeClass = 'badge-offline';
    let dotClass = 'bg-zinc-600';
    let statusLabel = s.status || 'disconnected';

    if (s.status === 'connected') {
      badgeClass = 'badge-online';
      dotClass = 'bg-emerald-400';
    } else if (s.status === 'qr_ready') {
      badgeClass = 'badge-qr';
      dotClass = 'bg-indigo-400 animate-ping';
    } else if (s.status === 'connecting') {
      badgeClass = 'badge-connecting';
      dotClass = 'bg-amber-400 animate-pulse';
    }

    const userPhone = s.user ? (s.user.id || s.user.name || 'Authenticated') : 'Awaiting authentication';

    return `
      <div class="p-4 rounded-xl bg-zinc-900/90 border border-zinc-800/80 hover:border-zinc-700/80 transition-all space-y-3">
        <!-- Card Header -->
        <div class="flex items-start justify-between gap-3">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-8 h-8 rounded-lg bg-zinc-800 flex items-center justify-center flex-shrink-0 relative">
              <svg class="w-4 h-4 text-zinc-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"></path>
              </svg>
              <span class="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full ${dotClass}"></span>
            </div>
            <div class="min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-mono text-white text-sm font-semibold truncate">${escapeHtml(s.id)}</span>
                <span class="text-[10px] px-2 py-0.5 rounded-full font-medium ${badgeClass}">${escapeHtml(statusLabel)}</span>
              </div>
              <div class="text-xs text-zinc-400 truncate mt-0.5 flex items-center gap-1.5">
                <span class="text-zinc-500">Target:</span>
                <span class="text-zinc-300 font-mono">${escapeHtml(userPhone)}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Action Buttons -->
        <div class="pt-2 border-t border-zinc-800/60 grid grid-cols-3 gap-2">
          <button onclick="window.viewQr('${escapeHtml(s.id)}')" class="h-10 px-2.5 rounded-xl border border-zinc-700/80 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium transition active:scale-95 cursor-pointer flex items-center justify-center gap-1.5 shadow-sm">
            <svg class="w-3.5 h-3.5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"></path></svg>
            <span>Pairing</span>
          </button>

          <button onclick="window.selectSessionForSend('${escapeHtml(s.id)}')" class="h-10 px-2.5 rounded-xl border border-zinc-700/80 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium transition active:scale-95 cursor-pointer flex items-center justify-center gap-1.5 shadow-sm">
            <svg class="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"></path></svg>
            <span>Test Send</span>
          </button>

          <button onclick="window.purgeSession('${escapeHtml(s.id)}')" class="h-10 px-2.5 rounded-xl border border-rose-900/40 bg-rose-950/20 hover:bg-rose-900/40 text-rose-300 text-xs font-medium transition active:scale-95 cursor-pointer flex items-center justify-center gap-1.5">
            <svg class="w-3.5 h-3.5 text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
            <span>Purge</span>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

/**
 * Sets the session input box text.
 * @param {string} val 
 */
export function setSessionInput(val) {
  const input = document.getElementById('new-session-id');
  if (input) input.value = val;
}

/**
 * Boots a new tenant session.
 */
export async function initSession() {
  const input = document.getElementById('new-session-id');
  const id = input?.value.trim();
  if (!id) {
    showToast('Please enter a session identifier', 'warn');
    return;
  }

  const btn = document.getElementById('btn-init-session');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `
      <svg class="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
      <span>Booting...</span>
    `;
  }

  try {
    const data = await SessionApi.initSession(id);
    if (data && data.success) {
      showToast(`Session '${id}' booted!`);
      fillSender(id);
      viewQr(id);
      await loadSessions();
    } else {
      showToast(`Failed: ${data?.message || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    showToast('Connection error: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
        <span>Boot Session</span>
      `;
    }
  }
}

/**
 * Auto-fills session id in form fields.
 * @param {string} sessionId 
 */
export function fillSender(sessionId) {
  const sendInput = document.getElementById('send-session-id');
  const mediaInput = document.getElementById('media-session-id');
  const pairInput = document.getElementById('pair-code-session');

  if (sendInput) sendInput.value = sessionId;
  if (mediaInput) mediaInput.value = sessionId;
  if (pairInput) pairInput.value = sessionId;
}

/**
 * Selects a session and opens the Console/Sender tab.
 * @param {string} sessionId 
 */
export function selectSessionForSend(sessionId) {
  fillSender(sessionId);
  switchTab('sender');
  const sendText = document.getElementById('send-text');
  if (sendText) sendText.focus();
  showToast(`Selected '${sessionId}' in console`);
}

/**
 * Opens session purge confirmation modal.
 * @param {string} sessionId 
 */
export function openPurgeModal(sessionId) {
  if (!sessionId) return;
  targetPurgeSessionId = sessionId;
  const label = document.getElementById('purge-target-session-id');
  if (label) label.textContent = sessionId;
  const modal = document.getElementById('purge-modal');
  if (modal) modal.classList.remove('hidden');
}

/**
 * Closes purge confirmation modal.
 */
export function closePurgeModal() {
  const modal = document.getElementById('purge-modal');
  if (modal) modal.classList.add('hidden');
  targetPurgeSessionId = null;
}

/**
 * Executes purge request and deletes session credentials from Redis.
 */
export async function executePurgeSession() {
  const sessionId = targetPurgeSessionId;
  if (!sessionId) return;

  const btn = document.getElementById('btn-confirm-purge');
  const btnText = document.getElementById('btn-confirm-purge-text');
  if (btn) btn.disabled = true;
  if (btnText) btnText.textContent = 'Purging...';

  showToast(`Purging session '${sessionId}'...`);

  try {
    const data = await SessionApi.deleteSession(sessionId);
    if (data && (data.success || data.status === 'ok')) {
      showToast(`Session '${sessionId}' purged successfully`);
      closePurgeModal();
      if (activeQrSession === sessionId) {
        closeQrModal();
      }
      await loadSessions();
    } else {
      showToast(`Purge failed: ${data?.message || data?.error || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    showToast('Purge request error: ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = 'Purge Session';
  }
}

export function purgeSession(sessionId) {
  openPurgeModal(sessionId);
}

/**
 * QR & Phone Pairing Modal Controls
 */
export function openQrModal() {
  const modal = document.getElementById('qr-modal');
  if (modal) modal.classList.remove('hidden');
}

export function closeQrModal() {
  const modal = document.getElementById('qr-modal');
  if (modal) modal.classList.add('hidden');
  if (qrPollInterval) {
    clearInterval(qrPollInterval);
    qrPollInterval = null;
  }
}

export function switchPairingTab(tab) {
  const viewQr = document.getElementById('pairing-view-qr');
  const viewCode = document.getElementById('pairing-view-code');
  const btnQr = document.getElementById('pairing-tab-qr');
  const btnCode = document.getElementById('pairing-tab-code');

  if (tab === 'qr') {
    if (viewQr) viewQr.classList.remove('hidden');
    if (viewCode) viewCode.classList.add('hidden');
    if (btnQr) btnQr.className = 'py-2 px-3 rounded-lg bg-zinc-800 text-white transition active:scale-95 cursor-pointer flex items-center justify-center gap-1.5';
    if (btnCode) btnCode.className = 'py-2 px-3 rounded-lg text-zinc-400 hover:text-white transition active:scale-95 cursor-pointer flex items-center justify-center gap-1.5';
    fetchAndDisplayQr();
    if (!qrPollInterval) {
      qrPollInterval = setInterval(fetchAndDisplayQr, 3000);
    }
  } else {
    if (viewQr) viewQr.classList.add('hidden');
    if (viewCode) viewCode.classList.remove('hidden');
    if (btnCode) btnCode.className = 'py-2 px-3 rounded-lg bg-zinc-800 text-white transition active:scale-95 cursor-pointer flex items-center justify-center gap-1.5';
    if (btnQr) btnQr.className = 'py-2 px-3 rounded-lg text-zinc-400 hover:text-white transition active:scale-95 cursor-pointer flex items-center justify-center gap-1.5';
    if (qrPollInterval) {
      clearInterval(qrPollInterval);
      qrPollInterval = null;
    }
  }
}

export async function viewQr(sessionId) {
  activeQrSession = sessionId;
  const sessionLabel = document.getElementById('qr-session-label');
  const pairCodeSession = document.getElementById('pair-code-session');

  if (sessionLabel) sessionLabel.textContent = 'Session: ' + sessionId;
  if (pairCodeSession) pairCodeSession.value = sessionId;
  openQrModal();

  const isCodeTab = !document.getElementById('pairing-view-code')?.classList.contains('hidden');
  if (qrPollInterval) {
    clearInterval(qrPollInterval);
    qrPollInterval = null;
  }
  if (!isCodeTab) {
    await fetchAndDisplayQr();
    qrPollInterval = setInterval(fetchAndDisplayQr, 3000);
  }
}

export async function fetchAndDisplayQr() {
  if (!activeQrSession) return;
  const data = await SessionApi.getQr(activeQrSession);
  if (!data) return;

  const placeholder = document.getElementById('qr-placeholder');
  const img = document.getElementById('qr-image');
  const badge = document.getElementById('qr-status-badge');

  if (data.status === 'connected') {
    if (img) img.classList.add('hidden');
    if (placeholder) {
      placeholder.classList.remove('hidden');
      placeholder.innerHTML = `
        <div class="w-12 h-12 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center mb-1">
          <svg class="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg>
        </div>
        <span class="text-emerald-400 font-bold text-base">Connected & Authenticated</span>
        <span class="text-zinc-400 text-xs text-center max-w-xs">WhatsApp socket is actively linked. You can now dispatch messages.</span>
      `;
    }
    if (badge) {
      badge.textContent = 'Active & Connected';
      badge.className = 'px-2.5 py-0.5 rounded-full text-xs font-medium badge-online';
    }
    if (qrPollInterval) {
      clearInterval(qrPollInterval);
      qrPollInterval = null;
    }
    loadSessions();
  } else if (data.status === 'qr_expired') {
    if (img) img.classList.add('hidden');
    if (placeholder) {
      placeholder.classList.remove('hidden');
      placeholder.innerHTML = `
        <div class="w-12 h-12 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center mb-1">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
        </div>
        <span class="text-amber-400 font-semibold text-sm">QR Code Expired</span>
        <span class="text-zinc-400 text-xs text-center max-w-xs mb-3">QR pairing timed out without being scanned.</span>
        <button onclick="window.refreshQrSession('${escapeHtml(activeQrSession)}')" class="px-4 py-2 rounded-xl bg-white hover:bg-zinc-200 text-black text-xs font-semibold transition active:scale-95 flex items-center gap-1.5 shadow-sm">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
          <span>Generate New QR</span>
        </button>
      `;
    }
    if (badge) {
      badge.textContent = 'QR Expired';
      badge.className = 'px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-500/20 text-amber-300 border border-amber-500/30';
    }
  } else if (data.qrDataUrl) {
    if (img) {
      img.src = data.qrDataUrl;
      img.classList.remove('hidden');
    }
    if (placeholder) placeholder.classList.add('hidden');
    if (badge) {
      badge.textContent = 'Scan QR Code';
      badge.className = 'px-2.5 py-0.5 rounded-full text-xs font-medium badge-qr';
    }
  } else {
    if (img) img.classList.add('hidden');
    if (placeholder) {
      placeholder.classList.remove('hidden');
      placeholder.innerHTML = `
        <svg class="w-7 h-7 text-amber-400 animate-spin mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
        <span class="text-zinc-300 font-medium">${escapeHtml(data.message || 'Generating QR string...')}</span>
        <span class="text-zinc-500 text-[11px]">Connecting Baileys engine</span>
      `;
    }
    if (badge) {
      badge.textContent = data.status || 'Waiting';
      badge.className = 'px-2.5 py-0.5 rounded-full text-xs font-medium bg-zinc-800 text-zinc-400';
    }
  }
}

export async function refreshQrSession(sessionId) {
  showToast('Generating fresh QR code...');
  const placeholder = document.getElementById('qr-placeholder');
  const img = document.getElementById('qr-image');
  if (img) img.classList.add('hidden');
  if (placeholder) {
    placeholder.classList.remove('hidden');
    placeholder.innerHTML = `
      <svg class="w-7 h-7 text-emerald-400 animate-spin mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
      <span class="text-zinc-300 font-medium">Booting fresh session...</span>
      <span class="text-zinc-500 text-[11px]">Connecting Baileys engine</span>
    `;
  }
  await SessionApi.initSession(sessionId);
  await fetchAndDisplayQr();
  if (!qrPollInterval) {
    qrPollInterval = setInterval(fetchAndDisplayQr, 3000);
  }
  loadSessions();
}

export async function requestPairingCode() {
  if (qrPollInterval) {
    clearInterval(qrPollInterval);
    qrPollInterval = null;
  }

  const sessionInput = document.getElementById('pair-code-session');
  const phoneInput = document.getElementById('pair-code-phone');
  const sessionId = sessionInput?.value.trim() || 'tenant-botla-1';
  const phoneNumber = phoneInput?.value.trim().replace(/[^0-9]/g, '');
  const status = document.getElementById('pair-code-status');
  const resultBox = document.getElementById('pair-code-result-box');
  const codeDisplay = document.getElementById('pair-code-display');
  const btn = document.getElementById('btn-pair-code');

  if (!phoneNumber || phoneNumber.length < 7) {
    if (status) {
      status.textContent = 'Please enter valid phone number with country code.';
      status.className = 'text-xs text-rose-400 text-center';
    }
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<svg class="w-3.5 h-3.5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>`;
  }
  if (status) {
    status.textContent = 'Requesting pairing code from WhatsApp socket...';
    status.className = 'text-xs text-amber-400 text-center';
  }

  try {
    const data = await SessionApi.requestPairingCode(sessionId, phoneNumber);
    if (data && data.success && data.code) {
      if (resultBox) resultBox.classList.remove('hidden');
      if (codeDisplay) codeDisplay.textContent = data.code;
      if (status) {
        status.textContent = '✓ Pairing code received! Enter it on your phone.';
        status.className = 'text-xs text-emerald-400 text-center';
      }
      showToast('Pairing code generated');
    } else {
      if (resultBox) resultBox.classList.add('hidden');
      if (status) {
        status.textContent = 'Failed: ' + (data?.message || 'Unable to generate code');
        status.className = 'text-xs text-rose-400 text-center';
      }
      showToast(data?.message || 'Pairing code failed', 'error');
    }
  } catch (err) {
    if (status) {
      status.textContent = 'Request error: ' + err.message;
      status.className = 'text-xs text-rose-400 text-center';
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<span>Get Code</span>`;
    }
  }
}

export function copyPairCode() {
  const code = document.getElementById('pair-code-display')?.textContent.trim();
  if (!code || code === '----') return;
  navigator.clipboard.writeText(code).then(() => {
    showToast('Pairing code copied to clipboard!');
  }).catch(() => {
    showToast('Failed to copy', 'error');
  });
}
