import { sessionService } from '../services/session.service.js';
import { prisma, MessageStatus, MessageDirection } from '../services/db.service.js';
import { normalizeJid } from '../utils/jid.util.js';
import { createSessionLogger, logger } from '../utils/logger.js';
import type { OutboundMessageJob } from './message.queue.js';
import { Worker, Job } from 'bullmq';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface OutboundJobPayload {
  id: string;
  attemptsMade: number;
  data: OutboundMessageJob;
}

export const processOutboundJob = async (job: OutboundJobPayload | Job<OutboundMessageJob>) => {
  const { sessionId, to, type, message, mediaUrl, mediaType, caption, fileName, presence } = job.data;
  const session = sessionService.getSession(sessionId);

  if (!session || !session.sock || session.status !== 'connected') {
    throw new Error(`Session [${sessionId}] is not connected or socket is unavailable`);
  }

  const sessionLog = createSessionLogger(sessionId);
  const targetJid = normalizeJid(to);

  // 1. Anti-Ban Jitter: Random typing duration (800ms - 2500ms)
  const isTest = process.env.NODE_ENV === 'test' || !!process.env.VITEST;
  const jitterMs = isTest ? 10 : Math.floor(Math.random() * (2500 - 800 + 1)) + 800;

  sessionLog.info(
    { jobId: job.id, to: targetJid, type, attempt: (job.attemptsMade || 0) + 1 },
    '[MessageWorker] Processing queued outbound message job'
  );

  if (presence !== false) {
    await session.sock.sendPresenceUpdate(
      type === 'media' && mediaType === 'audio' ? 'recording' : 'composing',
      targetJid
    );
    await delay(jitterMs);
  }

  // 2. Dispatch via Baileys Socket
  let sentResult: any;

  if (type === 'text' && message) {
    sentResult = await session.sock.sendMessage(targetJid, { text: message });
  } else if (type === 'media' && mediaUrl) {
    // Dispatch media with native Baileys options
    let mediaPayload: any = {};
    if (mediaType === 'image') {
      mediaPayload = {
        image: { url: mediaUrl },
        caption: caption || undefined,
      };
    } else if (mediaType === 'audio') {
      mediaPayload = {
        audio: { url: mediaUrl },
        mimetype: 'audio/mp4',
      };
    } else if (mediaType === 'document') {
      mediaPayload = {
        document: { url: mediaUrl },
        fileName: fileName || 'document.pdf',
        caption: caption || undefined,
      };
    } else if (mediaType === 'video') {
      mediaPayload = {
        video: { url: mediaUrl },
        caption: caption || undefined,
      };
    } else {
      mediaPayload = {
        [mediaType || 'image']: { url: mediaUrl },
        caption: caption || undefined,
        fileName: fileName || undefined,
      };
    }

    try {
      sentResult = await session.sock.sendMessage(targetJid, mediaPayload);
    } catch (directErr: any) {
      sessionLog.warn(
        { type: mediaType, url: mediaUrl, err: directErr.message },
        '[MessageWorker] Direct URL dispatch failed; streaming buffer fallback'
      );
      const fetchRes = await fetch(mediaUrl, { signal: AbortSignal.timeout(30000) });
      if (!fetchRes.ok) {
        throw new Error(`Failed to fetch media from URL (${fetchRes.status}: ${fetchRes.statusText})`);
      }
      const arrayBuffer = await fetchRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const fallbackMime = fetchRes.headers.get('content-type') || undefined;

      const fallbackPayload = {
        ...mediaPayload,
        [mediaType || 'image']: buffer,
        ...(fallbackMime ? { mimetype: fallbackMime } : {}),
      };
      sentResult = await session.sock.sendMessage(targetJid, fallbackPayload);
    }
  }

  // 3. Clear presence
  if (presence !== false) {
    await session.sock.sendPresenceUpdate('paused', targetJid);
  }

  // 4. Update Database Record to SERVER_ACK
  if (sentResult?.key?.id) {
    await prisma.message.upsert({
      where: { id: sentResult.key.id },
      create: {
        id: sentResult.key.id,
        sessionId,
        direction: MessageDirection.OUTBOUND,
        remoteJid: targetJid,
        text: message || caption || fileName || null,
        hasMedia: type === 'media',
        mediaType: type === 'media' ? mediaType || null : null,
        mediaUrl: type === 'media' ? mediaUrl || null : null,
        status: MessageStatus.SERVER_ACK,
        statusRaw: 2,
      },
      update: {
        status: MessageStatus.SERVER_ACK,
        statusRaw: 2,
      },
    });

    sessionLog.info(
      { jobId: job.id, messageId: sentResult.key.id, to: targetJid },
      '[MessageWorker] Message successfully dispatched and persisted'
    );

    sessionService.logEvent('outbound_message', sessionId, {
      jobId: job.id,
      messageId: sentResult.key.id,
      jid: targetJid,
      type,
      simulatedDelayMs: jitterMs,
    });
  }

  // Cool-down delay between consecutive queue jobs to prevent burst rate-limits
  if (!isTest) {
    await delay(1000);
  }

  return { messageId: sentResult?.key?.id, status: 'SERVER_ACK' };
};

let activeWorker: Worker<OutboundMessageJob> | null = null;

export const initMessageWorker = (connection: any) => {
  if (activeWorker) {
    return activeWorker;
  }

  try {
    activeWorker = new Worker<OutboundMessageJob>(
      'outbound_messages',
      async (job: Job<OutboundMessageJob>) => {
        return processOutboundJob(job);
      },
      {
        connection,
        concurrency: 2,
      }
    );

    activeWorker.on('failed', (job, err) => {
      logger.error(
        { jobId: job?.id, sessionId: job?.data?.sessionId, err: err.message },
        '[MessageWorker] Outbound message job failed'
      );
    });

    activeWorker.on('completed', (job) => {
      logger.info(
        { jobId: job.id, sessionId: job.data.sessionId },
        '[MessageWorker] Outbound message job completed successfully'
      );
    });
  } catch (err: any) {
    logger.debug({ err: err.message }, '[MessageWorker] BullMQ worker initialization handled');
  }

  return activeWorker;
};

export const closeMessageWorker = async () => {
  if (activeWorker) {
    try {
      await activeWorker.close();
      activeWorker = null;
    } catch {
      // ignore
    }
  }
};
