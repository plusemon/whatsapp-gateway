/**
 * Outbound Message Dispatcher Service
 * Implements anti-ban presence simulation (composing/recording, jitter delay, paused),
 * media payload streaming with buffer fallback, and strict lifecycle telemetry.
 */
import crypto from 'crypto';
import type { WASocket } from '@whiskeysockets/baileys';
import { DbService, MessageDirection, MessageStatus } from './db.service.js';
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
    onLogged?: (type: 'outbound_message', sessionId: string, details: Record<string, any>) => void,
    presence: boolean = true
  ): Promise<OutboundMessageResult> {
    const sessionLog = createSessionLogger(sessionId);
    const targetJid = normalizeJid(jid);
    const trackingId = `outbound-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    // Step 1: Log Enqueued and record in database
    sessionLog.info(
      { jid: targetJid, textPreview: text.slice(0, 80), step: 'enqueued' },
      '[OutboundLifecycle] Outbound text message enqueued for dispatch'
    );

    // Save initial ENQUEUED state to DB
    await DbService.createMessage({
      id: trackingId,
      sessionId,
      direction: MessageDirection.OUTBOUND,
      remoteJid: targetJid,
      text,
      hasMedia: false,
      status: MessageStatus.ENQUEUED,
    });

    let delay = 0;
    if (presence !== false) {
      // Step 2: Anti-ban guardrail - send typing presence
      await sock.sendPresenceUpdate('composing', targetJid);
      delay = Math.floor(Math.random() * (1400 - 600 + 1)) + 600;

      sessionLog.info(
        { jid: targetJid, presence: 'composing', delayMs: delay, step: 'presence_sent' },
        `[OutboundLifecycle] Simulating typing presence (throttling for ${delay}ms)...`
      );

      await new Promise((resolve) => setTimeout(resolve, delay));

      // Step 3: Clear presence 'paused'
      await sock.sendPresenceUpdate('paused', targetJid);
    }

    try {
      // Step 4: Dispatch message via Baileys socket
      const sendResult = await sock.sendMessage(targetJid, { text });
      const messageId = sendResult?.key?.id || trackingId;
      const timestamp = Date.now();

      // If Baileys assigned a new WhatsApp ID, persist under official message ID and remove temp tracking ID
      if (messageId !== trackingId) {
        await DbService.createMessage({
          id: messageId,
          sessionId,
          direction: MessageDirection.OUTBOUND,
          remoteJid: targetJid,
          text,
          hasMedia: false,
          status: MessageStatus.SERVER_ACK,
          statusRaw: 2,
        });
        // Clean up temporary tracking placeholder if distinct
        try {
          const prisma = DbService.prisma;
          await prisma.message.delete({ where: { id: trackingId } }).catch(() => {});
        } catch {
          // ignore
        }
      } else {
        await DbService.updateMessageStatus(trackingId, MessageStatus.SERVER_ACK, 2);
      }

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
        status: 'SERVER_ACK',
      };
    } catch (err: any) {
      // Mark as failed in DB
      await DbService.updateMessageStatus(trackingId, MessageStatus.FAILED);
      sessionLog.error({ jid: targetJid, err: err.message }, '[OutboundLifecycle] Failed to dispatch text message');
      throw err;
    }
  }

  /**
   * Dispatches an outbound media message (image, audio, document, or video) with human presence simulation.
   */
  public static async sendMedia(
    sessionId: string,
    sock: WASocket,
    jid: string,
    type: 'image' | 'audio' | 'document' | 'video',
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
    const trackingId = `outbound-media-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

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

    // Save initial ENQUEUED state to DB
    await DbService.createMessage({
      id: trackingId,
      sessionId,
      direction: MessageDirection.OUTBOUND,
      remoteJid: targetJid,
      text: options?.caption || options?.filename || null,
      hasMedia: true,
      mediaType: type,
      mediaUrl: url,
      status: MessageStatus.ENQUEUED,
    });

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
    } else if (type === 'video') {
      messagePayload = {
        video: { url },
        caption: options?.caption || undefined,
      };
    } else {
      throw new Error(`Unsupported media type: ${type}`);
    }

    let sendResult: any;
    try {
      sendResult = await sock.sendMessage(targetJid, messagePayload);
    } catch (directErr: any) {
      // Fallback: safely stream/fetch remote media buffer and dispatch via native Buffer without blocking event loop
      sessionLog.warn(
        { type, url, err: directErr.message },
        '[OutboundMedia] Direct URL dispatch failed; streaming remote media buffer as fallback'
      );
      try {
        const fetchRes = await fetch(url, { signal: AbortSignal.timeout(30000) });
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
      } catch (fallbackErr: any) {
        await DbService.updateMessageStatus(trackingId, MessageStatus.FAILED);
        throw fallbackErr;
      }
    }

    const messageId = sendResult?.key?.id || trackingId;
    const timestamp = Date.now();

    // If Baileys assigned official WhatsApp message ID, save and cleanup temp placeholder
    if (messageId !== trackingId) {
      await DbService.createMessage({
        id: messageId,
        sessionId,
        direction: MessageDirection.OUTBOUND,
        remoteJid: targetJid,
        text: options?.caption || options?.filename || null,
        hasMedia: true,
        mediaType: type,
        mediaUrl: url,
        status: MessageStatus.SERVER_ACK,
        statusRaw: 2,
      });
      try {
        const prisma = DbService.prisma;
        await prisma.message.delete({ where: { id: trackingId } }).catch(() => {});
      } catch {
        // ignore
      }
    } else {
      await DbService.updateMessageStatus(trackingId, MessageStatus.SERVER_ACK, 2);
    }

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
      status: 'SERVER_ACK',
    };
  }
}

