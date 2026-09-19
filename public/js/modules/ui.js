/**
 * Botla WhatsApp Gateway - UI & Utilities Module
 * Handles notifications, tabs, health status, modals, and formatting.
 */
import { SystemApi } from '../api.js';

let currentWebhookUrl = '';

/**
 * Displays a non-intrusive toast notification.
 * @param {string} message 
 * @param {'info'|'error'|'warn'} [type='info'] 
 */
export function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  let borderClass = 'border-zinc-700 bg-zinc-900/95 text-zinc-200';
  let icon = '<svg class="w-4 h-4 text-emerald-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>';

  if (type === 'error') {
    borderClass = 'border-rose-900/50 bg-rose-950/90 text-rose-200';
    icon = '<svg class="w-4 h-4 text-rose-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>';
  } else if (type === 'warn') {
    borderClass = 'border-amber-900/50 bg-amber-950/90 text-amber-200';
    icon = '<svg class="w-4 h-4 text-amber-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>';
  }

  toast.className = `p-3 rounded-xl border shadow-lg flex items-center gap-2.5 text-xs pointer-events-auto transform transition-all duration-200 translate-y-2 opacity-0 ${borderClass}`;
  toast.innerHTML = `${icon}<span class="flex-1">${escapeHtml(message)}</span>`;

  container.appendChild(toast);
  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  });

  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 250);
  }, 3500);
}

/**
 * Primary navigation switcher for both Desktop tabs and Mobile bottom navigation.
 * @param {'sessions'|'sender'|'stream'} tab 
 */
export function switchTab(tab) {
  const panelSessions = document.getElementById('section-sessions');
  const panelSender = document.getElementById('section-sender');
  const panelStream = document.getElementById('section-stream');

  const desktopSessions = document.getElementById('desktop-tab-sessions');
  const desktopSender = document.getElementById('desktop-tab-sender');
  const desktopStream = document.getElementById('desktop-tab-stream');

  const navSessions = document.getElementById('bottom-nav-sessions');
  const navSender = document.getElementById('bottom-nav-sender');
  const navStream = document.getElementById('bottom-nav-stream');

  const tabSessions = document.getElementById('mobile-tab-sessions');
  const tabSender = document.getElementById('mobile-tab-sender');
  const tabStream = document.getElementById('mobile-tab-stream');

  // Hide all sections
  [panelSessions, panelSender, panelStream].forEach(p => {
    if (p) p.classList.add('hidden');
  });

  // Reset desktop tabs style
  const desktopInactive = 'flex items-center gap-1.5 py-1.5 px-3.5 rounded-lg text-zinc-400 hover:text-zinc-200 transition active:scale-95 cursor-pointer';
  [desktopSessions, desktopSender, desktopStream].forEach(t => {
    if (t) t.className = desktopInactive;
  });

  // Reset legacy mobile inline tabs style if present
  [tabSessions, tabSender, tabStream].forEach(t => {
    if (t) t.className = 'flex items-center justify-center gap-1.5 py-2.5 px-2 rounded-lg text-zinc-400 hover:text-zinc-200 transition active:scale-95 cursor-pointer';
  });

  // Reset bottom navigation items
  [navSessions, navSender].forEach(n => {
    if (n) n.className = 'flex flex-col items-center gap-1 py-1 px-3 rounded-lg text-zinc-400 hover:text-zinc-200 transition cursor-pointer';
  });
  if (navStream) {
    navStream.className = 'flex flex-col items-center gap-1 py-1 px-3 rounded-lg text-zinc-400 hover:text-zinc-200 transition cursor-pointer relative';
  }

  // Activate selected tab
  if (tab === 'sessions') {
    if (panelSessions) panelSessions.classList.remove('hidden');
    if (desktopSessions) desktopSessions.className = 'flex items-center gap-1.5 py-1.5 px-3.5 rounded-lg bg-zinc-800 text-white shadow-sm transition active:scale-95 cursor-pointer';
    if (tabSessions) tabSessions.className = 'flex items-center justify-center gap-1.5 py-2.5 px-2 rounded-lg bg-zinc-800 text-white shadow-sm transition active:scale-95 cursor-pointer';
    if (navSessions) navSessions.className = 'flex flex-col items-center gap-1 py-1 px-3 rounded-lg text-emerald-400 transition cursor-pointer';
  } else if (tab === 'sender') {
    if (panelSender) panelSender.classList.remove('hidden');
    if (desktopSender) desktopSender.className = 'flex items-center gap-1.5 py-1.5 px-3.5 rounded-lg bg-zinc-800 text-white shadow-sm transition active:scale-95 cursor-pointer';
    if (tabSender) tabSender.className = 'flex items-center justify-center gap-1.5 py-2.5 px-2 rounded-lg bg-zinc-800 text-white shadow-sm transition active:scale-95 cursor-pointer';
    if (navSender) navSender.className = 'flex flex-col items-center gap-1 py-1 px-3 rounded-lg text-indigo-400 transition cursor-pointer';
  } else if (tab === 'stream') {
    if (panelStream) panelStream.classList.remove('hidden');
    if (desktopStream) desktopStream.className = 'flex items-center gap-1.5 py-1.5 px-3.5 rounded-lg bg-zinc-800 text-white shadow-sm transition active:scale-95 cursor-pointer';
    if (tabStream) tabStream.className = 'flex items-center justify-center gap-1.5 py-2.5 px-2 rounded-lg bg-zinc-800 text-white shadow-sm transition active:scale-95 cursor-pointer';
    if (navStream) navStream.className = 'flex flex-col items-center gap-1 py-1 px-3 rounded-lg text-cyan-400 transition cursor-pointer relative';
  }
}

/**
 * Backwards compatibility alias for switchTab
 */
export const switchMobileTab = switchTab;

/**
 * Checks system health & updates telemetry badges.
 */
export async function checkHealth() {
  const data = await SystemApi.getHealth();
  const redisStatus = document.getElementById('redis-status');
  const redisDot = document.getElementById('redis-dot');
  const waVersionStatus = document.getElementById('wa-version-status');
  const mediaStatus = document.getElementById('media-status');
  const webhookTarget = document.getElementById('webhook-target');

  if (!data) {
    if (redisStatus) {
      redisStatus.textContent = 'offline';
      redisStatus.className = 'text-rose-400 font-mono font-medium';
    }
    if (redisDot) redisDot.className = 'w-2 h-2 rounded-full bg-rose-400';
    return;
  }

  if (redisStatus && redisDot) {
    redisStatus.textContent = data.redis || 'active';
    if (data.redis && (data.redis.includes('connected') || data.redis.includes('fallback') || data.redis.includes('memory'))) {
      redisStatus.className = 'text-emerald-400 font-mono font-medium';
      redisDot.className = 'w-2 h-2 rounded-full bg-emerald-400';
    } else {
      redisStatus.className = 'text-amber-400 font-mono font-medium';
      redisDot.className = 'w-2 h-2 rounded-full bg-amber-400';
    }
  }

  if (waVersionStatus && data.protocolVersion) {
    waVersionStatus.textContent = 'v' + data.protocolVersion;
    waVersionStatus.className = (data.isLatestProtocol === false) ? 'text-amber-400 font-medium' : 'text-emerald-400 font-medium';
  }

  if (mediaStatus && data.mediaRetentionHours) {
    mediaStatus.textContent = data.mediaRetentionHours + 'h';
  }

  if (data.webhookUrl) {
    currentWebhookUrl = data.webhookUrl;
    if (webhookTarget) webhookTarget.textContent = data.webhookUrl;
  }
}

/**
 * Copies the current webhook target URL.
 */
export function copyWebhookUrl() {
  if (!currentWebhookUrl) return;
  navigator.clipboard.writeText(currentWebhookUrl).then(() => {
    showToast('Webhook URL copied to clipboard');
  }).catch(() => {
    showToast('Failed to copy', 'error');
  });
}

/**
 * Converts a timestamp to human-friendly relative time.
 * @param {string|number|Date} timestamp 
 * @returns {string}
 */
export function getRelativeTime(timestamp) {
  if (!timestamp) return '';
  const diffSec = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (isNaN(diffSec) || diffSec < 4) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

/**
 * Escapes HTML characters for safe template string rendering.
 * @param {string} text 
 * @returns {string}
 */
export function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Formats byte values to readable units.
 * @param {number} bytes 
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}
