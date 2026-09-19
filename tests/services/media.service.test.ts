import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { MediaService, mediaService } from '../../src/services/media.service.js';
import { buildServer } from '../../src/server.js';
import * as baileys from '@whiskeysockets/baileys';

// Mock downloadMediaMessage from @whiskeysockets/baileys
vi.mock('@whiskeysockets/baileys', async () => {
  const actual = await vi.importActual<typeof baileys>('@whiskeysockets/baileys');
  return {
    ...actual,
    downloadMediaMessage: vi.fn(),
  };
});

describe('MediaService - Ingestion, Storage, and Retention Pipeline', () => {
  const testStorageDir = path.resolve(process.cwd(), 'storage/test-media');

  beforeEach(async () => {
    process.env.STORAGE_DIR = testStorageDir;
    process.env.MEDIA_RETENTION_DAYS = '7';
    if (fsSync.existsSync(testStorageDir)) {
      await fs.rm(testStorageDir, { recursive: true, force: true });
    }
    await fs.mkdir(testStorageDir, { recursive: true });
  });

  afterEach(async () => {
    if (fsSync.existsSync(testStorageDir)) {
      await fs.rm(testStorageDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('detects and infers correct media extension and types from various message formats', () => {
    expect(MediaService.getMediaExtension('image/jpeg')).toBe('jpg');
    expect(MediaService.getMediaExtension('image/png')).toBe('png');
    expect(MediaService.getMediaExtension('audio/ogg')).toBe('ogg');
    expect(MediaService.getMediaExtension('audio/opus')).toBe('opus');
    expect(MediaService.getMediaExtension('video/mp4')).toBe('mp4');
    expect(MediaService.getMediaExtension('application/pdf')).toBe('pdf');
    expect(MediaService.getMediaExtension(null, 'document.xlsx')).toBe('xlsx');
    expect(MediaService.getMediaExtension(null, null, 'bin')).toBe('bin');

    const imageMsg = {
      key: { id: 'img-msg-1', remoteJid: '12345@s.whatsapp.net' },
      message: {
        imageMessage: {
          mimetype: 'image/jpeg',
          caption: 'Test photo',
          fileLength: 1024,
        },
      },
    } as any;

    const detected = MediaService.detectInboundMedia(imageMsg);
    expect(detected).toEqual({
      type: 'image',
      mimetype: 'image/jpeg',
      caption: 'Test photo',
      filename: null,
      fileLength: 1024,
    });
  });

  it('downloads, decrypts, and saves inbound media into :year/:month/:sessionId/ structure', async () => {
    const mockImageBuffer = Buffer.from('FAKE_ENCRYPTED_MEDIA_BINARY_DATA');
    vi.mocked(baileys.downloadMediaMessage).mockResolvedValueOnce(mockImageBuffer as any);

    const testMsg = {
      key: { id: 'media-msg-999', remoteJid: '8801700000000@s.whatsapp.net' },
      message: {
        imageMessage: {
          mimetype: 'image/png',
          caption: 'Receipt document',
          fileLength: mockImageBuffer.length,
        },
      },
    } as any;

    const sessionId = 'tenant-alpha-1';
    const result = await mediaService.processInboundMedia(testMsg, sessionId);

    expect(result).not.toBeNull();
    expect(result?.mimetype).toBe('image/png');
    expect(result?.fileSize).toBe(mockImageBuffer.length);
    expect(result?.caption).toBe('Receipt document');
    expect(result?.type).toBe('image');
    expect(result?.url).toContain(`/media/`);
    expect(result?.url).toContain(sessionId);
    expect(result?.fileName).toMatch(/\.png$/);

    const date = new Date();
    const year = date.getFullYear().toString();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const expectedDir = path.join(testStorageDir, year, month, sessionId);
    const expectedFile = path.join(expectedDir, result!.fileName);

    expect(fsSync.existsSync(expectedFile)).toBe(true);
    const savedBuffer = await fs.readFile(expectedFile);
    expect(savedBuffer.toString()).toBe('FAKE_ENCRYPTED_MEDIA_BINARY_DATA');
  });

  it('purges expired files older than retention period and cleans up empty directories', async () => {
    const date = new Date();
    const year = date.getFullYear().toString();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const sessionDir = path.join(testStorageDir, year, month, 'session-test-purge');
    await fs.mkdir(sessionDir, { recursive: true });

    // 1. Create an expired file (e.g. 10 days old)
    const expiredFilePath = path.join(sessionDir, 'expired_file.jpg');
    await fs.writeFile(expiredFilePath, Buffer.from('OLD_MEDIA_CONTENT'));
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    fsSync.utimesSync(expiredFilePath, tenDaysAgo / 1000, tenDaysAgo / 1000);

    // 2. Create a fresh file (1 hour old)
    const freshFilePath = path.join(sessionDir, 'fresh_file.jpg');
    await fs.writeFile(freshFilePath, Buffer.from('FRESH_MEDIA_CONTENT'));

    // Run cleanup with 7 days retention
    const cleanupResult = await mediaService.runRetentionCleanup(7);

    expect(cleanupResult.success).toBe(true);
    expect(cleanupResult.deletedCount).toBe(1);
    expect(fsSync.existsSync(expiredFilePath)).toBe(false);
    expect(fsSync.existsSync(freshFilePath)).toBe(true);

    // Now remove the fresh file and test that directory pruning occurs
    await fs.unlink(freshFilePath);
    const pruneResult = await mediaService.runRetentionCleanup(7);
    expect(pruneResult.success).toBe(true);
    expect(fsSync.existsSync(sessionDir)).toBe(false);
  });

  it('serves stored media files over Fastify static /media/ route', async () => {
    const testYear = '2026';
    const testMonth = '09';
    const testSession = 'tenant-web-static';
    const sessionDir = path.join(testStorageDir, testYear, testMonth, testSession);
    await fs.mkdir(sessionDir, { recursive: true });

    const fileName = 'test_sample.png';
    const testFilePath = path.join(sessionDir, fileName);
    await fs.writeFile(testFilePath, Buffer.from('IMAGE_SERVE_TEST_CONTENT'));

    const fastify = await buildServer();

    const response = await fastify.inject({
      method: 'GET',
      url: `/media/${testYear}/${testMonth}/${testSession}/${fileName}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('IMAGE_SERVE_TEST_CONTENT');
    await fastify.close();
  });
});
