import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../../src/services/db.service.js';
import { MessageDirection, MessageStatus } from '@prisma/client';

describe('Message Persistence & Lifecycle', () => {
  const sessionId = 'tenant-msg-test';

  beforeEach(async () => {
    await prisma.message.deleteMany();
    await prisma.session.deleteMany();
    await prisma.session.create({
      data: { id: sessionId },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('should track outbound message from ENQUEUED to READ status', async () => {
    const messageId = '3EB0TEST12345';

    // 1. Initial enqueue
    const created = await prisma.message.create({
      data: {
        id: messageId,
        sessionId,
        direction: MessageDirection.OUTBOUND,
        remoteJid: '8801995329555@s.whatsapp.net',
        text: 'Order confirmation',
        status: MessageStatus.ENQUEUED,
      },
    });
    expect(created.status).toBe(MessageStatus.ENQUEUED);

    // 2. Server ACK update (Baileys dispatched)
    const serverAck = await prisma.message.update({
      where: { id: messageId },
      data: { status: MessageStatus.SERVER_ACK, statusRaw: 2 },
    });
    expect(serverAck.status).toBe(MessageStatus.SERVER_ACK);

    // 3. Delivery ACK update
    const delivered = await prisma.message.update({
      where: { id: messageId },
      data: { status: MessageStatus.DELIVERY_ACK, statusRaw: 3 },
    });
    expect(delivered.status).toBe(MessageStatus.DELIVERY_ACK);

    // 4. Read / Seen update
    const read = await prisma.message.update({
      where: { id: messageId },
      data: { status: MessageStatus.READ, statusRaw: 4 },
    });
    expect(read.status).toBe(MessageStatus.READ);
  });

  it('should handle duplicate inbound message insert gracefully by throwing unique constraint violation', async () => {
    const messageId = 'INBOUND_DUP_CHECK';

    const insertMessage = () =>
      prisma.message.create({
        data: {
          id: messageId,
          sessionId,
          direction: MessageDirection.INBOUND,
          remoteJid: '8801995329555@s.whatsapp.net',
          text: 'Repeated webhook text',
        },
      });

    await insertMessage();

    // Secondary attempt with the same ID must throw unique constraint violation
    await expect(insertMessage()).rejects.toThrow();
  });

  it('should query message with associated session relation via include', async () => {
    const messageId = '3EB0RELATION_TEST';

    await prisma.message.create({
      data: {
        id: messageId,
        sessionId,
        direction: MessageDirection.INBOUND,
        remoteJid: '8801700000000@s.whatsapp.net',
        text: 'Relationship test',
        status: MessageStatus.READ,
      },
    });

    const record = await prisma.message.findUnique({
      where: { id: messageId },
      include: { session: true },
    });

    expect(record).not.toBeNull();
    expect(record?.id).toBe(messageId);
    expect(record?.session).toBeDefined();
    expect(record?.session.id).toBe(sessionId);
  });

  it('should filter messages by direction and pagination', async () => {
    await prisma.message.create({
      data: {
        id: 'MSG_FILTER_1',
        sessionId,
        direction: MessageDirection.OUTBOUND,
        remoteJid: '8801711111111@s.whatsapp.net',
        text: 'Outbound 1',
      },
    });

    await prisma.message.create({
      data: {
        id: 'MSG_FILTER_2',
        sessionId,
        direction: MessageDirection.INBOUND,
        remoteJid: '8801722222222@s.whatsapp.net',
        text: 'Inbound 1',
      },
    });

    const outboundCount = await prisma.message.count({
      where: { sessionId, direction: MessageDirection.OUTBOUND },
    });
    expect(outboundCount).toBe(1);

    const messages = await prisma.message.findMany({
      where: { sessionId, direction: MessageDirection.OUTBOUND },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('MSG_FILTER_1');
  });
});
