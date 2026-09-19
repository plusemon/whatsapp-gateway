import {
  SessionStatus,
  MessageDirection,
  MessageStatus,
  PrismaClient,
} from '@prisma/client';

export interface MockSessionRecord {
  id: string;
  phoneNumber: string | null;
  pushName: string | null;
  status: SessionStatus;
  authMode: string;
  lastActiveAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface MockMessageRecord {
  id: string;
  sessionId: string;
  direction: MessageDirection;
  remoteJid: string;
  lidJid: string | null;
  text: string | null;
  hasMedia: boolean;
  mediaType: string | null;
  mediaUrl: string | null;
  status: MessageStatus;
  statusRaw: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MockWebhookLogRecord {
  id: string;
  sessionId: string;
  event: string;
  payload: any;
  statusCode: number | null;
  attempts: number;
  success: boolean;
  error: string | null;
  createdAt: Date;
}

/**
 * Creates an in-memory mock PrismaClient conforming to the schema.
 * Handles relational cascade deletes, unique constraint enforcement, ordering, and pagination.
 */
export function createPrismaMock(): PrismaClient {
  const sessions = new Map<string, MockSessionRecord>();
  const messages = new Map<string, MockMessageRecord>();
  const webhookLogs: MockWebhookLogRecord[] = [];

  const mock = {
    session: {
      create: async (args: { data: any; include?: { messages?: boolean } }) => {
        const { data, include } = args;
        if (sessions.has(data.id)) {
          throw new Error(`Unique constraint failed on the fields: (\`id\`) - Session '${data.id}' already exists.`);
        }

        const now = new Date();
        const record: MockSessionRecord = {
          id: data.id,
          phoneNumber: data.phoneNumber ?? null,
          pushName: data.pushName ?? null,
          status: data.status ?? SessionStatus.QR_READY,
          authMode: data.authMode ?? 'qr',
          lastActiveAt: data.lastActiveAt ?? now,
          createdAt: data.createdAt ?? now,
          updatedAt: data.updatedAt ?? now,
        };

        sessions.set(record.id, record);

        // Handle nested message creations if specified
        const createdMessages: MockMessageRecord[] = [];
        if (data.messages?.create && Array.isArray(data.messages.create)) {
          for (const msgData of data.messages.create) {
            const msgNow = new Date();
            const msgRecord: MockMessageRecord = {
              id: msgData.id,
              sessionId: record.id,
              direction: msgData.direction,
              remoteJid: msgData.remoteJid,
              lidJid: msgData.lidJid ?? null,
              text: msgData.text ?? null,
              hasMedia: msgData.hasMedia ?? false,
              mediaType: msgData.mediaType ?? null,
              mediaUrl: msgData.mediaUrl ?? null,
              status: msgData.status ?? MessageStatus.ENQUEUED,
              statusRaw: msgData.statusRaw ?? null,
              createdAt: msgData.createdAt ?? msgNow,
              updatedAt: msgData.updatedAt ?? msgNow,
            };
            messages.set(msgRecord.id, msgRecord);
            createdMessages.push(msgRecord);
          }
        }

        if (include?.messages) {
          return { ...record, messages: createdMessages };
        }

        return { ...record };
      },

      upsert: async (args: { where: { id: string }; create: any; update: any; include?: { messages?: boolean } }) => {
        const { where, create, update, include } = args;
        const existing = sessions.get(where.id);

        if (existing) {
          const now = new Date();
          const updated: MockSessionRecord = {
            ...existing,
            ...update,
            updatedAt: now,
          };
          sessions.set(where.id, updated);
          return { ...updated };
        } else {
          return await mock.session.create({ data: { ...create, id: where.id }, include });
        }
      },

      update: async (args: { where: { id: string }; data: any; include?: { messages?: boolean } }) => {
        const { where, data, include } = args;
        const existing = sessions.get(where.id);
        if (!existing) {
          throw new Error(`Record to update not found. Session '${where.id}' does not exist.`);
        }

        const now = new Date();
        const updated: MockSessionRecord = {
          ...existing,
          ...data,
          updatedAt: now,
        };
        sessions.set(where.id, updated);

        if (include?.messages) {
          const sessionMsgs = Array.from(messages.values()).filter((m) => m.sessionId === where.id);
          return { ...updated, messages: sessionMsgs };
        }

        return { ...updated };
      },

      delete: async (args: { where: { id: string } }) => {
        const { where } = args;
        const existing = sessions.get(where.id);
        if (!existing) {
          throw new Error(`Record to delete not found. Session '${where.id}' does not exist.`);
        }

        // Cascade delete all associated messages
        for (const [msgId, msg] of messages.entries()) {
          if (msg.sessionId === where.id) {
            messages.delete(msgId);
          }
        }

        sessions.delete(where.id);
        return { ...existing };
      },

      deleteMany: async (args?: { where?: any }) => {
        let count = 0;
        if (!args?.where || Object.keys(args.where).length === 0) {
          count = sessions.size;
          sessions.clear();
          messages.clear();
          return { count };
        }

        for (const [id, session] of Array.from(sessions.entries())) {
          let match = true;
          if (args.where.id && args.where.id !== id) match = false;
          if (args.where.status && args.where.status !== session.status) match = false;

          if (match) {
            // Cascade delete messages
            for (const [msgId, msg] of messages.entries()) {
              if (msg.sessionId === id) messages.delete(msgId);
            }
            sessions.delete(id);
            count++;
          }
        }

        return { count };
      },

      findUnique: async (args: { where: { id: string }; include?: { messages?: boolean } }) => {
        const record = sessions.get(args.where.id);
        if (!record) return null;

        if (args.include?.messages) {
          const sessionMsgs = Array.from(messages.values()).filter((m) => m.sessionId === args.where.id);
          return { ...record, messages: sessionMsgs };
        }

        return { ...record };
      },

      findMany: async (args?: { where?: any; orderBy?: any; take?: number; skip?: number; include?: any }) => {
        let result = Array.from(sessions.values());

        if (args?.where) {
          if (args.where.status) result = result.filter((s) => s.status === args.where.status);
          if (args.where.authMode) result = result.filter((s) => s.authMode === args.where.authMode);
        }

        if (args?.skip) {
          result = result.slice(args.skip);
        }
        if (args?.take !== undefined) {
          result = result.slice(0, args.take);
        }

        return result;
      },

      count: async (args?: { where?: any }) => {
        if (!args?.where || Object.keys(args.where).length === 0) {
          return sessions.size;
        }
        let count = 0;
        for (const s of sessions.values()) {
          let match = true;
          if (args.where.id && args.where.id !== s.id) match = false;
          if (args.where.status && args.where.status !== s.status) match = false;
          if (match) count++;
        }
        return count;
      },
    },

    message: {
      create: async (args: { data: any; include?: { session?: boolean } }) => {
        const { data, include } = args;
        if (messages.has(data.id)) {
          throw new Error(`Unique constraint failed on the fields: (\`id\`) - Message '${data.id}' already exists.`);
        }

        const now = new Date();
        const record: MockMessageRecord = {
          id: data.id,
          sessionId: data.sessionId,
          direction: data.direction,
          remoteJid: data.remoteJid,
          lidJid: data.lidJid ?? null,
          text: data.text ?? null,
          hasMedia: data.hasMedia ?? false,
          mediaType: data.mediaType ?? null,
          mediaUrl: data.mediaUrl ?? null,
          status: data.status ?? MessageStatus.ENQUEUED,
          statusRaw: data.statusRaw ?? null,
          createdAt: data.createdAt ?? now,
          updatedAt: data.updatedAt ?? now,
        };

        messages.set(record.id, record);

        if (include?.session) {
          const session = sessions.get(record.sessionId) || null;
          return { ...record, session };
        }

        return { ...record };
      },

      upsert: async (args: { where: { id: string }; create: any; update: any; include?: { session?: boolean } }) => {
        const { where, create, update, include } = args;
        const existing = messages.get(where.id);

        if (existing) {
          const now = new Date();
          const updated: MockMessageRecord = {
            ...existing,
            ...update,
            updatedAt: now,
          };
          messages.set(where.id, updated);
          return { ...updated };
        } else {
          return await mock.message.create({ data: { ...create, id: where.id }, include });
        }
      },

      update: async (args: { where: { id: string }; data: any; include?: { session?: boolean } }) => {
        const { where, data, include } = args;
        const existing = messages.get(where.id);
        if (!existing) {
          throw new Error(`Record to update not found. Message '${where.id}' does not exist.`);
        }

        const now = new Date();
        const updated: MockMessageRecord = {
          ...existing,
          ...data,
          updatedAt: now,
        };
        messages.set(where.id, updated);

        if (include?.session) {
          const session = sessions.get(existing.sessionId) || null;
          return { ...updated, session };
        }

        return { ...updated };
      },

      delete: async (args: { where: { id: string } }) => {
        const { where } = args;
        const existing = messages.get(where.id);
        if (!existing) {
          throw new Error(`Record to delete not found. Message '${where.id}' does not exist.`);
        }
        messages.delete(where.id);
        return { ...existing };
      },

      deleteMany: async (args?: { where?: any }) => {
        let count = 0;
        if (!args?.where || Object.keys(args.where).length === 0) {
          count = messages.size;
          messages.clear();
          return { count };
        }

        for (const [id, msg] of Array.from(messages.entries())) {
          let match = true;
          if (args.where.sessionId && args.where.sessionId !== msg.sessionId) match = false;
          if (args.where.remoteJid && args.where.remoteJid !== msg.remoteJid) match = false;
          if (args.where.direction && args.where.direction !== msg.direction) match = false;
          if (args.where.status && args.where.status !== msg.status) match = false;

          if (match) {
            messages.delete(id);
            count++;
          }
        }

        return { count };
      },

      findUnique: async (args: { where: { id: string }; include?: { session?: boolean } }) => {
        const record = messages.get(args.where.id);
        if (!record) return null;

        if (args.include?.session) {
          const session = sessions.get(record.sessionId) || null;
          return { ...record, session };
        }

        return { ...record };
      },

      findMany: async (args?: { where?: any; orderBy?: any; take?: number; skip?: number; include?: any }) => {
        let result = Array.from(messages.values());

        if (args?.where) {
          if (args.where.sessionId) result = result.filter((m) => m.sessionId === args.where.sessionId);
          if (args.where.direction) result = result.filter((m) => m.direction === args.where.direction);
          if (args.where.remoteJid) result = result.filter((m) => m.remoteJid === args.where.remoteJid);
          if (args.where.status) result = result.filter((m) => m.status === args.where.status);
        }

        if (args?.orderBy) {
          if (args.orderBy.createdAt === 'desc') {
            result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          } else if (args.orderBy.createdAt === 'asc') {
            result.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
          }
        }

        if (args?.skip) {
          result = result.slice(args.skip);
        }
        if (args?.take !== undefined) {
          result = result.slice(0, args.take);
        }

        return result;
      },

      count: async (args?: { where?: any }) => {
        if (!args?.where || Object.keys(args.where).length === 0) {
          return messages.size;
        }
        let count = 0;
        for (const m of messages.values()) {
          let match = true;
          if (args.where.sessionId && args.where.sessionId !== m.sessionId) match = false;
          if (args.where.direction && args.where.direction !== m.direction) match = false;
          if (args.where.remoteJid && args.where.remoteJid !== m.remoteJid) match = false;
          if (args.where.status && args.where.status !== m.status) match = false;
          if (match) count++;
        }
        return count;
      },
    },

    webhookLog: {
      create: async (args: { data: any }) => {
        const { data } = args;
        const now = new Date();
        const record: MockWebhookLogRecord = {
          id: data.id ?? `wh-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
          sessionId: data.sessionId,
          event: data.event,
          payload: data.payload,
          statusCode: data.statusCode ?? null,
          attempts: data.attempts ?? 1,
          success: data.success ?? false,
          error: data.error ?? null,
          createdAt: data.createdAt ?? now,
        };

        webhookLogs.push(record);
        return { ...record };
      },

      deleteMany: async (args?: { where?: any }) => {
        let count = 0;
        if (!args?.where || Object.keys(args.where).length === 0) {
          count = webhookLogs.length;
          webhookLogs.length = 0;
          return { count };
        }

        for (let i = webhookLogs.length - 1; i >= 0; i--) {
          const log = webhookLogs[i];
          let match = true;
          if (args.where.sessionId && args.where.sessionId !== log.sessionId) match = false;
          if (args.where.event && args.where.event !== log.event) match = false;
          if (match) {
            webhookLogs.splice(i, 1);
            count++;
          }
        }

        return { count };
      },

      findMany: async (args?: { where?: any; orderBy?: any; take?: number; skip?: number }) => {
        let result = [...webhookLogs];

        if (args?.where) {
          if (args.where.sessionId) result = result.filter((l) => l.sessionId === args.where.sessionId);
          if (args.where.event) result = result.filter((l) => l.event === args.where.event);
          if (args.where.success !== undefined) result = result.filter((l) => l.success === args.where.success);
        }

        if (args?.orderBy) {
          if (args.orderBy.createdAt === 'desc') {
            result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          } else if (args.orderBy.createdAt === 'asc') {
            result.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
          }
        }

        if (args?.skip) {
          result = result.slice(args.skip);
        }
        if (args?.take !== undefined) {
          result = result.slice(0, args.take);
        }

        return result;
      },

      findUnique: async (args: { where: { id: string } }) => {
        const found = webhookLogs.find((l) => l.id === args.where.id);
        return found ? { ...found } : null;
      },

      count: async (args?: { where?: any }) => {
        if (!args?.where || Object.keys(args.where).length === 0) {
          return webhookLogs.length;
        }
        let count = 0;
        for (const l of webhookLogs) {
          let match = true;
          if (args.where.sessionId && args.where.sessionId !== l.sessionId) match = false;
          if (args.where.event && args.where.event !== l.event) match = false;
          if (args.where.success !== undefined && args.where.success !== l.success) match = false;
          if (match) count++;
        }
        return count;
      },
    },

    $disconnect: async () => {},
    $connect: async () => {},
    $transaction: async (arg: any) => {
      if (Array.isArray(arg)) {
        return Promise.all(arg);
      }
      if (typeof arg === 'function') {
        return arg(mock);
      }
      return null;
    },
  };

  return mock as unknown as PrismaClient;
}
