import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../../src/services/db.service.js';

describe('Webhook Log & Audit Persistence', () => {
  const sessionId = 'tenant-audit-test';

  beforeEach(async () => {
    await prisma.webhookLog.deleteMany();
    await prisma.message.deleteMany();
    await prisma.session.deleteMany();
    await prisma.session.create({
      data: { id: sessionId },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('should record webhook dispatch attempt and log payload with status', async () => {
    const payload = {
      event: 'message.inbound',
      sessionId,
      message: { id: 'MSG_WEBHOOK_1', text: 'Order status query' },
    };

    const log = await prisma.webhookLog.create({
      data: {
        sessionId,
        event: 'message.inbound',
        payload,
        statusCode: 200,
        attempts: 1,
        success: true,
      },
    });

    expect(log.id).toBeDefined();
    expect(log.sessionId).toBe(sessionId);
    expect(log.event).toBe('message.inbound');
    expect(log.statusCode).toBe(200);
    expect(log.success).toBe(true);
    expect(log.attempts).toBe(1);
    expect(log.payload).toEqual(payload);
  });

  it('should log webhook delivery failures with error details and retry attempts', async () => {
    const payload = {
      event: 'message.ack',
      sessionId,
      ack: { id: 'MSG_FAIL_1', status: 3 },
    };

    const failedLog = await prisma.webhookLog.create({
      data: {
        sessionId,
        event: 'message.ack',
        payload,
        statusCode: 502,
        attempts: 3,
        success: false,
        error: 'Bad Gateway - Connection refused by webhook endpoint',
      },
    });

    expect(failedLog.success).toBe(false);
    expect(failedLog.statusCode).toBe(502);
    expect(failedLog.attempts).toBe(3);
    expect(failedLog.error).toContain('Bad Gateway');
  });

  it('should query and filter webhook logs by session and event', async () => {
    await prisma.webhookLog.create({
      data: {
        sessionId,
        event: 'session.status',
        payload: { status: 'CONNECTED' },
        statusCode: 200,
        success: true,
      },
    });

    await prisma.webhookLog.create({
      data: {
        sessionId,
        event: 'message.inbound',
        payload: { text: 'Hello' },
        statusCode: 200,
        success: true,
      },
    });

    const statusLogs = await prisma.webhookLog.findMany({
      where: { sessionId, event: 'session.status' },
    });

    expect(statusLogs).toHaveLength(1);
    expect(statusLogs[0].event).toBe('session.status');

    const totalLogs = await prisma.webhookLog.count({
      where: { sessionId },
    });
    expect(totalLogs).toBe(2);
  });
});
