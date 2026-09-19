import EventEmitter from 'events';
import fs from 'fs';
import path from 'path';
import pino, { DestinationStream, Level, Logger } from 'pino';
import type { StreamLogEvent } from '../types/index.js';

// Ensure storage/logs directory exists
const LOGS_DIR = path.resolve(process.cwd(), 'storage/logs');
if (!fs.existsSync(LOGS_DIR)) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  } catch {
    // Ignore error
  }
}

// In-memory circular log event buffer for instant frontend SSE hydration
const MAX_RECENT_LOGS = 250;
const recentLogs: StreamLogEvent[] = [];

// Lightweight EventEmitter for SSE and pub/sub log streaming
class LogEventEmitter extends EventEmitter {}
export const logEmitter = new LogEventEmitter();
logEmitter.setMaxListeners(100);

/**
 * Pushes a structured log event to the in-memory buffer and broadcasts to listeners.
 */
function recordAndBroadcast(logEvent: StreamLogEvent): void {
  recentLogs.unshift(logEvent);
  if (recentLogs.length > MAX_RECENT_LOGS) {
    recentLogs.pop();
  }
  logEmitter.emit('log', logEvent);
}

/**
 * Returns the active ISO date string formatted for daily log files (YYYY-MM-DD).
 */
function getTodayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

// Keep active write streams
let combinedStream: fs.WriteStream | null = null;
let errorStream: fs.WriteStream | null = null;
let dailyStream: fs.WriteStream | null = null;
let currentDailyDate = '';

function getFileStreams() {
  const today = getTodayDateString();

  if (!combinedStream || combinedStream.closed || combinedStream.destroyed) {
    combinedStream = fs.createWriteStream(path.join(LOGS_DIR, 'combined.log'), { flags: 'a' });
  }
  if (!errorStream || errorStream.closed || errorStream.destroyed) {
    errorStream = fs.createWriteStream(path.join(LOGS_DIR, 'error.log'), { flags: 'a' });
  }
  if (!dailyStream || dailyStream.closed || dailyStream.destroyed || currentDailyDate !== today) {
    currentDailyDate = today;
    dailyStream = fs.createWriteStream(path.join(LOGS_DIR, `gateway-${today}.log`), { flags: 'a' });
  }

  return { combined: combinedStream, error: errorStream, daily: dailyStream };
}

/**
 * ANSI Color Helpers for clean local terminal output without requiring heavy external dependencies.
 */
const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  bold: '\x1b[1m',
};

function formatLevel(level: string): string {
  switch (level.toLowerCase()) {
    case 'error':
    case 'fatal':
      return `${colors.red}${colors.bold}[${level.toUpperCase()}]${colors.reset}`;
    case 'warn':
      return `${colors.yellow}${colors.bold}[WARN]${colors.reset}`;
    case 'info':
      return `${colors.green}[INFO]${colors.reset}`;
    case 'debug':
      return `${colors.blue}[DEBUG]${colors.reset}`;
    case 'trace':
      return `${colors.dim}[TRACE]${colors.reset}`;
    default:
      return `[${level.toUpperCase()}]`;
  }
}

/**
 * Custom Multi-Stream Dispatcher for Pino.
 * Emits to terminal (pretty stdout), log files (combined, error, daily), and SSE event bus.
 */
const customLogStream: DestinationStream = {
  write(chunk: string) {
    try {
      const parsed = JSON.parse(chunk);
      const timeStr = typeof parsed.time === 'number'
        ? new Date(parsed.time).toISOString()
        : (parsed.time || new Date().toISOString());

      // Level number to label mapping
      let levelLabel = 'info';
      if (parsed.level === 10) levelLabel = 'trace';
      else if (parsed.level === 20) levelLabel = 'debug';
      else if (parsed.level === 30) levelLabel = 'info';
      else if (parsed.level === 40) levelLabel = 'warn';
      else if (parsed.level === 50) levelLabel = 'error';
      else if (parsed.level === 60) levelLabel = 'fatal';
      else if (typeof parsed.level === 'string') levelLabel = parsed.level;

      const message = parsed.msg || '';
      const sessionId = parsed.sessionId || undefined;

      // Extract metadata attributes excluding standard pino fields
      const {
        level: _l,
        time: _t,
        pid: _p,
        hostname: _h,
        msg: _m,
        ...restMeta
      } = parsed;

      const meta = Object.keys(restMeta).length > 0 ? restMeta : undefined;

      const logEvent: StreamLogEvent = {
        id: Math.random().toString(36).substring(2, 11) + Date.now().toString(36),
        timestamp: timeStr,
        level: levelLabel as any,
        sessionId,
        message,
        meta,
      };

      // 1. Broadcast to SSE Live Stream Bus & Buffer
      recordAndBroadcast(logEvent);

      // 2. Write to Rotating File Logs
      const rawLine = JSON.stringify(parsed) + '\n';
      const streams = getFileStreams();
      if (streams.combined) streams.combined.write(rawLine);
      if (streams.daily) streams.daily.write(rawLine);
      if (levelLabel === 'error' || levelLabel === 'fatal') {
        if (streams.error) streams.error.write(rawLine);
      }

      // 3. Pretty Terminal Output to stdout
      const timeFormatted = timeStr.split('T')[1]?.replace('Z', '') || timeStr;
      const sessionTag = sessionId ? `${colors.cyan}[${sessionId}]${colors.reset} ` : '';
      const metaFormatted = meta ? ` ${colors.dim}${JSON.stringify(meta)}${colors.reset}` : '';

      const terminalLine = `${colors.dim}${timeFormatted}${colors.reset} ${formatLevel(levelLabel)} ${sessionTag}${message}${metaFormatted}\n`;
      process.stdout.write(terminalLine);

    } catch {
      // Fallback if raw text
      process.stdout.write(chunk);
    }
  },
};

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

/**
 * Root Centralized Pino Logger instance with custom multi-destination streaming.
 */
export const logger: Logger = pino(
  {
    level: LOG_LEVEL,
    timestamp: pino.stdTimeFunctions.isoTime,
    base: undefined, // Remove pid and hostname for cleaner payloads
  },
  customLogStream
);

/**
 * Child Logger Factory.
 * Binds { sessionId } to every log entry for instant multi-tenant isolation.
 *
 * @param sessionId The tenant/session ID identifier
 */
export function createSessionLogger(sessionId: string): Logger {
  return logger.child({ sessionId });
}

/**
 * Returns recent logs from the in-memory circular buffer.
 */
export function getRecentLogs(limit = 100): StreamLogEvent[] {
  return recentLogs.slice(0, limit);
}

/**
 * Subscribes a listener function to real-time log events.
 * Returns an unsubscribe callback function.
 */
export function subscribeLogStream(listener: (event: StreamLogEvent) => void): () => void {
  logEmitter.on('log', listener);
  return () => {
    logEmitter.off('log', listener);
  };
}

/**
 * Directly logs a structured system or gateway event.
 */
export function logGatewayEvent(
  level: 'info' | 'warn' | 'error' | 'debug',
  message: string,
  sessionId?: string,
  meta?: Record<string, any>
): void {
  const targetLogger = sessionId ? createSessionLogger(sessionId) : logger;
  if (meta) {
    (targetLogger as any)[level](meta, message);
  } else {
    (targetLogger as any)[level](message);
  }
}
