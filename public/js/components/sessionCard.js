/**
 * Botla WhatsApp Gateway - Session Card Component
 * Renders individual tenant session cards with clean state hierarchy,
 * sanitized international phone formatting, and dynamic lifecycle-aware action buttons.
 */
import { formatSessionTarget } from '../utils/format.js';
import { escapeHtml, getRelativeTime } from '../modules/ui.js';

/**
 * Generates the HTML markup for a single session card.
 *
 * @param {Object} session
 * @param {string} session.id
 * @param {string} [session.status]
 * @param {Object|string} [session.user]
 * @param {number} [session.createdAt]
 * @param {number} [session.lastActiveAt]
 * @returns {string}
 */
export function renderSessionCard(session) {
  const sessionId = escapeHtml(session.id);
  const status = session.status || 'disconnected';
  const isConnected = status === 'connected';

  // 1. Status badge & dot styling
  let badgeHtml = '';
  let dotClass = 'bg-zinc-600';

  if (isConnected) {
    dotClass = 'bg-emerald-400';
    badgeHtml = `
      <span id="session-badge-${sessionId}" class="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs px-2 py-0.5 rounded-full flex items-center gap-1.5 font-medium">
        <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
        Connected
      </span>
    `;
  } else if (status === 'qr_ready') {
    dotClass = 'bg-indigo-400 animate-ping';
    badgeHtml = `
      <span id="session-badge-${sessionId}" class="bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 text-xs px-2 py-0.5 rounded-full flex items-center gap-1.5 font-medium">
        <span class="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-ping"></span>
        QR Ready
      </span>
    `;
  } else if (status === 'connecting') {
    dotClass = 'bg-amber-400 animate-pulse';
    badgeHtml = `
      <span id="session-badge-${sessionId}" class="bg-amber-500/10 text-amber-400 border border-amber-500/20 text-xs px-2 py-0.5 rounded-full flex items-center gap-1.5 font-medium">
        <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>
        Connecting
      </span>
    `;
  } else if (status === 'qr_expired') {
    dotClass = 'bg-amber-400';
    badgeHtml = `
      <span id="session-badge-${sessionId}" class="bg-amber-500/10 text-amber-300 border border-amber-500/30 text-xs px-2 py-0.5 rounded-full flex items-center gap-1.5 font-medium">
        <span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
        QR Expired
      </span>
    `;
  } else {
    dotClass = 'bg-zinc-600';
    badgeHtml = `
      <span id="session-badge-${sessionId}" class="bg-zinc-800 text-zinc-400 border border-zinc-700/60 text-xs px-2 py-0.5 rounded-full flex items-center gap-1.5 font-medium">
        <span class="w-1.5 h-1.5 rounded-full bg-zinc-500"></span>
        ${escapeHtml(status === 'logged_out' ? 'Logged Out' : 'Disconnected')}
      </span>
    `;
  }

  // 2. Target formatted label & metadata
  const targetFormatted = isConnected
    ? formatSessionTarget(session.user)
    : 'Awaiting authentication';

  let metaText = '';
  if (session.lastActiveAt && isConnected) {
    metaText = `Active ${getRelativeTime(session.lastActiveAt)}`;
  } else if (session.createdAt) {
    metaText = `Created ${getRelativeTime(session.createdAt)}`;
  }

  // 3. Conditional Action Buttons
  let actionsHtml = '';
  let gridClass = 'grid grid-cols-2 gap-2';

  if (isConnected) {
    // Connected: Test Send, Logout, Purge (Pairing button strictly omitted)
    gridClass = 'grid grid-cols-3 gap-2';
    actionsHtml = `
      <button onclick="window.selectSessionForSend('${sessionId}')" class="min-h-[42px] px-2.5 rounded-xl border border-zinc-700/80 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium transition active:scale-95 cursor-pointer flex items-center justify-center gap-1.5 shadow-sm" title="Open Console tab to test sending messages">
        <svg class="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"></path></svg>
        <span>Test Send</span>
      </button>

      <button onclick="window.openLogoutModal('${sessionId}')" class="min-h-[42px] px-2.5 rounded-xl border border-amber-900/40 bg-amber-950/20 hover:bg-amber-900/40 text-amber-300 text-xs font-medium transition active:scale-95 cursor-pointer flex items-center justify-center gap-1.5 shadow-sm" title="Unlink WhatsApp device without deleting configuration">
        <svg class="w-3.5 h-3.5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"></path></svg>
        <span>Logout</span>
      </button>

      <button onclick="window.purgeSession('${sessionId}')" class="min-h-[42px] px-2.5 rounded-xl border border-rose-900/40 bg-rose-950/20 hover:bg-rose-900/40 text-rose-300 text-xs font-medium transition active:scale-95 cursor-pointer flex items-center justify-center gap-1.5 shadow-sm" title="Wipe session and Redis authentication keys permanently">
        <svg class="w-3.5 h-3.5 text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
        <span>Purge</span>
      </button>
    `;
  } else {
    // Disconnected / qr_ready: Pair Device, Purge (Test Send hidden/omitted)
    gridClass = 'grid grid-cols-2 gap-2';
    actionsHtml = `
      <button onclick="window.viewQr('${sessionId}')" class="min-h-[42px] px-3 rounded-xl border border-indigo-700/60 bg-indigo-950/40 hover:bg-indigo-900/50 text-indigo-200 text-xs font-medium transition active:scale-95 cursor-pointer flex items-center justify-center gap-1.5 shadow-sm" title="Pair device via QR Code or Phone Pairing Code">
        <svg class="w-3.5 h-3.5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"></path></svg>
        <span>Pair Device</span>
      </button>

      <button onclick="window.purgeSession('${sessionId}')" class="min-h-[42px] px-3 rounded-xl border border-rose-900/40 bg-rose-950/20 hover:bg-rose-900/40 text-rose-300 text-xs font-medium transition active:scale-95 cursor-pointer flex items-center justify-center gap-1.5 shadow-sm" title="Delete session">
        <svg class="w-3.5 h-3.5 text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
        <span>Purge</span>
      </button>
    `;
  }

  return `
    <div id="session-${sessionId}" class="p-4 rounded-xl bg-zinc-900/90 border border-zinc-800/80 hover:border-zinc-700/80 transition-all space-y-3">
      <!-- Card Header -->
      <div class="flex items-start justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-8 h-8 rounded-lg bg-zinc-800 flex items-center justify-center flex-shrink-0 relative">
            <svg class="w-4 h-4 text-zinc-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"></path>
            </svg>
            <span id="session-dot-${sessionId}" class="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full ${dotClass}"></span>
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-mono text-white text-sm font-semibold truncate">${sessionId}</span>
              ${badgeHtml}
            </div>
            <!-- Target Row with Phone Icon & Clean Formatting -->
            <div class="text-xs text-zinc-400 truncate mt-1 flex items-center gap-1.5 flex-wrap">
              <span class="text-zinc-500 flex items-center gap-1 flex-shrink-0">
                <span>📞</span>
                <span>Target:</span>
              </span>
              <span id="session-target-${sessionId}" class="text-zinc-300 font-mono truncate max-w-[200px] sm:max-w-xs" title="${escapeHtml(targetFormatted)}">${escapeHtml(targetFormatted)}</span>
              ${metaText ? `<span class="text-zinc-600">·</span><span class="text-zinc-500 text-[11px] font-mono">${escapeHtml(metaText)}</span>` : ''}
            </div>
          </div>
        </div>
      </div>

      <!-- Action Buttons -->
      <div id="session-actions-${sessionId}" class="pt-2 border-t border-zinc-800/60 ${gridClass}">
        ${actionsHtml}
      </div>
    </div>
  `;
}
