/**
 * Session Lifecycle and Metadata Type Definitions
 */
import type { WAVersion } from '@whiskeysockets/baileys';

/**
 * Current connection lifecycle status for a tenant session.
 */
export type SessionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'qr_ready'
  | 'qr_expired'
  | 'disconnected'
  | 'logged_out';

/**
 * Metadata tracked for an active tenant session.
 */
export interface SessionMetadata {
  id: string;
  status: SessionStatus;
  qr: string | null;
  qrUpdatedAt: number | null;
  user: {
    id: string;
    name?: string;
  } | null;
  reconnectAttempts: number;
  createdAt: number;
  lastActiveAt: number;
}

/**
 * Summarized session representation for listing.
 */
export interface SessionSummary {
  id: string;
  status: SessionStatus;
  hasQr: boolean;
  user: {
    id: string;
    name?: string;
  } | null;
  createdAt: number;
  lastActiveAt: number;
}

/**
 * Observable recent event recorded by the gateway.
 */
export interface RecentEvent {
  id: string;
  timestamp: number;
  type:
    | 'inbound_message'
    | 'outbound_message'
    | 'message_ack'
    | 'webhook_dispatched'
    | 'webhook_failed'
    | 'session_event';
  sessionId: string;
  details: Record<string, any>;
}

/**
 * Protocol version information tracked by VersionGuard.
 */
export interface ProtocolVersionInfo {
  version: WAVersion;
  isLatest: boolean;
  source: 'memory' | 'redis' | 'remote' | 'fallback';
  fetchedAt: number;
}
