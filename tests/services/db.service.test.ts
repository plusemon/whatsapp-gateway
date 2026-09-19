import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DbService, SessionStatus, MessageDirection, MessageStatus } from '../../src/services/db.service.js';

describe('Relational Database Persistence (DbService & Prisma ORM)', () => {
  const sampleSessionId = 'tenant-test-persist-1';
  const sampleMessageId = '3EB0TESTMSG12345';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    DbService.setPrismaClient(null);
  });

  describe('Session Model Persistence', () => {
    it('should upsert session records with expected properties', async () => {
      const mockUpsert = vi.fn().mockResolvedValue({
        id: sampleSessionId,
        status: SessionStatus.QR_READY,
        authMode: 'qr',
        phoneNumber: null,
        pushName: null,
        lastActiveAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      DbService.setPrismaClient({
        session: {
          upsert: mockUpsert,
        },
      } as any);

      const result = await DbService.upsertSession(sampleSessionId, {
        status: SessionStatus.QR_READY,
        authMode: 'qr',
      });

      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: sampleSessionId },
          create: expect.objectContaining({
            id: sampleSessionId,
            status: SessionStatus.QR_READY,
            authMode: 'qr',
          }),
        })
      );
      expect(result).toBeDefined();
      expect(result?.id).toBe(sampleSessionId);
    });

    it('should update session status and phone profile details on connect', async () => {
      const mockUpsert = vi.fn().mockResolvedValue({
        id: sampleSessionId,
        status: SessionStatus.CONNECTED,
        phoneNumber: '8801712345678',
        pushName: 'Gateway User',
      });

      DbService.setPrismaClient({
        session: {
          upsert: mockUpsert,
        },
      } as any);

      const result = await DbService.updateSessionStatus(sampleSessionId, SessionStatus.CONNECTED, {
        phoneNumber: '8801712345678',
        pushName: 'Gateway User',
      });

      expect(mockUpsert).toHaveBeenCalled();
      expect(result?.status).toBe(SessionStatus.CONNECTED);
    });
  });

  describe('Message Model Lifecycle Tracking', () => {
    it('should create and upsert outbound message records', async () => {
      const mockSessionUpsert = vi.fn().mockResolvedValue({});
      const mockMessageUpsert = vi.fn().mockResolvedValue({
        id: sampleMessageId,
        sessionId: sampleSessionId,
        direction: MessageDirection.OUTBOUND,
        remoteJid: '8801712345678@s.whatsapp.net',
        text: 'Hello from automated unit test',
        status: MessageStatus.SERVER_ACK,
        statusRaw: 2,
      });

      DbService.setPrismaClient({
        session: { upsert: mockSessionUpsert },
        message: { upsert: mockMessageUpsert },
      } as any);

      const res = await DbService.createMessage({
        id: sampleMessageId,
        sessionId: sampleSessionId,
        direction: MessageDirection.OUTBOUND,
        remoteJid: '8801712345678@s.whatsapp.net',
        text: 'Hello from automated unit test',
        status: MessageStatus.SERVER_ACK,
        statusRaw: 2,
      });

      expect(mockMessageUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: sampleMessageId },
          create: expect.objectContaining({
            id: sampleMessageId,
            sessionId: sampleSessionId,
            direction: MessageDirection.OUTBOUND,
            status: MessageStatus.SERVER_ACK,
          }),
        })
      );
      expect(res?.id).toBe(sampleMessageId);
    });

    it('should update delivery and read ACK statuses', async () => {
      const mockUpdate = vi.fn().mockResolvedValue({
        id: sampleMessageId,
        status: MessageStatus.READ,
        statusRaw: 4,
      });

      DbService.setPrismaClient({
        message: { update: mockUpdate },
      } as any);

      const updated = await DbService.updateMessageStatus(sampleMessageId, MessageStatus.READ, 4);

      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: sampleMessageId },
        data: {
          status: MessageStatus.READ,
          statusRaw: 4,
        },
      });
      expect(updated?.status).toBe(MessageStatus.READ);
    });

    it('should list session messages with pagination and filtering', async () => {
      const mockCount = vi.fn().mockResolvedValue(1);
      const mockFindMany = vi.fn().mockResolvedValue([
        {
          id: sampleMessageId,
          sessionId: sampleSessionId,
          direction: MessageDirection.INBOUND,
          remoteJid: '8801999999999@s.whatsapp.net',
          text: 'Inbound test message',
          status: MessageStatus.SERVER_ACK,
          createdAt: new Date(),
        },
      ]);

      DbService.setPrismaClient({
        message: {
          count: mockCount,
          findMany: mockFindMany,
        },
      } as any);

      const res = await DbService.listSessionMessages(sampleSessionId, {
        direction: MessageDirection.INBOUND,
        limit: 20,
        offset: 0,
      });

      expect(mockCount).toHaveBeenCalledWith({
        where: {
          sessionId: sampleSessionId,
          direction: MessageDirection.INBOUND,
        },
      });
      expect(res.total).toBe(1);
      expect(res.messages).toHaveLength(1);
      expect(res.messages[0].text).toBe('Inbound test message');
    });
  });

  describe('Webhook Audit Logging', () => {
    it('should create audit logs for webhook delivery attempts', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        id: 'webhook-log-1',
        sessionId: sampleSessionId,
        event: 'message.inbound',
        payload: { text: 'test' },
        statusCode: 200,
        attempts: 1,
        success: true,
      });

      DbService.setPrismaClient({
        webhookLog: { create: mockCreate },
      } as any);

      const log = await DbService.createWebhookLog({
        sessionId: sampleSessionId,
        event: 'message.inbound',
        payload: { text: 'test' },
        statusCode: 200,
        attempts: 1,
        success: true,
      });

      expect(mockCreate).toHaveBeenCalled();
      expect(log?.success).toBe(true);
    });
  });
});
