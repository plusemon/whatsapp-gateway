/**
 * Botla WhatsApp Gateway - Diagnostics & SSE Logs Module
 * Handles Pino SSE live stream and Gateway event buffer.
 */
import { SystemApi } from '../api.js';
import { escapeHtml, getRelativeTime, showToast } from './ui.js';
import { createEventNode } from '../components/eventNode.js';

// State variables
let currentStreamTab = 'logs'; // 'logs' | 'events'
let cachedLogsList = [];
let currentLogLevelFilter = 'all';
let logStreamPaused = false;
let sseEventSource = null;

let streamPaused = false;
let currentEventFilter = 'all';
let cachedEventsList = [];
const expandedEventIds = new Set();
let isInitialEventsRender = true;
let isUserScrolledUpEvents = false;
let autoScrollEventsListenerAttached = false;

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

        // Detect session_connected SSE event and trigger pairing success handler
        const action = logEntry.meta?.action || logEntry.meta?.event || logEntry.action || logEntry.event;
        const sessionId = logEntry.sessionId || logEntry.meta?.sessionId;

        if (
          (action === 'session_connected' || action === 'connected' || (logEntry.message && logEntry.message.includes('successfully connected'))) &&
          sessionId
        ) {
          if (typeof window !== 'undefined' && typeof window.handlePairingSuccess === 'function') {
            window.handlePairingSuccess({
              sessionId,
              status: 'connected',
              user: logEntry.meta?.user || { id: sessionId },
            });
          }
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

export function getFilteredLogs() {
  let filtered = cachedLogsList;

  if (currentLogLevelFilter !== 'all') {
    filtered = filtered.filter(l => (l.level || '').toLowerCase() === currentLogLevelFilter);
  }

  const sessionFilter = document.getElementById('log-filter-session') ? document.getElementById('log-filter-session').value.trim().toLowerCase() : '';
  if (sessionFilter) {
    filtered = filtered.filter(l => (l.sessionId || '').toLowerCase().includes(sessionFilter));
  }

  return filtered;
}

export function renderLogs() {
  const feed = document.getElementById('logs-feed');
  const counter = document.getElementById('log-counter');
  const autoscroll = document.getElementById('log-autoscroll') ? document.getElementById('log-autoscroll').checked : true;

  if (!feed) return;

  const filtered = getFilteredLogs();

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
        <div class="flex items-center justify-between gap-2 flex-wrap sm:flex-nowrap">
          <div class="flex items-center gap-1.5 min-w-0 flex-wrap">
            <span class="px-1.5 py-0.2 rounded text-[10px] uppercase font-bold border ${badgeColor}">
              ${escapeHtml(lvl)}
            </span>
            ${log.sessionId ? `<span class="px-1.5 py-0.2 rounded bg-emerald-950/40 text-emerald-400 border border-emerald-800/40 text-[10px] font-mono truncate max-w-[120px]">[${escapeHtml(log.sessionId)}]</span>` : ''}
          </div>
          <div class="flex items-center gap-1.5 flex-shrink-0">
            <span class="text-[10px] text-zinc-500 font-mono" title="${escapeHtml(clockTime)}">${escapeHtml(relTime)}</span>
            <div class="flex items-center gap-1">
              <button type="button" onclick="window.copyLogMessage(event, ${index})" class="text-[10px] text-zinc-400 hover:text-white px-1.5 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 cursor-pointer transition" title="Copy message text">
                Msg
              </button>
              <button type="button" onclick="window.copyLogLine(event, ${index})" class="text-[10px] text-zinc-400 hover:text-white px-1.5 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 cursor-pointer transition" title="Copy formatted log line">
                Line
              </button>
              <button type="button" onclick="window.copyLogEntry(event, ${index})" class="text-[10px] text-zinc-400 hover:text-white px-1.5 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 cursor-pointer transition" title="Copy log JSON object">
                JSON
              </button>
            </div>
          </div>
        </div>

        <div class="text-zinc-200 text-xs font-mono break-words leading-relaxed">${escapeHtml(stripAnsi(log.message))}</div>

        ${hasMeta ? `
          <details class="group">
            <summary class="text-[10px] text-zinc-500 hover:text-zinc-300 cursor-pointer flex items-center justify-between font-mono select-none pt-0.5">
              <span class="flex items-center gap-1">
                <svg class="w-3 h-3 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>
                <span>Inspect Metadata</span>
              </span>
              <button type="button" onclick="window.copyLogMeta(event, ${index})" class="text-[10px] text-zinc-400 hover:text-white px-1.5 py-0.2 rounded bg-zinc-800 hover:bg-zinc-700 cursor-pointer">
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

export function copyAllLogs(format = 'text') {
  const filtered = getFilteredLogs();
  if (!filtered || filtered.length === 0) {
    showToast('No logs available to copy', 'error');
    return;
  }

  let textToCopy = '';
  if (format === 'json') {
    textToCopy = JSON.stringify(filtered, null, 2);
  } else {
    textToCopy = filtered.map(log => {
      const ts = log.timestamp || new Date().toISOString();
      const lvl = (log.level || 'info').toUpperCase();
      const sess = log.sessionId ? `[${log.sessionId}] ` : '';
      const msg = stripAnsi(log.message || '');
      const meta = log.meta && Object.keys(log.meta).length > 0 ? ` ${JSON.stringify(log.meta)}` : '';
      return `[${ts}] [${lvl}] ${sess}${msg}${meta}`;
    }).join('\n');
  }

  navigator.clipboard.writeText(textToCopy).then(() => {
    showToast(`Copied ${filtered.length} log(s) to clipboard (${format.toUpperCase()})`);
  }).catch(() => {
    showToast('Failed to copy logs', 'error');
  });
}

export function copyLogEntry(event, index) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const filtered = getFilteredLogs();
  const log = filtered[index];
  if (!log) return;

  const textToCopy = JSON.stringify(log, null, 2);
  navigator.clipboard.writeText(textToCopy).then(() => {
    showToast('Log entry JSON copied');
  }).catch(() => {
    showToast('Failed to copy', 'error');
  });
}

export function copyLogMessage(event, index) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const filtered = getFilteredLogs();
  const log = filtered[index];
  if (!log) return;

  const msg = stripAnsi(log.message || '');
  navigator.clipboard.writeText(msg).then(() => {
    showToast('Log message text copied');
  }).catch(() => {
    showToast('Failed to copy', 'error');
  });
}

export function copyLogLine(event, index) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const filtered = getFilteredLogs();
  const log = filtered[index];
  if (!log) return;

  const ts = log.timestamp || new Date().toISOString();
  const lvl = (log.level || 'info').toUpperCase();
  const sess = log.sessionId ? `[${log.sessionId}] ` : '';
  const msg = stripAnsi(log.message || '');
  const meta = log.meta && Object.keys(log.meta).length > 0 ? ` ${JSON.stringify(log.meta)}` : '';
  const line = `[${ts}] [${lvl}] ${sess}${msg}${meta}`;

  navigator.clipboard.writeText(line).then(() => {
    showToast('Formatted log line copied');
  }).catch(() => {
    showToast('Failed to copy', 'error');
  });
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

/**
 * Checks whether the events container is scrolled near the bottom within threshold.
 * @param {HTMLElement} container 
 * @param {number} threshold 
 * @returns {boolean}
 */
export function isEventsNearBottom(container, threshold = 80) {
  if (!container) return true;
  return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
}

/**
 * Binds user-aware scroll listeners to pause/resume auto-scrolling intelligently.
 */
function ensureEventsScrollListeners() {
  if (autoScrollEventsListenerAttached) return;
  const feed = document.getElementById('events-feed');
  const autoscrollCheckbox = document.getElementById('stream-autoscroll');
  if (!feed) return;

  autoScrollEventsListenerAttached = true;

  feed.addEventListener('scroll', () => {
    if (isEventsNearBottom(feed, 80)) {
      isUserScrolledUpEvents = false;
      if (autoscrollCheckbox && !autoscrollCheckbox.checked) {
        autoscrollCheckbox.checked = true;
      }
    } else {
      // User manually scrolled up to inspect earlier logs
      isUserScrolledUpEvents = true;
    }
  }, { passive: true });

  if (autoscrollCheckbox) {
    autoscrollCheckbox.addEventListener('change', () => {
      if (autoscrollCheckbox.checked) {
        isUserScrolledUpEvents = false;
        feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
      } else {
        isUserScrolledUpEvents = true;
      }
    });
  }
}

export function toggleStreamPause() {
  streamPaused = !streamPaused;
  const btn = document.getElementById('btn-stream-pause');
  if (btn) {
    if (streamPaused) {
      btn.textContent = 'Resume';
      btn.className = 'px-3.5 py-1 text-xs rounded-lg bg-amber-500/20 text-amber-400 border border-amber-500/30 transition cursor-pointer min-h-[32px]';
      showToast('Event stream paused');
    } else {
      btn.textContent = 'Pause';
      btn.className = 'px-3.5 py-1 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition cursor-pointer min-h-[32px]';
      fetchEvents();
    }
  }
}

export function clearEventFeed() {
  cachedEventsList = [];
  expandedEventIds.clear();
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

export function filterEventsChanged() {
  renderEvents();
}

export async function fetchEvents() {
  if (streamPaused) return;
  const data = await SystemApi.getRecentEvents();
  if (!data || !Array.isArray(data.events)) return;
  cachedEventsList = data.events;
  renderEvents();
}

/**
 * Returns filtered and chronologically ordered events.
 * @returns {Array<Object>}
 */
export function getFilteredEvents() {
  // Sort chronologically (ascending: oldest -> newest) so new arrivals append to the bottom
  const sorted = [...cachedEventsList].sort((a, b) => {
    const tA = typeof a.timestamp === 'number' ? a.timestamp : new Date(a.timestamp).getTime();
    const tB = typeof b.timestamp === 'number' ? b.timestamp : new Date(b.timestamp).getTime();
    return tA - tB;
  });

  let filtered = sorted;
  if (currentEventFilter === 'inbound_message') {
    filtered = sorted.filter(e => (e.type || '').includes('inbound'));
  } else if (currentEventFilter === 'outbound_message') {
    filtered = sorted.filter(e => (e.type || '').includes('outbound'));
  } else if (currentEventFilter === 'message_ack') {
    filtered = sorted.filter(e => e.type === 'message_ack');
  } else if (currentEventFilter === 'webhook') {
    filtered = sorted.filter(e => (e.type || '').includes('webhook'));
  } else if (currentEventFilter === 'session_event') {
    filtered = sorted.filter(e => (e.type || '').includes('session'));
  }

  const sessionInput = document.getElementById('event-filter-session');
  const sessionQuery = sessionInput ? sessionInput.value.trim().toLowerCase() : '';
  if (sessionQuery) {
    filtered = filtered.filter(e =>
      (e.sessionId || '').toLowerCase().includes(sessionQuery) ||
      (e.type || '').toLowerCase().includes(sessionQuery) ||
      JSON.stringify(e.details || {}).toLowerCase().includes(sessionQuery)
    );
  }

  return filtered;
}

/**
 * Non-destructively renders gateway events using insertAdjacentElement.
 * Preserves expanded details drawers, user scroll position, and avoids full DOM thrashing.
 */
export function renderEvents() {
  const feed = document.getElementById('events-feed');
  const counter = document.getElementById('stream-counter');
  const autoscrollCheckbox = document.getElementById('stream-autoscroll');

  if (!feed) return;
  ensureEventsScrollListeners();

  const filtered = getFilteredEvents();

  if (counter) {
    counter.textContent = `${filtered.length} events logged`;
  }

  if (filtered.length === 0) {
    feed.innerHTML = `
      <div id="events-empty-placeholder" class="text-zinc-600 text-center py-12 text-xs">
        No events matching '${escapeHtml(currentEventFilter)}'.
      </div>
    `;
    return;
  }

  // Remove empty placeholder if present
  const placeholder = document.getElementById('events-empty-placeholder');
  if (placeholder) {
    placeholder.remove();
  }

  // Map existing rendered nodes by data-event-id
  const existingElements = new Map();
  for (const child of Array.from(feed.children)) {
    const id = child.getAttribute('data-event-id');
    if (id) {
      existingElements.set(id, child);
    }
  }

  // Active event IDs in this render pass
  const activeIds = new Set(filtered.map(e => e.id || `${e.type}_${e.timestamp}`));

  // 1. Remove stale nodes no longer matching the filter
  for (const [id, child] of existingElements.entries()) {
    if (!activeIds.has(id)) {
      child.remove();
      existingElements.delete(id);
    }
  }

  // 2. Non-destructively append or insert new nodes preserving existing ones
  let hasNewAppends = false;
  let prevNode = null;

  for (let i = 0; i < filtered.length; i++) {
    const ev = filtered[i];
    const eventId = ev.id || `${ev.type}_${ev.timestamp}`;
    let node = existingElements.get(eventId);

    if (!node) {
      // Create new event node
      node = createEventNode(ev, {
        isExpanded: expandedEventIds.has(eventId),
        onToggleExpanded: (id, open) => {
          if (open) expandedEventIds.add(id);
          else expandedEventIds.delete(id);
        },
      });
      hasNewAppends = true;

      if (!prevNode) {
        feed.insertAdjacentElement('afterbegin', node);
      } else {
        prevNode.insertAdjacentElement('afterend', node);
      }
      existingElements.set(eventId, node);
    } else {
      // Node already exists in DOM - preserve its state untouched!
      // Only verify relative order
      if (prevNode && node.previousElementSibling !== prevNode) {
        prevNode.insertAdjacentElement('afterend', node);
      }
    }

    prevNode = node;
  }

  // 3. Intelligent User-Aware Auto-Scroll
  const shouldAutoScroll = autoscrollCheckbox ? autoscrollCheckbox.checked : true;
  if (isInitialEventsRender) {
    isInitialEventsRender = false;
    if (shouldAutoScroll) {
      feed.scrollTop = feed.scrollHeight;
    }
  } else if (hasNewAppends && shouldAutoScroll && !isUserScrolledUpEvents && isEventsNearBottom(feed, 80)) {
    feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
  }
}

/**
 * Copies the entire currently visible stream of filtered events to clipboard.
 * @param {Event} [e] 
 */
export function copyAllEvents(e) {
  if (e) {
    e.stopPropagation();
    e.preventDefault();
  }

  const filtered = getFilteredEvents();
  if (!filtered || filtered.length === 0) {
    showToast('No events available to copy', 'warn');
    return;
  }

  const textToCopy = filtered.map(ev => {
    const ts = new Date(ev.timestamp).toISOString();
    const type = (ev.type || 'EVENT').toUpperCase();
    const sess = ev.sessionId ? `[${ev.sessionId}] ` : '';
    const detailsStr = typeof ev.details === 'object' ? JSON.stringify(ev.details) : String(ev.details || '');
    return `[${ts}] [${type}] ${sess}${detailsStr}`;
  }).join('\n');

  navigator.clipboard.writeText(textToCopy).then(() => {
    const btn = document.getElementById('btn-copy-all-events');
    const label = document.getElementById('btn-copy-all-events-text');
    if (label) label.textContent = 'Copied!';
    if (btn) btn.classList.add('text-emerald-400', 'border-emerald-500/40');

    setTimeout(() => {
      if (label) label.textContent = 'Copy All';
      if (btn) btn.classList.remove('text-emerald-400', 'border-emerald-500/40');
    }, 1500);

    showToast(`Copied ${filtered.length} event(s) to clipboard`);
  }).catch((err) => {
    console.warn('Failed to copy events:', err);
    showToast('Clipboard copy failed', 'error');
  });
}

/**
 * Backward compatibility stub for legacy index-based callers
 */
export function copyEventPayload(event, index) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const filtered = getFilteredEvents();
  const ev = filtered[index];
  if (!ev) return;
  const text = JSON.stringify(ev.details || ev, null, 2);
  navigator.clipboard.writeText(text).then(() => {
    showToast('Payload copied to clipboard');
  }).catch(() => {
    showToast('Failed to copy', 'error');
  });
}
