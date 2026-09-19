/**
 * Botla WhatsApp Gateway - Diagnostics, SSE Logs & Disk Log Viewer Module
 * Handles Pino SSE live stream, Gateway event buffer, and Interactive Terminal Log Viewer.
 */
import { SystemApi } from '../api.js';
import {
  formatLogTimestamp,
  formatLogViewerLine,
  getLogLevelBadgeInfo,
  parsePinoJsonLine,
  stripAnsi,
} from '../components/logViewerModal.js';
import { escapeHtml, formatBytes, getRelativeTime, showToast } from './ui.js';

// State variables
let currentStreamTab = 'logs'; // 'logs' | 'events' | 'files'
let cachedLogsList = [];
let currentLogLevelFilter = 'all';
let logStreamPaused = false;
let sseEventSource = null;

let streamPaused = false;
let currentEventFilter = 'all';
let cachedEventsList = [];

let activeLogViewerFile = '';
let activeLogViewerLines = 200;
let rawLogViewerContent = '';

/**
 * Switches the console sub-tabs.
 * @param {'logs'|'events'|'files'} tab 
 */
export function switchStreamTab(tab) {
  currentStreamTab = tab;
  const subviewLogs = document.getElementById('subview-pino-logs');
  const subviewEvents = document.getElementById('subview-gateway-events');
  const subviewFiles = document.getElementById('subview-log-files');

  const btnLogs = document.getElementById('stream-tab-btn-logs');
  const btnEvents = document.getElementById('stream-tab-btn-events');
  const btnFiles = document.getElementById('stream-tab-btn-files');

  [subviewLogs, subviewEvents, subviewFiles].forEach(v => {
    if (v) v.classList.add('hidden');
  });
  [btnLogs, btnEvents, btnFiles].forEach(b => {
    if (b) b.className = 'px-3 py-1.5 rounded-lg text-zinc-400 hover:text-white cursor-pointer transition active:scale-95 flex items-center gap-1.5';
  });

  if (tab === 'logs') {
    if (subviewLogs) subviewLogs.classList.remove('hidden');
    if (btnLogs) btnLogs.className = 'px-3 py-1.5 rounded-lg bg-zinc-800 text-white cursor-pointer transition active:scale-95 flex items-center gap-1.5';
    renderLogs();
  } else if (tab === 'events') {
    if (subviewEvents) subviewEvents.classList.remove('hidden');
    if (btnEvents) btnEvents.className = 'px-3 py-1.5 rounded-lg bg-zinc-800 text-white cursor-pointer transition active:scale-95 flex items-center gap-1.5';
    renderEvents();
  } else if (tab === 'files') {
    if (subviewFiles) subviewFiles.classList.remove('hidden');
    if (btnFiles) btnFiles.className = 'px-3 py-1.5 rounded-lg bg-zinc-800 text-white cursor-pointer transition active:scale-95 flex items-center gap-1.5';
    fetchLogFiles();
  }
}

/**
 * Initializes Server-Sent Events (SSE) connection for Pino structured logs.
 */
export function initLogStreamSSE() {
  if (sseEventSource) {
    try { sseEventSource.close(); } catch {}
  }

  const statusDot = document.getElementById('sse-status-dot');
  const connLabel = document.getElementById('sse-connection-label');

  try {
    sseEventSource = new EventSource('/api/logs/stream');

    sseEventSource.onopen = () => {
      if (statusDot) statusDot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
      if (connLabel) {
        connLabel.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> SSE Active';
        connLabel.className = 'text-emerald-400 text-[10px] font-mono flex items-center gap-1';
      }
    };

    sseEventSource.onmessage = (event) => {
      if (!event.data) return;
      try {
        const logEntry = JSON.parse(event.data);
        if (!logEntry || !logEntry.message) return;

        // Prepend new entry, keeping capped buffer (250 entries)
        cachedLogsList.unshift(logEntry);
        if (cachedLogsList.length > 250) {
          cachedLogsList.pop();
        }

        if (!logStreamPaused && currentStreamTab === 'logs') {
          renderLogs();
        }
      } catch (e) {
        // Non-JSON heartbeat
      }
    };

    sseEventSource.onerror = () => {
      if (statusDot) statusDot.className = 'w-2 h-2 rounded-full bg-amber-400';
      if (connLabel) {
        connLabel.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span> Reconnecting...';
        connLabel.className = 'text-amber-400 text-[10px] font-mono flex items-center gap-1';
      }
    };
  } catch (err) {
    console.warn('SSE stream initialization failed, falling back to polling', err);
  }
}

export function setLogLevelFilter(level) {
  currentLogLevelFilter = level;
  document.querySelectorAll('.log-level-filter-btn').forEach(btn => {
    if (btn.getAttribute('data-level') === level) {
      btn.className = 'log-level-filter-btn px-2 py-0.8 rounded-lg bg-zinc-800 text-white font-medium whitespace-nowrap cursor-pointer';
    } else {
      btn.className = 'log-level-filter-btn px-2 py-0.8 rounded-lg text-zinc-400 hover:text-zinc-200 whitespace-nowrap cursor-pointer';
    }
  });
  renderLogs();
}

export function filterLogsChanged() {
  renderLogs();
}

export function toggleLogStreamPause() {
  logStreamPaused = !logStreamPaused;
  const btn = document.getElementById('btn-log-stream-pause');
  if (btn) {
    if (logStreamPaused) {
      btn.textContent = 'Resume';
      btn.className = 'px-2 py-1 text-[11px] rounded-lg bg-amber-500/20 text-amber-400 border border-amber-500/30 transition cursor-pointer';
      showToast('Pino log stream paused');
    } else {
      btn.textContent = 'Pause';
      btn.className = 'px-2 py-1 text-[11px] rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition cursor-pointer';
      renderLogs();
    }
  }
}

export function clearLogFeed() {
  cachedLogsList = [];
  renderLogs();
  showToast('Log feed buffer cleared');
}

export function renderLogs() {
  const feed = document.getElementById('logs-feed');
  const counter = document.getElementById('log-counter');
  const autoscroll = document.getElementById('log-autoscroll') ? document.getElementById('log-autoscroll').checked : true;
  const sessionFilter = document.getElementById('log-filter-session') ? document.getElementById('log-filter-session').value.trim().toLowerCase() : '';

  if (!feed) return;

  let filtered = cachedLogsList;

  if (currentLogLevelFilter !== 'all') {
    filtered = filtered.filter(l => (l.level || '').toLowerCase() === currentLogLevelFilter);
  }

  if (sessionFilter) {
    filtered = filtered.filter(l => (l.sessionId || '').toLowerCase().includes(sessionFilter));
  }

  if (counter) counter.textContent = `${filtered.length} logs captured`;

  if (filtered.length === 0) {
    feed.innerHTML = `
      <div class="text-zinc-600 text-center py-12 text-xs font-sans">
        No log entries matching current filter criteria.
      </div>
    `;
    return;
  }

  feed.innerHTML = filtered.slice(0, 60).map((log, index) => {
    let badgeColor = 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30';
    const lvl = (log.level || 'info').toLowerCase();

    if (lvl === 'warn') {
      badgeColor = 'bg-amber-500/15 text-amber-400 border-amber-500/30';
    } else if (lvl === 'error' || lvl === 'fatal') {
      badgeColor = 'bg-rose-500/15 text-rose-400 border-rose-500/30';
    } else if (lvl === 'debug' || lvl === 'trace') {
      badgeColor = 'bg-zinc-800 text-zinc-400 border-zinc-700';
    }

    const relTime = getRelativeTime(log.timestamp);
    const clockTime = log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '';
    const hasMeta = log.meta && Object.keys(log.meta).length > 0;
    const jsonString = hasMeta ? JSON.stringify(log.meta, null, 2) : '';

    return `
      <div class="p-2.5 rounded-xl bg-zinc-950/90 border border-zinc-900/90 hover:border-zinc-800 transition-colors space-y-1.5">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-1.5 min-w-0 flex-wrap">
            <span class="px-1.5 py-0.2 rounded text-[10px] uppercase font-bold border ${badgeColor}">
              ${escapeHtml(lvl)}
            </span>
            ${log.sessionId ? `<span class="px-1.5 py-0.2 rounded bg-emerald-950/40 text-emerald-400 border border-emerald-800/40 text-[10px] font-mono truncate max-w-[120px]">[${escapeHtml(log.sessionId)}]</span>` : ''}
          </div>
          <span class="text-[10px] text-zinc-500 font-mono flex-shrink-0" title="${escapeHtml(clockTime)}">${escapeHtml(relTime)}</span>
        </div>

        <div class="text-zinc-200 text-xs font-mono break-words leading-relaxed">${escapeHtml(stripAnsi(log.message))}</div>

        ${hasMeta ? `
          <details class="group">
            <summary class="text-[10px] text-zinc-500 hover:text-zinc-300 cursor-pointer flex items-center justify-between font-mono select-none pt-0.5">
              <span class="flex items-center gap-1">
                <svg class="w-3 h-3 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>
                <span>Inspect Metadata</span>
              </span>
              <button type="button" onclick="window.copyLogMeta(event, ${index})" class="text-[10px] text-zinc-400 hover:text-white px-1.5 py-0.2 rounded bg-zinc-800 hover:bg-zinc-700">
                Copy Meta
              </button>
            </summary>
            <pre id="log-meta-${index}" class="mt-1 p-2 rounded-lg bg-black/80 border border-zinc-900 text-[10px] text-cyan-300 overflow-x-auto font-mono whitespace-pre max-h-36 overflow-y-auto">${escapeHtml(jsonString)}</pre>
          </details>
        ` : ''}
      </div>
    `;
  }).join('');

  if (autoscroll) {
    feed.scrollTop = 0;
  }
}

export function copyLogMeta(event, index) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const el = document.getElementById(`log-meta-${index}`);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(() => {
    showToast('Log metadata copied to clipboard');
  }).catch(() => {
    showToast('Failed to copy', 'error');
  });
}

/**
 * Disk Log Files & Interactive Terminal Viewer
 */
export async function fetchLogFiles() {
  const listEl = document.getElementById('log-files-list');
  const diskUsageEl = document.getElementById('log-total-disk-usage');
  
  const data = await SystemApi.getLogFiles();
  if (!listEl) return;

  if (!data || !data.files) {
    listEl.innerHTML = '<div class="text-zinc-500 text-center py-6">Unable to inspect log files directory.</div>';
    return;
  }

  if (diskUsageEl) diskUsageEl.textContent = data.totalSizeFormatted || '0 B';

  if (data.files.length === 0) {
    listEl.innerHTML = '<div class="text-zinc-500 text-center py-6">No log files found in storage/logs/.</div>';
    return;
  }

  listEl.innerHTML = data.files.map(file => {
    let fileBadge = 'bg-zinc-800/90 text-zinc-300 border-zinc-700/80';
    let dotColor = 'bg-cyan-400';
    if (file.name === 'error.log') {
      fileBadge = 'bg-rose-500/15 text-rose-300 border border-rose-500/30';
      dotColor = 'bg-rose-400';
    } else if (file.name === 'combined.log') {
      fileBadge = 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30';
      dotColor = 'bg-cyan-400';
    }

    return `
      <div onclick="window.openLogViewer('${escapeHtml(file.name)}', '${escapeHtml(file.sizeFormatted)}')" class="p-3 rounded-xl bg-zinc-950/80 border border-zinc-800/80 hover:border-zinc-700 hover:bg-zinc-900/80 transition-all cursor-pointer active:scale-[0.99] flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 sm:gap-4 group">
        <!-- Left: Full Filename, Age, and Size Pill -->
        <div class="flex items-center justify-between sm:justify-start gap-2.5 min-w-0 flex-1">
          <div class="flex items-center gap-2 min-w-0 flex-1 sm:flex-initial">
            <span class="w-2 h-2 rounded-full ${dotColor} group-hover:scale-125 transition-transform flex-shrink-0"></span>
            <span class="font-bold text-zinc-100 ${fileBadge} px-2.5 py-1 rounded-lg text-xs font-mono select-all overflow-hidden text-ellipsis whitespace-nowrap max-w-[150px] min-[380px]:max-w-[220px] sm:max-w-none">${escapeHtml(file.name)}</span>
            <span class="text-[10px] text-zinc-400 font-mono flex-shrink-0 hidden min-[420px]:inline">${escapeHtml(file.ageDays)}d old</span>
          </div>
          <div class="flex items-center gap-1.5 flex-shrink-0">
            <span class="px-2 py-0.5 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-300 font-mono text-[11px] font-semibold">${escapeHtml(file.sizeFormatted)}</span>
            <span class="text-[10px] text-zinc-400 font-mono flex-shrink-0 min-[420px]:hidden">(${escapeHtml(file.ageDays)}d)</span>
          </div>
        </div>

        <!-- Right: Touch-friendly Action Buttons -->
        <div class="flex items-center justify-end gap-1.5 flex-shrink-0 pt-1.5 sm:pt-0 border-t sm:border-t-0 border-zinc-900/80 font-mono">
          <button type="button" onclick="event.stopPropagation(); window.openLogViewer('${escapeHtml(file.name)}', '${escapeHtml(file.sizeFormatted)}')" class="h-8 px-2.5 sm:px-3 rounded-lg bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/30 text-xs font-medium flex items-center justify-center gap-1.5 transition active:scale-95 cursor-pointer min-w-[40px] sm:min-w-0" title="View log content">
            <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
            <span>View</span>
          </button>

          <button type="button" onclick="event.stopPropagation(); window.confirmClearSingleLogFile('${escapeHtml(file.name)}')" class="h-8 px-2.5 sm:px-3 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 text-xs font-medium flex items-center justify-center gap-1.5 transition active:scale-95 cursor-pointer min-w-[40px] sm:min-w-0" title="Clear/Truncate this log file">
            <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
            <span>Clear</span>
          </button>

          <button type="button" onclick="event.stopPropagation(); window.downloadLogFile('${escapeHtml(file.name)}')" class="h-8 px-2.5 sm:px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white border border-zinc-700 text-xs font-medium flex items-center justify-center gap-1.5 transition active:scale-95 cursor-pointer min-w-[40px] sm:min-w-0" title="Download raw log file">
            <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
            <span>Download</span>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

export async function openLogViewer(filename, initialSizeFormatted) {
  if (!filename) return;
  activeLogViewerFile = filename;
  const modal = document.getElementById('log-viewer-modal');
  const filenameEl = document.getElementById('log-viewer-filename');
  const subtitleEl = document.getElementById('log-viewer-meta-subtitle');
  const sizeBadgeEl = document.getElementById('log-viewer-size-badge');

  if (filenameEl) filenameEl.textContent = filename;
  if (subtitleEl) subtitleEl.textContent = `storage/logs/${filename} · Loading...`;
  if (sizeBadgeEl) sizeBadgeEl.textContent = initialSizeFormatted || '...';

  if (modal) modal.classList.remove('hidden');
  updateLinesPillState();
  await loadLogViewerContent();
}

export function closeLogViewer() {
  const modal = document.getElementById('log-viewer-modal');
  if (modal) modal.classList.add('hidden');
  activeLogViewerFile = '';
  rawLogViewerContent = '';
}

export function setLogViewerLines(lines) {
  activeLogViewerLines = lines;
  updateLinesPillState();
  if (activeLogViewerFile) {
    loadLogViewerContent();
  }
}

export function updateLinesPillState() {
  const pills = [50, 200, 500];
  pills.forEach(p => {
    const el = document.getElementById(`lines-pill-${p}`);
    if (!el) return;
    if (p === activeLogViewerLines) {
      el.className = 'px-2.5 py-1 rounded bg-zinc-800 text-white font-semibold shadow-sm transition cursor-pointer';
    } else {
      el.className = 'px-2.5 py-1 rounded text-zinc-400 hover:text-white transition cursor-pointer';
    }
  });
  const countEl = document.getElementById('log-viewer-terminal-lines-count');
  if (countEl) countEl.textContent = String(activeLogViewerLines);
}

export async function refreshLogViewerContent() {
  const icon = document.getElementById('log-viewer-refresh-icon');
  if (icon) icon.classList.add('animate-spin');
  try {
    await loadLogViewerContent();
    showToast(`Refreshed ${activeLogViewerFile}`);
  } finally {
    if (icon) setTimeout(() => icon.classList.remove('animate-spin'), 400);
  }
}

export async function loadLogViewerContent() {
  if (!activeLogViewerFile) return;

  const contentEl = document.getElementById('log-viewer-content');
  const subtitleEl = document.getElementById('log-viewer-meta-subtitle');
  const sizeBadgeEl = document.getElementById('log-viewer-size-badge');
  const footerStatsEl = document.getElementById('log-viewer-footer-stats');

  if (contentEl) {
    contentEl.innerHTML = `
      <div class="text-zinc-500 text-center py-12 flex flex-col items-center justify-center gap-2 font-sans">
        <svg class="w-6 h-6 text-cyan-400 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
        <span class="text-zinc-400 text-xs">Reading ${escapeHtml(activeLogViewerFile)} (last ${activeLogViewerLines} lines)...</span>
      </div>
    `;
  }

  try {
    const data = await SystemApi.viewLogFile(activeLogViewerFile, activeLogViewerLines);

    if (!data || (!data.success && !data.data)) {
      const errMsg = data?.error?.message || data?.message || 'Failed to read log file';
      if (contentEl) {
        contentEl.innerHTML = `
          <div class="text-rose-400 text-center py-12 font-sans space-y-2">
            <div class="font-semibold text-xs">Error reading log file</div>
            <div class="text-[11px] text-zinc-400 font-mono">${escapeHtml(errMsg)}</div>
          </div>
        `;
      }
      return;
    }

    const logData = data.data || data;
    rawLogViewerContent = logData.content !== undefined ? logData.content : (data.content || '');
    const linesCount = logData.lines !== undefined ? logData.lines : (data.lines !== undefined ? data.lines : 0);
    
    const sizeFormatted = logData.sizeFormatted || data.sizeFormatted || (logData.totalSizeBytes !== undefined ? formatBytes(logData.totalSizeBytes) : '') || (data.totalSizeBytes !== undefined ? formatBytes(data.totalSizeBytes) : '') || '0 B';
    const modifiedRaw = logData.modifiedAt || data.modifiedAt;
    const modifiedAt = modifiedRaw ? new Date(modifiedRaw).toLocaleTimeString() : 'Recently';

    if (subtitleEl) subtitleEl.textContent = `storage/logs/${activeLogViewerFile} · Modified ${modifiedAt}`;
    if (sizeBadgeEl) sizeBadgeEl.textContent = sizeFormatted;
    if (footerStatsEl) footerStatsEl.textContent = `Showing last ${linesCount} lines (${sizeFormatted})`;

    renderLogViewerTerminal(rawLogViewerContent);
  } catch (err) {
    if (contentEl) {
      contentEl.innerHTML = `
        <div class="text-rose-400 text-center py-12 font-sans space-y-2">
          <div class="font-semibold text-xs">Network error while fetching logs</div>
          <div class="text-[11px] text-zinc-400 font-mono">${escapeHtml(err.message)}</div>
        </div>
      `;
    }
  }
}

export function renderLogViewerTerminal(content) {
  const contentEl = document.getElementById('log-viewer-content');
  if (!contentEl) return;

  if (!content || content.trim() === '') {
    contentEl.innerHTML = '<div class="text-zinc-500 text-center py-12 text-xs font-sans">Log file is currently empty (0 bytes).</div>';
    return;
  }

  const rawLines = content.split(/\r?\n/);
  // Remove trailing blank line if present
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }

  const formattedHtml = rawLines.map((line, idx) => {
    return formatLogViewerLine(line, idx + 1);
  }).join('');

  contentEl.innerHTML = `<div class="table w-full font-mono text-[11px] sm:text-xs">${formattedHtml}</div>`;

  setTimeout(() => {
    contentEl.scrollTop = contentEl.scrollHeight;
  }, 50);
}

export function scrollLogViewerToTop() {
  const contentEl = document.getElementById('log-viewer-content');
  if (contentEl) contentEl.scrollTo({ top: 0, behavior: 'smooth' });
}

export function scrollLogViewerToBottom() {
  const contentEl = document.getElementById('log-viewer-content');
  if (contentEl) contentEl.scrollTo({ top: contentEl.scrollHeight, behavior: 'smooth' });
}

export function copyLogViewerContent() {
  if (!rawLogViewerContent) {
    showToast('No log content to copy', 'warn');
    return;
  }
  navigator.clipboard.writeText(rawLogViewerContent).then(() => {
    showToast(`Copied ${activeLogViewerFile} content to clipboard`);
  }).catch(() => {
    showToast('Failed to copy to clipboard', 'error');
  });
}

export function downloadLogFile(filename) {
  if (!filename) return;
  const downloadUrl = `/api/logs/download?file=${encodeURIComponent(filename)}`;
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast(`Downloading ${filename}...`);
}

export function downloadCurrentLogViewerFile() {
  if (!activeLogViewerFile) return;
  downloadLogFile(activeLogViewerFile);
}

let pendingClearTarget = '';

export function openClearLogModal(targetFile) {
  pendingClearTarget = targetFile || 'all';
  const modal = document.getElementById('clear-log-modal');
  const titleEl = document.getElementById('clear-log-modal-title');
  const descEl = document.getElementById('clear-log-modal-desc');
  const targetNameEl = document.getElementById('clear-log-target-name');
  const btnTextEl = document.getElementById('btn-confirm-clear-log-text');

  if (targetFile === 'all') {
    if (titleEl) titleEl.textContent = 'Clear All Log Files?';
    if (descEl) descEl.textContent = 'This will safely truncate all log files in storage/logs/ to 0 bytes without stopping gateway services:';
    if (targetNameEl) targetNameEl.textContent = 'All storage/logs/*.log files';
    if (btnTextEl) btnTextEl.textContent = 'Clear All Logs';
  } else {
    if (titleEl) titleEl.textContent = 'Clear Log File?';
    if (descEl) descEl.textContent = 'This will safely truncate this log file to 0 bytes without stopping gateway services:';
    if (targetNameEl) targetNameEl.textContent = `storage/logs/${targetFile}`;
    if (btnTextEl) btnTextEl.textContent = 'Clear File';
  }

  if (modal) modal.classList.remove('hidden');
}

export function closeClearLogModal() {
  const modal = document.getElementById('clear-log-modal');
  if (modal) modal.classList.add('hidden');
  pendingClearTarget = '';
}

export async function executeConfirmedLogClear() {
  const target = pendingClearTarget;
  if (!target) return;

  const btn = document.getElementById('btn-confirm-clear-log');
  const btnText = document.getElementById('btn-confirm-clear-log-text');
  if (btn) btn.disabled = true;
  if (btnText) btnText.textContent = 'Clearing...';

  try {
    await executeClearLogFile(target);
  } finally {
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = target === 'all' ? 'Clear All Logs' : 'Clear File';
    closeClearLogModal();
  }
}

export function confirmClearCurrentLogFile() {
  if (!activeLogViewerFile) {
    showToast('No log file currently opened', 'warn');
    return;
  }
  openClearLogModal(activeLogViewerFile);
}

export function confirmClearSingleLogFile(filename) {
  if (!filename) return;
  openClearLogModal(filename);
}

export function confirmClearAllLogs() {
  openClearLogModal('all');
}

export async function executeClearLogFile(targetFile) {
  if (!targetFile) return;
  showToast(`Clearing ${targetFile === 'all' ? 'all log files' : targetFile}...`);
  try {
    const data = await SystemApi.clearLogFile(targetFile);
    if (data && data.success) {
      const freedStr = data.freedBytesFormatted || data.data?.freedBytesFormatted || '';
      showToast(`Log file cleared successfully${freedStr ? ' (' + freedStr + ' freed)' : ''}`);

      // If the currently opened file in the viewer was cleared (or 'all' was cleared)
      if (activeLogViewerFile && (activeLogViewerFile === targetFile || targetFile === 'all')) {
        rawLogViewerContent = '';
        renderLogViewerTerminal('');

        // Update DOM stats and badges immediately
        const sizeBadgeEl = document.getElementById('log-viewer-size-badge');
        const footerStatsEl = document.getElementById('log-viewer-footer-stats');
        const countEl = document.getElementById('log-viewer-terminal-lines-count');
        const subtitleEl = document.getElementById('log-viewer-meta-subtitle');

        if (sizeBadgeEl) sizeBadgeEl.textContent = '0 B';
        if (footerStatsEl) footerStatsEl.textContent = 'Showing 0 lines (0 B)';
        if (countEl) countEl.textContent = '0';
        if (subtitleEl) subtitleEl.textContent = `storage/logs/${activeLogViewerFile} · Modified Just now`;
      }

      // If all logs were cleared, also clear live stream feed if requested
      if (targetFile === 'all') {
        cachedLogsList = [];
        renderLogs();
      }

      // Trigger background refresh of the disk log file list
      await fetchLogFiles();
    } else {
      const errMsg = data?.error?.message || data?.message || 'Failed to clear log file';
      showToast(`Failed to clear log: ${errMsg}`, 'error');
    }
  } catch (err) {
    showToast('Request to clear logs failed: ' + (err.message || err), 'error');
  }
}

export async function triggerLogCleanup() {
  showToast('Running log retention cleanup (14 days)...');
  try {
    const data = await SystemApi.cleanupLogs();
    if (data && data.success) {
      showToast(`Log cleanup complete: deleted ${data.deletedFilesCount} file(s), freed ${data.freedBytesFormatted}`);
      await fetchLogFiles();
      if (activeLogViewerFile) {
        await loadLogViewerContent();
      }
    } else {
      showToast('Log cleanup failed', 'error');
    }
  } catch (err) {
    showToast('Log cleanup request failed: ' + err.message, 'error');
  }
}

export async function triggerMediaCleanup() {
  showToast('Running media retention cleanup...');
  try {
    const data = await SystemApi.cleanupMedia();
    if (data && data.success) {
      showToast(`Cleanup complete: deleted ${data.deletedFilesCount} file(s), freed ${data.freedBytesFormatted}`);
    } else {
      showToast('Cleanup failed', 'error');
    }
  } catch (err) {
    showToast('Cleanup request failed: ' + err.message, 'error');
  }
}

/**
 * Gateway Events Feed
 */
export function toggleStreamPause() {
  streamPaused = !streamPaused;
  const btn = document.getElementById('btn-stream-pause');
  if (btn) {
    if (streamPaused) {
      btn.textContent = 'Resume';
      btn.className = 'px-2.5 py-1 text-[11px] rounded-lg bg-amber-500/20 text-amber-400 border border-amber-500/30 transition cursor-pointer';
      showToast('Event stream paused');
    } else {
      btn.textContent = 'Pause';
      btn.className = 'px-2.5 py-1 text-[11px] rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition cursor-pointer';
      fetchEvents();
    }
  }
}

export function clearEventFeed() {
  cachedEventsList = [];
  renderEvents();
  showToast('Event feed cleared');
}

export function setEventFilter(filter) {
  currentEventFilter = filter;
  document.querySelectorAll('.event-filter-btn').forEach(btn => {
    if (btn.getAttribute('data-filter') === filter) {
      btn.className = 'event-filter-btn px-2 py-0.8 rounded-lg bg-zinc-800 text-white font-medium whitespace-nowrap cursor-pointer';
    } else {
      btn.className = 'event-filter-btn px-2 py-0.8 rounded-lg text-zinc-400 hover:text-zinc-200 whitespace-nowrap cursor-pointer';
    }
  });
  renderEvents();
}

export async function fetchEvents() {
  if (streamPaused) return;
  const data = await SystemApi.getRecentEvents();
  if (!data || !data.events) return;
  cachedEventsList = data.events;
  renderEvents();
}

export function renderEvents() {
  const feed = document.getElementById('events-feed');
  const counter = document.getElementById('stream-counter');
  const autoscroll = document.getElementById('stream-autoscroll') ? document.getElementById('stream-autoscroll').checked : true;

  if (!feed) return;

  let filtered = cachedEventsList;
  if (currentEventFilter === 'inbound_message') {
    filtered = cachedEventsList.filter(e => e.type.includes('inbound'));
  } else if (currentEventFilter === 'outbound_message') {
    filtered = cachedEventsList.filter(e => e.type.includes('outbound'));
  } else if (currentEventFilter === 'message_ack') {
    filtered = cachedEventsList.filter(e => e.type === 'message_ack');
  } else if (currentEventFilter === 'webhook') {
    filtered = cachedEventsList.filter(e => e.type.includes('webhook'));
  } else if (currentEventFilter === 'session_event') {
    filtered = cachedEventsList.filter(e => e.type.includes('session'));
  }

  if (counter) counter.textContent = `${filtered.length} events logged`;

  if (filtered.length === 0) {
    feed.innerHTML = `
      <div class="text-zinc-600 text-center py-12 text-xs">
        No events matching '${escapeHtml(currentEventFilter)}'.
      </div>
    `;
    return;
  }

  feed.innerHTML = filtered.slice(0, 40).map((ev, index) => {
    let badgeColor = 'bg-zinc-800 text-zinc-300 border-zinc-700';
    let typeIcon = '⚡';

    if (ev.type === 'inbound_message') {
      badgeColor = 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30';
      typeIcon = '📥';
    } else if (ev.type === 'outbound_message') {
      badgeColor = 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
      typeIcon = '📤';
    } else if (ev.type === 'message_ack') {
      badgeColor = 'bg-teal-500/15 text-teal-300 border-teal-500/30';
      typeIcon = '📬';
    } else if (ev.type === 'webhook_dispatched') {
      badgeColor = 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30';
      typeIcon = '🔗';
    } else if (ev.type === 'webhook_failed') {
      badgeColor = 'bg-rose-500/15 text-rose-400 border-rose-500/30';
      typeIcon = '❌';
    } else if (ev.type === 'session_event') {
      badgeColor = 'bg-amber-500/15 text-amber-400 border-amber-500/30';
      typeIcon = '⚙️';
    }

    const relTime = getRelativeTime(ev.timestamp);
    const clockTime = new Date(ev.timestamp).toLocaleTimeString();
    const jsonString = JSON.stringify(ev.details || {}, null, 2);

    let summary = '';
    if (ev.details) {
      if (ev.type === 'message_ack') {
        summary = `ACK: ${ev.details.statusLabel || 'Status ' + ev.details.status} (${ev.details.remoteJid || 'Target'}) · Msg: ${ev.details.messageId || 'N/A'}`;
      } else if (ev.details.text) {
        summary = ev.details.text;
      } else if (ev.details.status) {
        summary = `Status changed to ${ev.details.status}`;
      } else if (ev.details.mediaType) {
        summary = `Media: ${ev.details.mediaType}`;
      } else if (ev.details.message) {
        summary = ev.details.message;
      } else {
        summary = JSON.stringify(ev.details).substring(0, 60);
      }
    }

    return `
      <div class="p-3 rounded-xl bg-zinc-950/80 border border-zinc-900/90 hover:border-zinc-800 transition-colors space-y-1.5">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="text-xs">${typeIcon}</span>
            <span class="px-2 py-0.5 rounded-md text-[10px] font-mono border font-semibold ${badgeColor}">
              ${escapeHtml(ev.type)}
            </span>
            ${ev.sessionId ? `<span class="text-[10px] font-mono text-zinc-400 truncate max-w-[100px]">[${escapeHtml(ev.sessionId)}]</span>` : ''}
          </div>

          <span class="text-[10px] text-zinc-500 font-mono flex-shrink-0" title="${escapeHtml(clockTime)}">${escapeHtml(relTime)}</span>
        </div>

        ${summary ? `<div class="text-zinc-300 text-xs truncate font-sans">${escapeHtml(summary)}</div>` : ''}

        <details class="group">
          <summary class="text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer flex items-center justify-between font-mono select-none pt-1">
            <span class="flex items-center gap-1">
              <svg class="w-3 h-3 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>
              <span>JSON Payload</span>
            </span>
            <button type="button" onclick="window.copyEventPayload(event, ${index})" class="text-[10px] text-zinc-400 hover:text-white px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700">
              Copy
            </button>
          </summary>
          <pre id="event-json-${index}" class="mt-1.5 p-2 rounded-lg bg-black/70 border border-zinc-900 text-[10px] text-zinc-300 overflow-x-auto font-mono whitespace-pre max-h-36 overflow-y-auto">${escapeHtml(jsonString)}</pre>
        </details>
      </div>
    `;
  }).join('');

  if (autoscroll) {
    feed.scrollTop = 0;
  }
}

export function copyEventPayload(event, index) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const el = document.getElementById(`event-json-${index}`);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(() => {
    showToast('Payload copied to clipboard');
  }).catch(() => {
    showToast('Failed to copy', 'error');
  });
}
