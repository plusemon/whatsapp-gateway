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
}

/**
 * Request payload for sending outbound text messages.
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
