/**
 * Inbound & Outbound Media Pipeline Service
 * Handles media detection, streaming decryption/download from WhatsApp,
 * organized local disk storage (:year/:month/:sessionId/), public HTTP routing,
 * and automated retention cleanup.
 */
import crypto from 'crypto';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { downloadMediaMessage, proto, WAMessage, WASocket } from '@whiskeysockets/baileys';
import { config, getPublicBaseUrl } from '../config/env.js';
import { createSessionLogger, logger as defaultLogger } from '../utils/logger.js';
import { formatBytes } from '../utils/cleanup.js';
import type {
  InboundMediaMetadata,
  MediaCleanupResult,
  MediaDetectedInfo,
} from '../types/index.js';

let isCleanupInProgress = false;

export class MediaService {
  constructor() {
    this.ensureDirectoryExists(this.getBaseStorageDir());
  }

  /**
   * Resolves the base storage directory dynamically from environment or default.
   */
  public getBaseStorageDir(): string {
    return path.resolve(process.env.STORAGE_DIR || './storage/media');
  }

  /**
   * Resolves retention days dynamically from environment or default.
   */
  public getRetentionDays(): number {
    return parseInt(process.env.MEDIA_RETENTION_DAYS || '7', 10);
  }

  /**
   * Helper to ensure directory exists on disk.
   */
  public async ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
      await fsPromises.mkdir(dirPath, { recursive: true });
    } catch (err: any) {
      defaultLogger.error({ err: err.message, dirPath }, `[MediaService] Failed to create directory: ${dirPath}`);
    }
  }

  /**
   * Synchronous directory creation helper.
   */
  public static ensureStorageDir(): void {
    const storageDir = path.resolve(process.env.STORAGE_DIR || './storage/media');
    if (!fs.existsSync(storageDir)) {
      try {
        fs.mkdirSync(storageDir, { recursive: true });
      } catch (err: any) {
        defaultLogger.warn({ err: err.message }, '[MediaService] Failed creating media root directory');
      }
    }
  }

  /**
   * Helper to detect and extract media metadata from inbound WhatsApp messages.
   * Handles direct media messages as well as ephemeral, view-once, and captioned document envelopes.
   */
  public static detectInboundMedia(msg: proto.IWebMessageInfo | WAMessage): MediaDetectedInfo | null {
    let m = msg.message;
    if (!m) return null;

    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;

    if (m.imageMessage) {
      return {
        type: 'image',
        mimetype: m.imageMessage.mimetype || 'image/jpeg',
        caption: m.imageMessage.caption || null,
        filename: null,
        fileLength: Number(m.imageMessage.fileLength || 0),
      };
    }
    if (m.audioMessage) {
      return {
        type: 'audio',
        mimetype: m.audioMessage.mimetype || 'audio/ogg',
        caption: null,
        filename: null,
        fileLength: Number(m.audioMessage.fileLength || 0),
      };
    }
    if (m.documentMessage) {
      return {
        type: 'document',
        mimetype: m.documentMessage.mimetype || 'application/octet-stream',
        caption: m.documentMessage.caption || null,
        filename: m.documentMessage.fileName || null,
        fileLength: Number(m.documentMessage.fileLength || 0),
      };
    }
    if (m.videoMessage) {
      return {
        type: 'video',
        mimetype: m.videoMessage.mimetype || 'video/mp4',
        caption: m.videoMessage.caption || null,
        filename: null,
        fileLength: Number(m.videoMessage.fileLength || 0),
      };
    }

    return null;
  }

  /**
   * Infers an appropriate file extension from mimetype or original filename.
   */
  public static getMediaExtension(
    mimetype?: string | null,
    originalFileName?: string | null,
    defaultExt: string = 'bin'
  ): string {
    if (originalFileName) {
      const ext = path.extname(originalFileName).replace('.', '').toLowerCase();
      if (ext && ext.length >= 1 && ext.length <= 8) return ext;
    }
    if (!mimetype) return defaultExt;

    const cleanMime = mimetype.split(';')[0].trim().toLowerCase();
    const mimeMap: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'audio/ogg': 'ogg',
      'audio/opus': 'opus',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'audio/aac': 'aac',
      'audio/wav': 'wav',
      'video/mp4': 'mp4',
      'video/3gpp': '3gp',
      'video/quicktime': 'mov',
      'application/pdf': 'pdf',
      'application/msword': 'doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.ms-excel': 'xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'application/zip': 'zip',
      'text/plain': 'txt',
      'text/csv': 'csv',
    };

    if (mimeMap[cleanMime]) return mimeMap[cleanMime];
    const sub = cleanMime.split('/')[1];
    if (sub && /^[a-z0-9]{2,6}$/.test(sub)) return sub;

    return defaultExt;
  }

  /**
   * Decrypt and save incoming media attachment from WhatsApp message.
   * Supports both (message, sessionId, sock?, logger?) and (sessionId, message, sock?, logger?) argument order.
   */
  async processInboundMedia(
    arg1: proto.IWebMessageInfo | WAMessage | string,
    arg2: string | proto.IWebMessageInfo | WAMessage,
    sock?: WASocket,
    customLogger?: any
  ): Promise<(InboundMediaMetadata & { fileName: string }) | null> {
    let message: proto.IWebMessageInfo | WAMessage;
    let sessionId: string;

    if (typeof arg1 === 'string') {
      sessionId = arg1;
      message = arg2 as proto.IWebMessageInfo;
    } else {
      message = arg1;
      sessionId = arg2 as string;
    }

    const sessionLog = createSessionLogger(sessionId);
    const mediaInfo = MediaService.detectInboundMedia(message);
    if (!mediaInfo) return null;

    try {
      const buffer = await downloadMediaMessage(
        message as any,
        'buffer',
        {},
        {
          logger: customLogger || sessionLog || defaultLogger,
          reuploadRequest: sock
            ? (update: any) => sock.updateMediaMessage(update)
            : () => Promise.resolve({} as any),
        }
      );

      if (!buffer || buffer.length === 0) {
        return null;
      }

      const date = new Date();
      const year = date.getFullYear().toString();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const baseDir = this.getBaseStorageDir();
      const targetDir = path.join(baseDir, year, month, sessionId);
      await this.ensureDirectoryExists(targetDir);

      const ext = MediaService.getMediaExtension(
        mediaInfo.mimetype,
        mediaInfo.filename,
        mediaInfo.type === 'image'
          ? 'jpg'
          : mediaInfo.type === 'audio'
          ? 'ogg'
          : mediaInfo.type === 'video'
          ? 'mp4'
          : 'bin'
      );

      const uniqueHash = crypto.randomBytes(8).toString('hex');
      const fileName = `${Date.now()}_${uniqueHash}.${ext}`;
      const filePath = path.join(targetDir, fileName);

      await fsPromises.writeFile(filePath, buffer);

      const relativePath = `/media/${year}/${month}/${sessionId}/${fileName}`;
      const publicBase = getPublicBaseUrl();
      const fullUrl = publicBase ? `${publicBase}${relativePath}` : relativePath;

      const inboundMedia: InboundMediaMetadata & { fileName: string } = {
        url: fullUrl,
        fileName,
        filename: mediaInfo.filename || fileName,
        mimetype: mediaInfo.mimetype,
        fileSize: buffer.length,
        caption: mediaInfo.caption,
        type: mediaInfo.type,
      };

      sessionLog.info(
        {
          messageId: message.key?.id,
          type: mediaInfo.type,
          fileSize: buffer.length,
          fileName,
          url: fullUrl,
        },
        '[MediaService] Inbound media downloaded, decrypted, saved to disk and public URL generated'
      );

      return inboundMedia;
    } catch (err: any) {
      sessionLog.error(
        { err: err.message, stack: err.stack, messageId: message.key?.id, type: mediaInfo.type },
        '[MediaService] Failed to download or write inbound media'
      );
      return null;
    }
  }

  /**
   * Static method for backwards compatibility with existing codebase.
   */
  public static async processInboundMedia(
    sessionId: string,
    msg: proto.IWebMessageInfo,
    sock?: WASocket,
    baileysLogger?: any
  ): Promise<(InboundMediaMetadata & { fileName: string }) | null> {
    return mediaService.processInboundMedia(msg, sessionId, sock, baileysLogger);
  }

  /**
   * Automated cleanup routine for expired media files.
   * Recursively traverses storage directories and removes files older than retentionDays.
   * Also purges empty nested directories to keep the filesystem clean.
   */
  async runRetentionCleanup(retentionDaysOverride?: number): Promise<{
    deletedCount: number;
    freedBytes: number;
    freedBytesFormatted: string;
    prunedDirsCount: number;
    success: boolean;
  }> {
    const days = retentionDaysOverride ?? this.getRetentionDays();
    const baseDir = this.getBaseStorageDir();
    defaultLogger.info(`[MediaCleanup] Running media retention cleanup (Retention: ${days} days)...`);

    let deletedCount = 0;
    let freedBytes = 0;
    let prunedDirsCount = 0;
    const now = Date.now();
    const maxAgeMs = days * 24 * 60 * 60 * 1000;

    if (!fs.existsSync(baseDir)) {
      try {
        await fsPromises.mkdir(baseDir, { recursive: true });
      } catch {
        // Ignore
      }
      return {
        deletedCount: 0,
        freedBytes: 0,
        freedBytesFormatted: '0 B',
        prunedDirsCount: 0,
        success: true,
      };
    }

    if (isCleanupInProgress) {
      defaultLogger.debug('[MediaCleanup] Cleanup already in progress, skipping concurrent run');
      return {
        deletedCount: 0,
        freedBytes: 0,
        freedBytesFormatted: '0 B',
        prunedDirsCount: 0,
        success: true,
      };
    }

    isCleanupInProgress = true;

    try {
      const traverseAndClean = async (dir: string): Promise<boolean> => {
        let entries: fs.Dirent[] = [];
        try {
          entries = await fsPromises.readdir(dir, { withFileTypes: true });
        } catch (err) {
          return false;
        }

        let remainingChildren = entries.length;

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            const isChildEmpty = await traverseAndClean(fullPath);
            if (isChildEmpty) {
              try {
                await fsPromises.rmdir(fullPath);
                prunedDirsCount++;
                remainingChildren--;
                defaultLogger.debug({ dir: fullPath }, '[MediaCleanup] Pruned empty directory');
              } catch (rmDirErr: any) {
                defaultLogger.debug({ dir: fullPath, err: rmDirErr.message }, '[MediaCleanup] Note on rmdir');
              }
            }
          } else if (entry.isFile()) {
            try {
              const stats = await fsPromises.stat(fullPath);
              if (now - stats.mtimeMs >= maxAgeMs) {
                await fsPromises.unlink(fullPath);
                deletedCount++;
                freedBytes += stats.size;
                remainingChildren--;
                defaultLogger.debug(
                  { fullPath, ageMs: now - stats.mtimeMs, size: stats.size },
                  '[MediaCleanup] Deleted expired media file'
                );
              }
            } catch (err: any) {
              defaultLogger.warn({ fullPath, err: err.message }, '[MediaCleanup] Error checking/deleting file');
            }
          }
        }

        // Return true if directory is now empty and not the root storage dir itself
        return remainingChildren === 0 && dir !== baseDir;
      };

      await traverseAndClean(baseDir);

      const freedBytesFormatted = formatBytes(freedBytes);
      defaultLogger.info(
        `[MediaCleanup] Retention cleanup completed. Total expired files purged: ${deletedCount} (${freedBytesFormatted} freed, ${prunedDirsCount} empty directories pruned)`
      );

      return {
        deletedCount,
        freedBytes,
        freedBytesFormatted,
        prunedDirsCount,
        success: true,
      };
    } catch (err: any) {
      defaultLogger.error({ err: err.message }, '[MediaCleanup] Error during media retention cleanup');
      return {
        deletedCount,
        freedBytes,
        freedBytesFormatted: formatBytes(freedBytes),
        prunedDirsCount,
        success: false,
      };
    } finally {
      isCleanupInProgress = false;
    }
  }

  /**
   * Static alias for retention cleanup.
   */
  public static async cleanStorage(retentionHours?: number): Promise<MediaCleanupResult> {
    const days = retentionHours ? retentionHours / 24 : undefined;
    const result = await mediaService.runRetentionCleanup(days);
    return {
      success: result.success,
      deletedFilesCount: result.deletedCount,
      prunedDirsCount: result.prunedDirsCount,
      freedBytes: result.freedBytes,
      freedBytesFormatted: result.freedBytesFormatted,
      retentionHours: retentionHours ?? config.mediaRetentionHours ?? 48,
      timestamp: new Date().toISOString(),
    };
  }
}

export const mediaService = new MediaService();
