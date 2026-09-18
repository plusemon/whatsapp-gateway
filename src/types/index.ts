import type { proto } from '@whiskeysockets/baileys';

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
 * Inbound media metadata when an incoming WhatsApp message includes media attachments.
 */
export interface InboundMediaMetadata {
  url: string;
  mimetype: string;
  fileSize: number;
  caption?: string | null;
  type: 'image' | 'audio' | 'document' | 'video';
  filename?: string | null;
}

/**
 * Payload dispatched to the Botla Laravel webhook on inbound messages.
 */
export interface WebhookInboundPayload {
  sessionId: string;
  message: {
    key: proto.IMessageKey;
    pushName?: string | null;
    text: string;
    raw: proto.IWebMessageInfo;
    media?: InboundMediaMetadata | null;
  };
}

/**
 * Request payload for sending outbound messages.
 */
export interface SendMessageBody {
  jid: string;
  text: string;
}

/**
 * Request payload for requesting pairing code.
 */
export interface PairCodeBody {
  phoneNumber: string;
}

/**
 * Request payload for sending outbound media.
 */
export interface SendMediaBody {
  jid: string;
  type: 'image' | 'audio' | 'document';
  url: string;
  caption?: string;
  filename?: string;
  ptt?: boolean;
}

/**
 * Route parameter for session ID.
 */
export interface SessionParams {
  id: string;
}

/**
 * Standard API responses.
 */
export interface ApiInitResponse {
  success: boolean;
  sessionId: string;
  status: SessionStatus;
  message: string;
  qr?: string | null;
}

export interface ApiQrResponse {
  sessionId: string;
  qr: string | null;
  status: SessionStatus;
  qrDataUrl?: string | null;
  message?: string;
}

export interface ApiPairCodeResponse {
  success: boolean;
  sessionId: string;
  code: string | null;
  message: string;
}

export interface ApiSendResponse {
  success: boolean;
  sessionId: string;
  jid: string;
  messageId: string;
  timestamp: number;
}

export interface ApiSendMediaResponse {
  success: boolean;
  sessionId: string;
  jid: string;
  type: 'image' | 'audio' | 'document';
  messageId: string;
  timestamp: number;
  error?: string;
}

export interface ApiDeleteResponse {
  success: boolean;
  sessionId: string;
  message: string;
}
