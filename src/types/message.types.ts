/**
 * Inbound & Outbound WhatsApp Message and Webhook Interfaces
 */
import type { proto } from '@whiskeysockets/baileys';

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
 * Detected media information extracted from a message proto.
 */
export interface MediaDetectedInfo {
  type: 'image' | 'audio' | 'document' | 'video';
  mimetype: string;
  caption: string | null;
  filename: string | null;
  fileLength: number;
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
 * Payload dispatched to the Botla Laravel webhook on message status ACK updates.
 */
export interface WebhookAckPayload {
  sessionId: string;
  event: 'message.ack';
  data: {
    messageId: string;
    remoteJid: string;
    status: number;
  };
}

/**
 * Combined webhook payloads supported by the gateway.
 */
export type WebhookPayload = WebhookInboundPayload | WebhookAckPayload;

/**
 * Result returned after dispatching an outbound message.
 */
export interface OutboundMessageResult {
  messageId: string;
  timestamp: number;
  status?: string;
}

/**
 * Standardized Botla REST API v1 Send Text Request Body
 */
export interface SendTextV1Body {
  sessionId: string;
  to: string;
  message: string;
  presence?: boolean;
  // Aliases for compatibility
  jid?: string;
  text?: string;
}

/**
 * Standardized Botla REST API v1 Send Media Request Body
 */
export interface SendMediaV1Body {
  sessionId: string;
  to: string;
  mediaUrl: string;
  mediaType: 'document' | 'image' | 'video' | 'audio';
  caption?: string;
  fileName?: string;
  // Aliases for compatibility
  jid?: string;
  url?: string;
  type?: 'document' | 'image' | 'video' | 'audio';
  filename?: string;
  ptt?: boolean;
}

/**
 * Standardized Botla Inbound Webhook Event Payload
 */
export interface StandardWebhookPayload<T = any> {
  event: 'message.inbound' | 'message.ack' | 'session.status' | string;
  sessionId: string;
  timestamp: string;
  data: T;
}

/**
 * Request payload for sending outbound text messages (legacy).
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
  type: 'image' | 'audio' | 'document' | 'video';
  url: string;
  caption?: string;
  filename?: string;
  ptt?: boolean;
}
