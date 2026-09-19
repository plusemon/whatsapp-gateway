/**
 * Botla WhatsApp Gateway - Log Viewer Modal & Pino Parser Component
 * Parses structured JSON Pino logs into human-readable, color-coded terminal streams,
 * and manages interactive log viewer modal actions (View, Refresh, Truncate/Clear, Download, Copy).
 */
import { SystemApi } from '../api.js';
import { escapeHtml, formatBytes, showToast } from '../modules/ui.js';

/**
 * Strips ANSI color and formatting escape codes from text
 * @param {string} str
 * @returns {string}
 */
export function stripAnsi(str) {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

/**
 * Formats ISO or epoch timestamp into local HH:mm:ss.SSS
 * @param {string|number} timeVal
 * @returns {string}
 */
export function formatLogTimestamp(timeVal) {
  if (!timeVal) return '';
  const date = new Date(timeVal);
  if (isNaN(date.getTime())) return escapeHtml(String(timeVal));
  const pad = (n, z = 2) => String(n).padStart(z, '0');
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  const millis = pad(date.getMilliseconds(), 3);
  return `${hours}:${minutes}:${seconds}.${millis}`;
}

/**
 * Maps numeric or string Pino log levels to text and color-coded badges.
 * Requirements:
 * - 30 (INFO) -> text-emerald-400 bg-emerald-950/60
 * - 40 (WARN) -> text-amber-400 bg-amber-950/60
 * - 50 (ERROR) / 60 (FATAL) -> text-rose-400 bg-rose-950/60
 * - 20 (DEBUG) -> text-blue-400 bg-blue-950/60
 * - 10 (TRACE) -> text-zinc-400 bg-zinc-900/80
 * @param {number|string} levelVal
 * @returns {{ lvlNum: number, lvlText: string, badgeClass: string }}
 */
export function getLogLevelBadgeInfo(levelVal) {
  let lvlNum = typeof levelVal === 'number' ? levelVal : 30;
  let lvlText = 'INFO';
  let badgeClass = 'text-emerald-400 bg-emerald-950/60 border border-emerald-800/40';

  if (typeof levelVal === 'string') {
    const lower = levelVal.toLowerCase().trim();
    if (lower === 'fatal' || lower === '60') {
      lvlNum = 60;
      lvlText = 'FATAL';
    } else if (lower === 'error' || lower === '50') {
      lvlNum = 50;
      lvlText = 'ERROR';
    } else if (lower === 'warn' || lower === 'warning' || lower === '40') {
      lvlNum = 40;
      lvlText = 'WARN';
    } else if (lower === 'info' || lower === '30') {
      lvlNum = 30;
      lvlText = 'INFO';
    } else if (lower === 'debug' || lower === '20') {
      lvlNum = 20;
      lvlText = 'DEBUG';
    } else if (lower === 'trace' || lower === '10') {
      lvlNum = 10;
      lvlText = 'TRACE';
    } else {
      lvlText = levelVal.toUpperCase();
    }
  } else {
    if (lvlNum >= 60) lvlText = 'FATAL';
    else if (lvlNum >= 50) lvlText = 'ERROR';
    else if (lvlNum >= 40) lvlText = 'WARN';
    else if (lvlNum >= 30) lvlText = 'INFO';
    else if (lvlNum >= 20) lvlText = 'DEBUG';
    else lvlText = 'TRACE';
  }

  if (lvlNum >= 50) {
    badgeClass = 'text-rose-400 bg-rose-950/60 border border-rose-800/40';
  } else if (lvlNum >= 40) {
    badgeClass = 'text-amber-400 bg-amber-950/60 border border-amber-800/40';
  } else if (lvlNum >= 30) {
    badgeClass = 'text-emerald-400 bg-emerald-950/60 border border-emerald-800/40';
  } else if (lvlNum >= 20) {
    badgeClass = 'text-blue-400 bg-blue-950/60 border border-blue-800/40';
  } else {
    badgeClass = 'text-zinc-400 bg-zinc-900/80 border border-zinc-700/50';
  }

  return { lvlNum, lvlText, badgeClass };
}

/**
 * Builds a brief readable string from metadata keys.
 * @param {Record<string, any>} meta
 * @returns {string}
 */
export function buildMetaSummary(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const entries = Object.entries(meta);
  if (entries.length === 0) return '';

  const parts = [];
  for (const [k, v] of entries) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') {
      if (Array.isArray(v)) {
        parts.push(`${k}: [${v.length}]`);
      } else {
        parts.push(`${k}: {...}`);
      }
    } else {
      parts.push(`${k}: ${v}`);
    }
    if (parts.length >= 4) break;
  }

  return parts.join(' · ');
}

/**
 * Parses a raw line from a log file.
 * Returns parsed object if valid JSON, or null otherwise.
 * @param {string} line
 * @returns {any|null}
 */
export function parsePinoJsonLine(line) {
  if (!line) return null;
  const cleanLine = stripAnsi(line);
  const trimmed = cleanLine.trim();
  if (!trimmed || !trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    // Not valid JSON
  }
  return null;
}

/**
 * Renders a single log entry into HTML table row format.
 * @param {string} line - Raw line text
 * @param {number} lineNum - 1-based line index
 * @returns {string} HTML string
 */
export function formatLogViewerLine(line, lineNum) {
  if (!line || line.trim() === '') {
    return `<div class="table-row leading-relaxed hover:bg-zinc-900/50 transition-colors">
      <span class="table-cell select-none text-zinc-700 pr-2.5 sm:pr-3 text-right text-[10px] w-8 sm:w-10 font-mono align-top py-0.5">${lineNum}</span>
      <span class="table-cell text-zinc-600 font-mono text-[11px] sm:text-xs py-0.5">&nbsp;</span>
    </div>`;
  }

  const cleanLine = stripAnsi(line);
  const parsed = parsePinoJsonLine(cleanLine);

  // Fallback: If line cannot be parsed as JSON, render it as plain monospace text
  if (!parsed) {
    let plainColor = 'text-zinc-300';
    const lower = cleanLine.toLowerCase();
    if (lower.includes('error') || lower.includes('fatal')) {
      plainColor = 'text-rose-300';
    } else if (lower.includes('warn')) {
      plainColor = 'text-amber-300';
    }

    return `<div class="table-row leading-relaxed hover:bg-zinc-900/50 transition-colors">
      <span class="table-cell select-none text-zinc-600 pr-2.5 sm:pr-3 text-right text-[10px] w-8 sm:w-10 font-mono align-top py-1">${lineNum}</span>
      <span class="table-cell ${plainColor} break-all whitespace-pre-wrap font-mono align-top text-[11px] sm:text-xs py-1">${escapeHtml(cleanLine)}</span>
    </div>`;
  }

  // JSON Pino entry successfully parsed
  const {
    time,
    level,
    msg,
    message,
    pid,
    hostname,
    v,
    sessionId,
    ...restMeta
  } = parsed;

  const messageText = msg || message || (restMeta.err && restMeta.err.message) || (restMeta.error && restMeta.error.message) || '';
  const timeFormatted = formatLogTimestamp(time);
  const { lvlText, badgeClass } = getLogLevelBadgeInfo(level);

  // Filter out empty or internal meta properties
  const hasMeta = Object.keys(restMeta).length > 0;
  const metaSummary = hasMeta ? buildMetaSummary(restMeta) : '';
  const metaJsonString = hasMeta ? JSON.stringify(restMeta, null, 2) : '';

  return `
    <div class="table-row leading-relaxed hover:bg-zinc-900/60 transition-colors border-b border-zinc-900/30">
      <span class="table-cell select-none text-zinc-600 pr-2.5 sm:pr-3 text-right text-[10px] w-8 sm:w-10 font-mono align-top py-1.5">${lineNum}</span>
      <div class="table-cell py-1.5 pr-2 align-top space-y-1">
        
        <!-- Primary Row: Timestamp, Level Badge, Session ID & Message Text -->
        <div class="flex items-start sm:items-center gap-1.5 sm:gap-2 flex-wrap min-w-0">
          ${timeFormatted ? `<span class="text-[10px] text-zinc-500 font-mono flex-shrink-0 pt-0.5 sm:pt-0">${escapeHtml(timeFormatted)}</span>` : ''}
          <span class="px-1.5 py-0.2 rounded text-[9px] uppercase font-bold tracking-wider ${badgeClass} flex-shrink-0">
            ${escapeHtml(lvlText)}
          </span>
          ${sessionId ? `<span class="px-1.5 py-0.2 rounded bg-emerald-950/40 text-emerald-400 border border-emerald-800/40 text-[10px] font-mono select-all flex-shrink-0">[${escapeHtml(sessionId)}]</span>` : ''}
          <span class="text-zinc-200 text-xs font-mono break-all font-normal leading-relaxed flex-1">${escapeHtml(messageText)}</span>
        </div>

        <!-- Secondary Expandable/Dimmed Line for Metadata -->
        ${hasMeta ? `
          <div class="pl-0.5 pt-0.5">
            <details class="group">
              <summary class="text-[10px] text-zinc-400 hover:text-zinc-200 cursor-pointer flex items-center gap-1.5 font-mono select-none">
                <svg class="w-3 h-3 transition-transform group-open:rotate-90 text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>
                <span class="text-zinc-500 text-[10px]">Meta:</span>
                <span class="text-zinc-400 truncate max-w-[220px] min-[400px]:max-w-[300px] sm:max-w-xl font-mono">${escapeHtml(metaSummary)}</span>
              </summary>
              <div class="mt-1.5 p-2 rounded-lg bg-black/90 border border-zinc-900/90 text-[10px] text-cyan-300 overflow-x-auto font-mono whitespace-pre max-h-44 overflow-y-auto">${escapeHtml(metaJsonString)}</div>
            </details>
          </div>
        ` : ''}

      </div>
    </div>
  `;
}
