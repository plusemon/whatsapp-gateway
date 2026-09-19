import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../../src/services/db.service.js';
import { SessionStatus } from '@prisma/client';

describe('Session Database Layer', () => {
  beforeEach(async () => {
    await prisma.message.deleteMany();
    await prisma.session.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('should upsert session when initializing new tenant', async () => {
    const session = await prisma.session.upsert({
      where: { id: 'tenant-test-1' },
      create: { id: 'tenant-test-1', status: SessionStatus.QR_READY, authMode: 'qr' },
      update: { status: SessionStatus.QR_READY },
    });

    expect(session.id).toBe('tenant-test-1');
    expect(session.status).toBe(SessionStatus.QR_READY);
  });

  it('should update session status and phone on connection open', async () => {
    await prisma.session.create({
      data: { id: 'tenant-test-1', status: SessionStatus.QR_READY },
    });

    const updated = await prisma.session.update({
      where: { id: 'tenant-test-1' },
      data: {
        status: SessionStatus.CONNECTED,
        phoneNumber: '8801995329555',
        pushName: 'Botla Gateway',
      },
    });

    expect(updated.status).toBe(SessionStatus.CONNECTED);
    expect(updated.phoneNumber).toBe('8801995329555');
  });

  it('should cascade delete all messages when session is purged', async () => {
    const session = await prisma.session.create({
      data: {
        id: 'tenant-cascade',
        status: SessionStatus.CONNECTED,
        messages: {
          create: [
            { id: 'MSG_1', direction: 'OUTBOUND', remoteJid: '8801700000000@s.whatsapp.net', text: 'Hello' },
            { id: 'MSG_2', direction: 'INBOUND', remoteJid: '8801700000000@s.whatsapp.net', text: 'Hi' },
          ],
        },
      },
      include: { messages: true },
    });

    expect(session.messages.length).toBe(2);

    // Delete Session
    await prisma.session.delete({ where: { id: 'tenant-cascade' } });

    // Verify Messages were deleted
    const count = await prisma.message.count({ where: { sessionId: 'tenant-cascade' } });
    expect(count).toBe(0);
  });

  it('should retrieve a session with associated messages via findUnique and include', async () => {
    await prisma.session.create({
      data: {
        id: 'tenant-find-test',
        status: SessionStatus.CONNECTED,
        messages: {
          create: [
            { id: 'MSG_FIND_1', direction: 'OUTBOUND', remoteJid: '8801800000000@s.whatsapp.net', text: 'Welcome' },
          ],
        },
      },
    });

    const record = await prisma.session.findUnique({
      where: { id: 'tenant-find-test' },
      include: { messages: true },
    });

    expect(record).not.toBeNull();
    expect(record?.id).toBe('tenant-find-test');
    expect(record?.messages).toHaveLength(1);
    expect(record?.messages[0].text).toBe('Welcome');
  });
});
