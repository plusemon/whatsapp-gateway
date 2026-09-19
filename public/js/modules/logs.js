/**
 * Botla WhatsApp Gateway - Diagnostics & SSE Logs Module
 * Handles Pino SSE live stream and Gateway event buffer.
 */
import { SystemApi } from '../api.js';
import { escapeHtml, getRelativeTime, showToast } from './ui.js';

// State variables
let currentStreamTab = 'logs'; // 'logs' | 'events'
let cachedLogsList = [];
let currentLogLevelFilter = 'all';
let logStreamPaused = false;
let sseEventSource = null;

let streamPaused = false;
let currentEventFilter = 'all';
let cachedEventsList = [];

function stripAnsi(str) {
  if (!str) return '';
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Switches the console sub-tabs.
 * @param {'logs'|'events'} tab 
 */
export function switchStreamTab(tab) {
  currentStreamTab = tab;
  const subviewLogs = document.getElementById('subview-pino-logs');
  const subviewEvents = document.getElementById('subview-gateway-events');

  const btnLogs = document.getElementById('stream-tab-btn-logs');
  const btnEvents = document.getElementById('stream-tab-btn-events');

  [subviewLogs, subviewEvents].forEach(v => {
    if (v) v.classList.add('hidden');
  });
  [btnLogs, btnEvents].forEach(b => {
    if (b) b.className = 'px-3.5 py-1.5 rounded-lg text-zinc-400 hover:text-white cursor-pointer transition active:scale-95 flex items-center gap-1.5';
  });

  if (tab === 'logs') {
    if (subviewLogs) subviewLogs.classList.remove('hidden');
    if (btnLogs) btnLogs.className = 'px-3.5 py-1.5 rounded-lg bg-zinc-800 text-white cursor-pointer transition active:scale-95 flex items-center gap-1.5';
    renderLogs();
  } else if (tab === 'events') {
    if (subviewEvents) subviewEvents.classList.remove('hidden');
    if (btnEvents) btnEvents.className = 'px-3.5 py-1.5 rounded-lg bg-zinc-800 text-white cursor-pointer transition active:scale-95 flex items-center gap-1.5';
    renderEvents();
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
      btn.className = 'log-level-filter-btn px-2.5 py-1 rounded-lg bg-zinc-800 text-white font-medium cursor-pointer';
    } else {
      btn.className = 'log-level-filter-btn px-2.5 py-1 rounded-lg text-zinc-400 hover:text-zinc-200 cursor-pointer';
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
      btn.className = 'px-3 py-1 text-xs rounded-lg bg-amber-500/20 text-amber-400 border border-amber-500/30 transition cursor-pointer';
      showToast('Pino log stream paused');
    } else {
      btn.textContent = 'Pause';
      btn.className = 'px-3 py-1 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition cursor-pointer';
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
      btn.className = 'px-3.5 py-1 text-xs rounded-lg bg-amber-500/20 text-amber-400 border border-amber-500/30 transition cursor-pointer';
      showToast('Event stream paused');
    } else {
      btn.textContent = 'Pause';
      btn.className = 'px-3.5 py-1 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition cursor-pointer';
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
      btn.className = 'event-filter-btn px-2.5 py-1 rounded-lg bg-zinc-800 text-white font-medium cursor-pointer';
    } else {
      btn.className = 'event-filter-btn px-2.5 py-1 rounded-lg text-zinc-400 hover:text-zinc-200 cursor-pointer';
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
