/**
 * Botla WhatsApp Gateway - QR & Pairing Modal Component
 * Manages pairing success feedback, auto-dismiss modal, toast notification, and dashboard state sync.
 */
import { showToast } from '../modules/ui.js';
import { formatSessionTarget } from '../utils/format.js';
import {
  closeQrModal,
  getActiveQrSession,
  loadSessions,
  stopQrPolling,
  updateDashboardSessionCard,
} from '../modules/sessions.js';

let isHandlingSuccess = false;

/**
 * Handles pairing success event triggered from SSE or QR polling.
 * Displays success feedback card inside modal, toast notification, updates dashboard session card, and auto-dismisses modal after 1.5s.
 * @param {Object} event 
 * @param {string} event.sessionId 
 * @param {string} [event.status] 
 * @param {Object|string} [event.user] 
 */
export function handlePairingSuccess(event = {}) {
  const activeSessionId = getActiveQrSession();
  const sessionId = event.sessionId || activeSessionId;
  if (!sessionId) return;

  if (isHandlingSuccess) return;
  isHandlingSuccess = true;

  // 1. Immediately stop any running QR polling interval or timers
  stopQrPolling();

  // Extract user identifier
  const userLabel = event.user ? formatSessionTarget(event.user) : 'Active';

  // 2. Check if the Pairing Modal is currently open
  const modal = document.getElementById('qr-modal');

  if (modal && !modal.classList.contains('hidden')) {
    const viewQr = document.getElementById('pairing-view-qr');
    const viewCode = document.getElementById('pairing-view-code');
    const placeholder = document.getElementById('qr-placeholder');
    const img = document.getElementById('qr-image');
    const badge = document.getElementById('qr-status-badge');

    if (img) img.classList.add('hidden');
    if (viewCode) viewCode.classList.add('hidden');
    if (viewQr) viewQr.classList.remove('hidden');

    if (placeholder) {
      placeholder.classList.remove('hidden');
      placeholder.innerHTML = `
        <div id="pairing-success-card" class="p-5 sm:p-6 rounded-2xl bg-emerald-950/90 border border-emerald-500/40 text-center space-y-3 animate-fade-in my-auto shadow-2xl shadow-emerald-950/60">
          <div class="w-16 h-16 mx-auto rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/40 shadow-lg shadow-emerald-950/50 animate-bounce">
            <svg class="w-10 h-10 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path>
            </svg>
          </div>
          <h3 class="text-emerald-300 font-bold text-base sm:text-lg">Device Connected Successfully!</h3>
          <p class="text-zinc-300 text-xs font-mono">Linked to WhatsApp account (${escapeHtml(userLabel)}).</p>
          <div class="pt-1 flex items-center justify-center gap-1.5 text-[11px] text-emerald-400 font-medium">
            <span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span>
            <span>Session is now online & ready</span>
          </div>
        </div>
      `;
    }

    if (badge) {
      badge.textContent = 'Active & Connected';
      badge.className = 'px-2.5 py-0.5 rounded-full text-xs font-medium badge-online';
    }

    // Auto-dismiss modal after 1.5 seconds (1500ms)
    setTimeout(() => {
      closeQrModal();
      isHandlingSuccess = false;
    }, 1500);
  } else {
    isHandlingSuccess = false;
  }

  // 3. Display global success toast notification
  showToast(`Session [${sessionId}] is now online!`, 'success');

  // 4. Instantly update dashboard session card UI
  updateDashboardSessionCard(sessionId, 'connected', userLabel);

  // 5. Trigger background session list reload
  loadSessions();
}

/**
 * Helper to escape HTML characters safely
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Bind to window for global invocation
if (typeof window !== 'undefined') {
  window.handlePairingSuccess = handlePairingSuccess;
}
