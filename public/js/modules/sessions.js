/**
 * Botla WhatsApp Gateway - Sessions Lifecycle & Pairing Module
 * Handles session creation, active socket list, QR display, and phone pairing code.
 */
import { SessionApi } from '../api.js';
import { escapeHtml, showToast, switchTab } from './ui.js';
import { renderSessionCard } from '../components/sessionCard.js';

let activeQrSession = null;
let qrPollInterval = null;
let targetPurgeSessionId = null;
let targetLogoutSessionId = null;

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

  container.innerHTML = sessions.map(s => renderSessionCard(s)).join('');
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
  const quickInput = document.getElementById('quick-send-session-id');
  const sendInput = document.getElementById('send-session-id');
  const mediaInput = document.getElementById('media-session-id');
  const pairInput = document.getElementById('pair-code-session');

  if (quickInput) quickInput.value = sessionId;
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
  setTimeout(() => {
    const quickText = document.getElementById('quick-send-text');
    const sendText = document.getElementById('send-text');
    if (quickText) quickText.focus();
    else if (sendText) sendText.focus();
  }, 50);
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
 * Opens logout confirmation modal.
 * @param {string} sessionId 
 */
export function openLogoutModal(sessionId) {
  if (!sessionId) return;
  targetLogoutSessionId = sessionId;
  const label = document.getElementById('logout-target-session-id');
  if (label) label.textContent = sessionId;
  const modal = document.getElementById('logout-modal');
  if (modal) modal.classList.remove('hidden');
}

/**
 * Closes logout confirmation modal.
 */
export function closeLogoutModal() {
  const modal = document.getElementById('logout-modal');
  if (modal) modal.classList.add('hidden');
  targetLogoutSessionId = null;
}

/**
 * Executes logout request and unlinks WhatsApp device without deleting local tenant configurations.
 */
export async function executeLogoutSession() {
  const sessionId = targetLogoutSessionId;
  if (!sessionId) return;

  const btn = document.getElementById('btn-confirm-logout');
  const btnText = document.getElementById('btn-confirm-logout-text');
  if (btn) btn.disabled = true;
  if (btnText) btnText.textContent = 'Logging out...';

  showToast(`Unlinking session '${sessionId}'...`);

  try {
    const data = await SessionApi.logoutSession(sessionId);
    if (data && (data.success || data.status === 'ok' || data.status === 'disconnected')) {
      showToast(`Session '${sessionId}' logged out & unlinked successfully`);
      closeLogoutModal();
      if (activeQrSession === sessionId) {
        closeQrModal();
      }
      await loadSessions();
    } else {
      showToast(`Logout failed: ${data?.message || data?.error || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    showToast('Logout request error: ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = 'Logout Device';
  }
}

export function logoutSession(sessionId) {
  openLogoutModal(sessionId);
}

/**
 * Returns current active QR session identifier.
 */
export function getActiveQrSession() {
  return activeQrSession;
}

/**
 * Instantly updates dashboard session card UI when connection state changes.
 */
export function updateDashboardSessionCard(sessionId, status, userPhone) {
  if (!sessionId) return;
  const card = document.getElementById(`session-${sessionId}`) || document.getElementById(`session-card-${sessionId}`);
  if (!card) return;

  // Seamlessly re-render the card with fresh state hierarchy and action buttons
  card.outerHTML = renderSessionCard({
    id: sessionId,
    status: status || 'connected',
    user: userPhone,
    lastActiveAt: Date.now(),
  });
}

/**
 * QR & Phone Pairing Modal Controls
 */
export function stopQrPolling() {
  if (qrPollInterval) {
    clearInterval(qrPollInterval);
    qrPollInterval = null;
  }
}

export function openQrModal() {
  const modal = document.getElementById('qr-modal');
  if (modal) modal.classList.remove('hidden');
}

export function closeQrModal() {
  const modal = document.getElementById('qr-modal');
  if (modal) modal.classList.add('hidden');
  stopQrPolling();
  activeQrSession = null;
}

export async function switchPairingTab(tab) {
  const viewQr = document.getElementById('pairing-view-qr');
  const viewCode = document.getElementById('pairing-view-code');
  const btnQr = document.getElementById('pairing-tab-qr');
  const btnCode = document.getElementById('pairing-tab-code');

  // Immediately stop any running QR polling interval on tab switch
  stopQrPolling();

  if (tab === 'qr') {
    if (viewQr) viewQr.classList.remove('hidden');
    if (viewCode) viewCode.classList.add('hidden');
    if (btnQr) btnQr.className = 'py-2 px-3 rounded-lg bg-zinc-800 text-white transition active:scale-95 cursor-pointer flex items-center justify-center gap-1.5';
    if (btnCode) btnCode.className = 'py-2 px-3 rounded-lg text-zinc-400 hover:text-white transition active:scale-95 cursor-pointer flex items-center justify-center gap-1.5';
    if (activeQrSession) {
      await SessionApi.initSession(activeQrSession, 'qr');
      await fetchAndDisplayQr();
      if (!qrPollInterval && activeQrSession) {
        qrPollInterval = setInterval(fetchAndDisplayQr, 3000);
      }
    }
  } else {
    // Code tab: ensure view code is shown and view QR hidden
    if (viewQr) viewQr.classList.add('hidden');
    if (viewCode) viewCode.classList.remove('hidden');
    if (btnCode) btnCode.className = 'py-2 px-3 rounded-lg bg-zinc-800 text-white transition active:scale-95 cursor-pointer flex items-center justify-center gap-1.5';
    if (btnQr) btnQr.className = 'py-2 px-3 rounded-lg text-zinc-400 hover:text-white transition active:scale-95 cursor-pointer flex items-center justify-center gap-1.5';
  }
}

export async function viewQr(sessionId) {
  activeQrSession = sessionId;
  stopQrPolling();

  const sessionLabel = document.getElementById('qr-session-label');
  const pairCodeSession = document.getElementById('pair-code-session');

  if (sessionLabel) sessionLabel.textContent = 'Session: ' + sessionId;
  if (pairCodeSession) pairCodeSession.value = sessionId;
  openQrModal();

  const isCodeTab = !document.getElementById('pairing-view-code')?.classList.contains('hidden');
  if (!isCodeTab) {
    await SessionApi.initSession(activeQrSession, 'qr');
    await fetchAndDisplayQr();
    if (!qrPollInterval && activeQrSession) {
      qrPollInterval = setInterval(fetchAndDisplayQr, 3000);
    }
  }
}

export async function fetchAndDisplayQr() {
  if (!activeQrSession) {
    stopQrPolling();
    return;
  }

  // Guard: If modal is hidden, stop QR polling immediately
  const modal = document.getElementById('qr-modal');
  if (!modal || modal.classList.contains('hidden')) {
    stopQrPolling();
    return;
  }

  // Guard: If user is on the Code tab, cancel QR polling and exit
  const isCodeTab = !document.getElementById('pairing-view-code')?.classList.contains('hidden');
  if (isCodeTab) {
    stopQrPolling();
    return;
  }

  const data = await SessionApi.getQr(activeQrSession);
  if (!data) return;

  // Guard: If session is in pairing code mode, stop polling and display message
  if (
    data.error?.code === 'PAIRING_MODE_ACTIVE' ||
    data.code === 'PAIRING_MODE_ACTIVE' ||
    data.authMode === 'pairing_code' ||
    (data.message && data.message.includes('Phone Pairing Code mode active'))
  ) {
    stopQrPolling();
    const placeholder = document.getElementById('qr-placeholder');
    const img = document.getElementById('qr-image');
    const badge = document.getElementById('qr-status-badge');

    if (img) img.classList.add('hidden');
    if (placeholder) {
      placeholder.classList.remove('hidden');
      placeholder.innerHTML = `
        <div class="w-12 h-12 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center mb-1">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
        </div>
        <span class="text-emerald-400 font-semibold text-sm">Pairing Code Mode Active</span>
        <span class="text-zinc-400 text-xs text-center max-w-xs">Session is in phone pairing mode. QR requests disabled.</span>
      `;
    }
    if (badge) {
      badge.textContent = 'Pairing Code Active';
      badge.className = 'px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
    }
    return;
  }

  const placeholder = document.getElementById('qr-placeholder');
  const img = document.getElementById('qr-image');
  const badge = document.getElementById('qr-status-badge');

  if (data.status === 'connected') {
    if (typeof window !== 'undefined' && typeof window.handlePairingSuccess === 'function') {
      window.handlePairingSuccess({ sessionId: activeQrSession, status: 'connected', user: data.user });
    } else {
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
      stopQrPolling();
      loadSessions();
    }
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
  stopQrPolling();
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
  await SessionApi.initSession(sessionId, 'qr');
  await fetchAndDisplayQr();
  if (!qrPollInterval && activeQrSession) {
    qrPollInterval = setInterval(fetchAndDisplayQr, 3000);
  }
  loadSessions();
}

export async function requestPairingCode() {
  stopQrPolling();

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
