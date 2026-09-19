/**
 * Standard API Request & Response Contracts
 */
import type { SessionStatus } from './session.types.js';

/**
 * Route parameter for session ID.
 */
export interface SessionParams {
  id: string;
}

/**
 * Standard unified JSON API response envelope.
 */
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

/**
 * Response payload for POST /api/sessions/:id/init
 */
export interface ApiInitResponse {
  success: boolean;
  sessionId: string;
  status: SessionStatus;
  message: string;
  qr?: string | null;
}

/**
 * Response payload for GET /api/sessions/:id/qr
 */
export interface ApiQrResponse {
  sessionId: string;
  qr: string | null;
  status: SessionStatus;
  qrDataUrl?: string | null;
  message?: string;
}

/**
 * Response payload for POST /api/sessions/:id/pair-code
 */
export interface ApiPairCodeResponse {
  success: boolean;
  sessionId: string;
  code: string | null;
  message: string;
}

/**
 * Response payload for POST /api/sessions/:id/send
 */
export interface ApiSendResponse {
  success: boolean;
  sessionId: string;
  jid: string;
  messageId: string;
  timestamp: number;
}

/**
 * Response payload for POST /api/sessions/:id/send-media
 */
export interface ApiSendMediaResponse {
  success: boolean;
  sessionId: string;
  jid: string;
  type: 'image' | 'audio' | 'document';
  messageId: string;
  timestamp: number;
  error?: string;
}

/**
 * Response payload for DELETE /api/sessions/:id
 */
export interface ApiDeleteResponse {
  success: boolean;
  sessionId: string;
  message: string;
}

/**
 * Result of an automated or manual media storage cleanup run.
 */
export interface MediaCleanupResult {
  success: boolean;
  deletedFilesCount: number;
  prunedDirsCount: number;
  freedBytes: number;
  freedBytesFormatted: string;
  retentionHours: number;
  timestamp: string;
}

/**
 * Real-time structured log event streamed to clients and stored in log files.
 */
export interface StreamLogEvent {
  id: string;
  timestamp: string;
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  sessionId?: string;
  message: string;
  meta?: Record<string, any>;
}

/**
 * Result of log file retention pruning.
 */
export interface LogCleanupResult {
  success: boolean;
  deletedFilesCount: number;
  freedBytes: number;
  freedBytesFormatted: string;
  retentionDays: number;
  timestamp: string;
}

/**
 * Response for GET /api/logs/view
 */
export interface LogViewResponse {
  filename: string;
  lines: number;
  content: string;
  totalSizeBytes?: number;
  sizeBytes?: number;
  sizeFormatted?: string;
  modifiedAt?: string;
  data?: {
    filename: string;
    lines: number;
    content: string;
    totalSizeBytes?: number;
    sizeBytes?: number;
    sizeFormatted?: string;
    modifiedAt?: string;
  };
}

/**
 * Payload for POST /api/logs/clear
 */
export interface LogClearRequest {
  file: string;
}

/**
 * Response for POST /api/logs/clear
 */
export interface LogClearResponse {
  file: string;
  clearedFiles: string[];
  freedBytes: number;
  freedBytesFormatted: string;
  message: string;
  timestamp: string;
}

/**
 * Individual log file descriptor.
 */
export interface LogFileEntry {
  name: string;
  sizeBytes: number;
  sizeFormatted: string;
  modifiedAt: string;
  ageDays: number;
}

/**
 * Response for GET /api/logs/files
 */
export interface LogFilesResponse {
  files: LogFileEntry[];
  totalSizeBytes: number;
  totalSizeFormatted: string;
  directory: string;
}
