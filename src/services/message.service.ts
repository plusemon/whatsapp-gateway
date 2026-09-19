/**
 * Outbound Message Dispatcher Service
 * Implements anti-ban presence simulation (composing/recording, jitter delay, paused),
 * media payload streaming with buffer fallback, and strict lifecycle telemetry.
 */
import crypto from 'crypto';
import type { WASocket } from '@whiskeysockets/baileys';
import { normalizeJid } from '../utils/jid.util.js';
import { createSessionLogger } from '../utils/logger.js';
import type { OutboundMessageResult } from '../types/message.types.js';

export class MessageService {
  /**
   * Dispatches an outbound text message with anti-ban composing simulation and randomized delay.
   */
  public static async sendText(
    sessionId: string,
    sock: WASocket,
    jid: string,
    text: string,
    onLogged?: (type: 'outbound_message', sessionId: string, details: Record<string, any>) => void
  ): Promise<OutboundMessageResult> {
    const sessionLog = createSessionLogger(sessionId);
    const targetJid = normalizeJid(jid);

    // Step 1: Log Enqueued
    sessionLog.info(
      { jid: targetJid, textPreview: text.slice(0, 80), step: 'enqueued' },
      '[OutboundLifecycle] Outbound text message enqueued for dispatch'
    );

    // Step 2: Anti-ban guardrail - send typing presence
    await sock.sendPresenceUpdate('composing', targetJid);
    const delay = Math.floor(Math.random() * (1400 - 600 + 1)) + 600;

    sessionLog.info(
      { jid: targetJid, presence: 'composing', delayMs: delay, step: 'presence_sent' },
      `[OutboundLifecycle] Simulating typing presence (throttling for ${delay}ms)...`
    );

    await new Promise((resolve) => setTimeout(resolve, delay));

    // Step 3: Clear presence 'paused'
    await sock.sendPresenceUpdate('paused', targetJid);

    // Step 4: Dispatch message via Baileys socket
    const sendResult = await sock.sendMessage(targetJid, { text });
    const messageId = sendResult?.key?.id || crypto.randomUUID();
    const timestamp = Date.now();

    sessionLog.info(
      { jid: targetJid, messageId, delayMs: delay, step: 'dispatched' },
      '[OutboundLifecycle] Outbound text message successfully dispatched to WhatsApp socket'
    );

    if (onLogged) {
      onLogged('outbound_message', sessionId, {
        jid: targetJid,
        messageId,
        textPreview: text.slice(0, 80),
        simulatedDelayMs: delay,
      });
    }

    return {
      messageId,
      timestamp,
    };
  }

  /**
   * Dispatches an outbound media message (image, audio, or document) with human presence simulation.
   */
  public static async sendMedia(
    sessionId: string,
    sock: WASocket,
    jid: string,
    type: 'image' | 'audio' | 'document',
    url: string,
    options?: {
      caption?: string;
      filename?: string;
      ptt?: boolean;
    },
    onLogged?: (type: 'outbound_message', sessionId: string, details: Record<string, any>) => void
  ): Promise<OutboundMessageResult> {
    const sessionLog = createSessionLogger(sessionId);
    const targetJid = normalizeJid(jid);

    sessionLog.info(
      {
        jid: targetJid,
        type,
        url,
        ptt: options?.ptt,
        step: 'enqueued',
      },
      `[OutboundMedia] Media message (${type}) enqueued for dispatch`
    );

    // Anti-ban simulation: composing or recording presence
    const presenceType = type === 'audio' && options?.ptt ? 'recording' : 'composing';
    await sock.sendPresenceUpdate(presenceType, targetJid);

    const delay = Math.floor(Math.random() * (1400 - 600 + 1)) + 600;
    sessionLog.info(
      { jid: targetJid, presence: presenceType, delayMs: delay, step: 'presence_sent' },
      `[OutboundMedia] Simulated ${presenceType} presence sent, throttling ${delay}ms...`
    );

    await new Promise((resolve) => setTimeout(resolve, delay));
    await sock.sendPresenceUpdate('paused', targetJid);

    // Build media payload for Baileys
    let messagePayload: any = {};
    if (type === 'image') {
      messagePayload = {
        image: { url },
        caption: options?.caption || undefined,
      };
    } else if (type === 'audio') {
      messagePayload = {
        audio: { url },
        ptt: !!options?.ptt,
        mimetype: options?.ptt ? 'audio/ogg; codecs=opus' : 'audio/mp4',
      };
    } else if (type === 'document') {
      messagePayload = {
        document: { url },
        fileName: options?.filename || 'document.pdf',
        caption: options?.caption || undefined,
      };
    } else {
      throw new Error(`Unsupported media type: ${type}`);
    }

    let sendResult: any;
    try {
      sendResult = await sock.sendMessage(targetJid, messagePayload);
    } catch (directErr: any) {
      // Fallback: fetch media buffer directly and dispatch with Buffer
      sessionLog.warn(
        { type, url, err: directErr.message },
        '[OutboundMedia] Direct URL dispatch failed; fetching media buffer as fallback'
      );
      const fetchRes = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!fetchRes.ok) {
        throw new Error(`Failed to fetch media from URL (${fetchRes.status}: ${fetchRes.statusText})`);
      }
      const arrayBuffer = await fetchRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const fallbackMime = fetchRes.headers.get('content-type') || undefined;

      const fallbackPayload = {
        ...messagePayload,
        [type]: buffer,
        ...(fallbackMime ? { mimetype: fallbackMime } : {}),
      };
      sendResult = await sock.sendMessage(targetJid, fallbackPayload);
    }

    const messageId = sendResult?.key?.id || crypto.randomUUID();
    const timestamp = Date.now();

    sessionLog.info(
      { jid: targetJid, type, messageId, delayMs: delay, step: 'dispatched' },
      `[OutboundMedia] Media (${type}) dispatched successfully to WhatsApp socket`
    );

    if (onLogged) {
      onLogged('outbound_message', sessionId, {
        jid: targetJid,
        messageId,
        type,
        mediaUrl: url,
        caption: options?.caption,
        filename: options?.filename,
        ptt: options?.ptt,
        simulatedDelayMs: delay,
      });
    }

    return {
      messageId,
      timestamp,
    };
  }
}
