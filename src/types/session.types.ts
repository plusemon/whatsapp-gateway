/**
 * Session Lifecycle and Metadata Type Definitions
 */
import type { WASocket, WAVersion } from '@whiskeysockets/baileys';

/**
 * Authentication mode for the session socket lifecycle.
 */
export type AuthMode = 'qr' | 'pairing_code';

/**
 * Session Instance state tracking.
 */
export interface SessionInstance {
  sock: WASocket;
  authMode: AuthMode;
  phoneNumber?: string;
  isReconnecting?: boolean;
}

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
  authMode: AuthMode;
  qr: string | null;
  qrUpdatedAt: number | null;
  user: {
    id: string;
    name?: string;
  } | null;
  reconnectAttempts: number;
  createdAt: number;
  lastActiveAt: number;
  sock?: WASocket;
}

/**
 * Summarized session representation for listing.
 */
export interface SessionSummary {
  id: string;
  status: SessionStatus;
  authMode: AuthMode;
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
