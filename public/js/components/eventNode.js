/**
 * Botla WhatsApp Gateway - Event Node Component
 * Renders non-destructive DOM elements for live gateway events
 * preserving expanded state, scroll position, and interactive copy feedback.
 */
import { escapeHtml, getRelativeTime, showToast } from '../modules/ui.js';

/**
 * Creates a standalone DOM element for an event entry.
 *
 * @param {Object} ev - Gateway event object
 * @param {string} ev.id - Unique event identifier
 * @param {number|string} ev.timestamp - Timestamp of event
 * @param {string} ev.type - Event category
 * @param {string} [ev.sessionId] - Associated tenant session
 * @param {Object} [ev.details] - Event payload details
 * @param {Object} [options]
 * @param {boolean} [options.isExpanded] - Whether JSON payload details should be open
 * @param {Function} [options.onToggleExpanded] - Callback when user expands/collapses
 * @returns {HTMLElement}
 */
export function createEventNode(ev, options = {}) {
  const eventId = ev.id || `${ev.type}_${ev.timestamp}_${Math.random().toString(36).substring(2, 9)}`;
  const node = document.createElement('div');
  node.id = `event-card-${eventId}`;
  node.setAttribute('data-event-id', eventId);
  node.setAttribute('data-event-type', ev.type || 'unknown');
  if (ev.sessionId) {
    node.setAttribute('data-session-id', ev.sessionId);
  }
  node.className = 'p-3 rounded-xl bg-zinc-950/80 border border-zinc-900/90 hover:border-zinc-800 transition-colors space-y-1.5';

  // Determine badge styling and visual icon
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
  const dateObj = new Date(ev.timestamp);
  const clockTime = !isNaN(dateObj.getTime()) ? dateObj.toLocaleTimeString() : '';
  const jsonString = JSON.stringify(ev.details || {}, null, 2);

  // Human-readable summary extraction
  let summary = '';
  if (ev.details) {
    if (ev.type === 'message_ack') {
      summary = `ACK: ${ev.details.statusLabel || 'Status ' + ev.details.status} (${ev.details.remoteJid || 'Target'}) · Msg: ${ev.details.messageId || 'N/A'}`;
    } else if (ev.details.text) {
      summary = ev.details.text;
    } else if (ev.details.status) {
      summary = `Status changed to ${ev.details.status}`;
    } else if (ev.details.mediaType) {
      summary = `Media: ${ev.details.mediaType}${ev.details.url ? ` (${ev.details.url})` : ''}`;
    } else if (ev.details.message) {
      summary = ev.details.message;
    } else {
      summary = JSON.stringify(ev.details).substring(0, 70);
    }
  }

  node.innerHTML = `
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-1.5 min-w-0">
        <span class="text-xs">${typeIcon}</span>
        <span class="px-2 py-0.5 rounded-md text-[10px] font-mono border font-semibold ${badgeColor}">
          ${escapeHtml(ev.type)}
        </span>
        ${ev.sessionId ? `<span class="text-[10px] font-mono text-zinc-400 truncate max-w-[120px]">[${escapeHtml(ev.sessionId)}]</span>` : ''}
      </div>

      <span class="text-[10px] text-zinc-500 font-mono flex-shrink-0" title="${escapeHtml(clockTime)}">${escapeHtml(relTime)}</span>
    </div>

    ${summary ? `<div class="text-zinc-300 text-xs truncate font-sans">${escapeHtml(summary)}</div>` : ''}

    <details class="group"${options.isExpanded ? ' open' : ''}>
      <summary class="text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer flex items-center justify-between font-mono select-none pt-1">
        <span class="flex items-center gap-1">
          <svg class="w-3 h-3 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>
          <span>JSON Payload</span>
        </span>
        <button type="button" class="event-copy-btn text-[10px] text-zinc-400 hover:text-white px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 transition cursor-pointer flex items-center gap-1" title="Copy raw JSON payload">
          <svg class="w-3 h-3 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2z"></path></svg>
          <span class="copy-label pointer-events-none">Copy</span>
        </button>
      </summary>
      <pre class="mt-1.5 p-2 rounded-lg bg-black/70 border border-zinc-900 text-[10px] text-zinc-300 overflow-x-auto font-mono whitespace-pre max-h-36 overflow-y-auto">${escapeHtml(jsonString)}</pre>
    </details>
  `;

  // Attach persistent toggle tracker so re-rendering keeps drawer state untouched
  const detailsEl = node.querySelector('details');
  if (detailsEl && typeof options.onToggleExpanded === 'function') {
    detailsEl.addEventListener('toggle', () => {
      options.onToggleExpanded(eventId, detailsEl.open);
    });
  }

  // Attach per-item copy handler with instant visual feedback
  const copyBtn = node.querySelector('.event-copy-btn');
  const copyLabel = node.querySelector('.copy-label');
  if (copyBtn) {
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();

      const textToCopy = jsonString || JSON.stringify(ev, null, 2);
      try {
        await navigator.clipboard.writeText(textToCopy);

        // Immediate 1.5s visual state swap
        if (copyLabel) copyLabel.textContent = 'Copied!';
        copyBtn.classList.add('text-emerald-400', 'border-emerald-500/40', 'bg-emerald-950/40');

        setTimeout(() => {
          if (copyLabel) copyLabel.textContent = 'Copy';
          copyBtn.classList.remove('text-emerald-400', 'border-emerald-500/40', 'bg-emerald-950/40');
        }, 1500);

        showToast('Payload copied to clipboard');
      } catch (err) {
        console.warn('Failed to copy payload:', err);
        showToast('Clipboard access denied', 'error');
      }
    });
  }

  return node;
}
