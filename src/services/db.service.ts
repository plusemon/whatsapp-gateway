/**
 * Prisma Relational Database Persistence Service
 * Manages persistent storage for Sessions, Messages, and Webhook Audit Logs.
 * Includes dual-mode resilient in-memory fallback cache when PostgreSQL is not connected.
 */
import {
  PrismaClient,
  SessionStatus,
  MessageDirection,
  MessageStatus,
} from '@prisma/client';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { createPrismaMock } from './prismaMock.js';

let prismaInstance: PrismaClient | null = null;
let isConnected = false;
let isDbConfigured = false;

// In-memory fallback caches for resilience
const memSessions = new Map<string, any>();
const memMessages = new Map<string, any>(); // keyed by messageId
const memWebhookLogs: any[] = [];

/**
 * Returns or initializes the global singleton PrismaClient instance.
 */
export function getPrismaClient(): PrismaClient {
  if (!prismaInstance) {
    isDbConfigured = Boolean(process.env.DATABASE_URL || config.databaseUrl);

    if (!process.env.DATABASE_URL && config.databaseUrl) {
      process.env.DATABASE_URL = config.databaseUrl;
    }

    if (isDbConfigured) {
      // Set log to empty array to prevent Prisma from dumping unformatted errors to stderr
      prismaInstance = new PrismaClient({
        log: [],
      });

      prismaInstance
        .$connect()
        .then(() => {
          isConnected = true;
          logger.info('[DbService] Successfully connected to relational database via Prisma ORM');
        })
        .catch((err: any) => {
          isConnected = false;
          logger.debug(
            { err: err.message },
            '[DbService] Database not immediately reachable; running in dual resilient in-memory fallback mode'
          );
        });
    } else {
      prismaInstance = createPrismaMock();
      logger.info(
        '[DbService] DATABASE_URL not set; running with resilient in-memory persistence and Prisma integration ready'
      );
    }
  }

  return prismaInstance;
}

export class DbService {
  public static get prisma(): PrismaClient {
    return getPrismaClient();
  }

  public static setPrismaClient(client: PrismaClient | null) {
    prismaInstance = client;
    if (client) {
      isConnected = true;
      isDbConfigured = true;
    }
  }

  /**
   * Helper to determine if DB is currently connected.
   */
  public static isConnected(): boolean {
    return isConnected;
  }

  /**
   * Upserts or creates a Session registry record in the database.
   */
  public static async upsertSession(
    sessionId: string,
    data: {
      status?: SessionStatus;
      authMode?: string;
      phoneNumber?: string | null;
      pushName?: string | null;
      lastActiveAt?: Date;
    }
  ) {
    // 1. Update in-memory fallback cache
    const existing = memSessions.get(sessionId) || {
      id: sessionId,
      status: SessionStatus.QR_READY,
      authMode: 'qr',
      phoneNumber: null,
      pushName: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const updatedMem = {
      ...existing,
      status: data.status || existing.status,
      authMode: data.authMode || existing.authMode,
      phoneNumber: data.phoneNumber !== undefined ? data.phoneNumber : existing.phoneNumber,
      pushName: data.pushName !== undefined ? data.pushName : existing.pushName,
      lastActiveAt: data.lastActiveAt || new Date(),
      updatedAt: new Date(),
    };
    memSessions.set(sessionId, updatedMem);

    // 2. Persist to DB if configured
    try {
      const prisma = this.prisma;
      return await prisma.session.upsert({
        where: { id: sessionId },
        create: {
          id: sessionId,
          status: data.status || SessionStatus.QR_READY,
          authMode: data.authMode || 'qr',
          phoneNumber: data.phoneNumber || null,
          pushName: data.pushName || null,
          lastActiveAt: data.lastActiveAt || new Date(),
        },
        update: {
          ...(data.status ? { status: data.status } : {}),
          ...(data.authMode ? { authMode: data.authMode } : {}),
          ...(data.phoneNumber !== undefined ? { phoneNumber: data.phoneNumber } : {}),
          ...(data.pushName !== undefined ? { pushName: data.pushName } : {}),
          lastActiveAt: data.lastActiveAt || new Date(),
        },
      });
    } catch (err: any) {
      logger.debug(
        { sessionId, err: err.message },
        '[DbService] Session record persisted to in-memory fallback'
      );
      return updatedMem;
    }
  }

  /**
   * Updates session status and associated profile info.
   */
  public static async updateSessionStatus(
    sessionId: string,
    status: SessionStatus,
    extra?: {
      phoneNumber?: string | null;
      pushName?: string | null;
      lastActiveAt?: Date;
    }
  ) {
    return await this.upsertSession(sessionId, {
      status,
      phoneNumber: extra?.phoneNumber,
      pushName: extra?.pushName,
      lastActiveAt: extra?.lastActiveAt,
    });
  }

  /**
   * Deletes session and cascades associated message records.
   */
  public static async deleteSession(sessionId: string) {
    memSessions.delete(sessionId);
    for (const [msgId, msg] of memMessages.entries()) {
      if (msg.sessionId === sessionId) {
        memMessages.delete(msgId);
      }
    }

    try {
      const prisma = this.prisma;
      return await prisma.session.delete({
        where: { id: sessionId },
      });
    } catch (err: any) {
      logger.debug(
        { sessionId, err: err.message },
        '[DbService] Session purged from in-memory store'
      );
      return null;
    }
  }

  /**
   * Retrieves a single session record by ID.
   */
  public static async getSession(sessionId: string) {
    try {
      const prisma = this.prisma;
      const dbRecord = await prisma.session.findUnique({
        where: { id: sessionId },
      });
      if (dbRecord) return dbRecord;
    } catch (err: any) {
      logger.debug({ sessionId, err: err.message }, '[DbService] Querying session from fallback');
    }
    return memSessions.get(sessionId) || null;
  }

  /**
   * Records a new message in the database.
   */
  public static async createMessage(data: {
    id: string;
    sessionId: string;
    direction: MessageDirection;
    remoteJid: string;
    lidJid?: string | null;
    text?: string | null;
    hasMedia?: boolean;
    mediaType?: string | null;
    mediaUrl?: string | null;
    status?: MessageStatus;
    statusRaw?: number | null;
  }) {
    // 1. Update in-memory fallback
    const memMsg = {
      id: data.id,
      sessionId: data.sessionId,
      direction: data.direction,
      remoteJid: data.remoteJid,
      lidJid: data.lidJid || null,
      text: data.text || null,
      hasMedia: data.hasMedia || false,
      mediaType: data.mediaType || null,
      mediaUrl: data.mediaUrl || null,
      status: data.status || MessageStatus.ENQUEUED,
      statusRaw: data.statusRaw !== undefined ? data.statusRaw : null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    memMessages.set(data.id, memMsg);

    // Ensure session in memory is updated
    await this.upsertSession(data.sessionId, { lastActiveAt: new Date() });

    // 2. Persist to DB if connected
    try {
      const prisma = this.prisma;
      return await prisma.message.upsert({
        where: { id: data.id },
        create: {
          id: data.id,
          sessionId: data.sessionId,
          direction: data.direction,
          remoteJid: data.remoteJid,
          lidJid: data.lidJid || null,
          text: data.text || null,
          hasMedia: data.hasMedia || false,
          mediaType: data.mediaType || null,
          mediaUrl: data.mediaUrl || null,
          status: data.status || MessageStatus.ENQUEUED,
          statusRaw: data.statusRaw !== undefined ? data.statusRaw : null,
        },
        update: {
          ...(data.text ? { text: data.text } : {}),
          ...(data.hasMedia !== undefined ? { hasMedia: data.hasMedia } : {}),
          ...(data.mediaType !== undefined ? { mediaType: data.mediaType } : {}),
          ...(data.mediaUrl !== undefined ? { mediaUrl: data.mediaUrl } : {}),
          ...(data.status ? { status: data.status } : {}),
          ...(data.statusRaw !== undefined ? { statusRaw: data.statusRaw } : {}),
        },
      });
    } catch (err: any) {
      logger.debug(
        { messageId: data.id, err: err.message },
        '[DbService] Message record stored in fallback cache'
      );
      return memMsg;
    }
  }

  /**
   * Updates message delivery and read status.
   */
  public static async updateMessageStatus(
    messageId: string,
    status: MessageStatus,
    statusRaw?: number | null
  ) {
    const existing = memMessages.get(messageId);
    if (existing) {
      existing.status = status;
      if (statusRaw !== undefined) existing.statusRaw = statusRaw;
      existing.updatedAt = new Date();
      memMessages.set(messageId, existing);
    }

    try {
      const prisma = this.prisma;
      return await prisma.message.update({
        where: { id: messageId },
        data: {
          status,
          ...(statusRaw !== undefined ? { statusRaw } : {}),
        },
      });
    } catch (err: any) {
      logger.debug(
        { messageId, status, err: err.message },
        '[DbService] Message status updated in fallback cache'
      );
      return existing || null;
    }
  }

  /**
   * Retrieves a single message by ID.
   */
  public static async getMessage(messageId: string) {
    try {
      const prisma = this.prisma;
      const record = await prisma.message.findUnique({
        where: { id: messageId },
        include: {
          session: true,
        },
      });
      if (record) return record;
    } catch (err: any) {
      logger.debug({ messageId, err: err.message }, '[DbService] Falling back to in-memory message store');
    }

    const fallback = memMessages.get(messageId);
    if (fallback) {
      const session = memSessions.get(fallback.sessionId);
      return { ...fallback, session: session || null };
    }
    return null;
  }

  /**
   * Lists historical messages for a session with pagination and filtering.
   */
  public static async listSessionMessages(
    sessionId: string,
    options?: {
      direction?: MessageDirection;
      remoteJid?: string;
      limit?: number;
      offset?: number;
    }
  ) {
    const limit = Math.min(Math.max(Number(options?.limit) || 50, 1), 200);
    const offset = Math.max(Number(options?.offset) || 0, 0);

    try {
      const prisma = this.prisma;
      const where: any = { sessionId };
      if (options?.direction) where.direction = options.direction;
      if (options?.remoteJid) where.remoteJid = options.remoteJid;

      const [total, messages] = await Promise.all([
        prisma.message.count({ where }),
        prisma.message.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
      ]);

      return { total, limit, offset, messages };
    } catch (err: any) {
      logger.debug(
        { sessionId, err: err.message },
        '[DbService] Serving messages from in-memory fallback cache'
      );

      // In-memory filter and sort
      let filtered = Array.from(memMessages.values()).filter((m) => m.sessionId === sessionId);
      if (options?.direction) {
        filtered = filtered.filter((m) => m.direction === options.direction);
      }
      if (options?.remoteJid) {
        filtered = filtered.filter((m) => m.remoteJid === options.remoteJid);
      }

      filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      const total = filtered.length;
      const paginated = filtered.slice(offset, offset + limit);

      return {
        total,
        limit,
        offset,
        messages: paginated,
      };
    }
  }

  /**
   * Logs a webhook delivery dispatch event to the database.
   */
  public static async createWebhookLog(data: {
    sessionId: string;
    event: string;
    payload: any;
    statusCode?: number | null;
    attempts?: number;
    success?: boolean;
    error?: string | null;
  }) {
    const memLog = {
      id: `wh-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      sessionId: data.sessionId,
      event: data.event,
      payload: data.payload,
      statusCode: data.statusCode ?? null,
      attempts: data.attempts ?? 1,
      success: data.success ?? false,
      error: data.error ?? null,
      createdAt: new Date(),
    };
    memWebhookLogs.push(memLog);
    if (memWebhookLogs.length > 500) memWebhookLogs.shift();

    try {
      const prisma = this.prisma;
      return await prisma.webhookLog.create({
        data: {
          sessionId: data.sessionId,
          event: data.event,
          payload: data.payload,
          statusCode: data.statusCode ?? null,
          attempts: data.attempts ?? 1,
          success: data.success ?? false,
          error: data.error ?? null,
        },
      });
    } catch (err: any) {
      logger.debug({ event: data.event, err: err.message }, '[DbService] WebhookLog stored in fallback');
      return memLog;
    }
  }

  /**
   * Gracefully disconnects Prisma client on application shutdown.
   */
  public static async disconnect() {
    if (prismaInstance) {
      try {
        await prismaInstance.$disconnect();
        isConnected = false;
        logger.info('[DbService] Disconnected Prisma Client');
      } catch (err: any) {
        logger.warn({ err: err.message }, '[DbService] Error disconnecting Prisma');
      }
    }
  }
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = DbService.prisma;
    const val = (client as any)[prop];
    if (typeof val === 'function') {
      return val.bind(client);
    }
    return val;
  },
});

export { SessionStatus, MessageDirection, MessageStatus, createPrismaMock };
