/**
 * Inbound & Outbound Media Pipeline Service
 * Handles media detection, streaming download from WhatsApp, disk storage, and retention management.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { downloadMediaMessage, proto, WASocket } from '@whiskeysockets/baileys';
import { config, getPublicBaseUrl } from '../config/env.js';
import { createSessionLogger, logger } from '../utils/logger.js';
import { formatBytes } from '../utils/cleanup.js';
import type {
  InboundMediaMetadata,
  MediaCleanupResult,
  MediaDetectedInfo,
} from '../types/index.js';

let isCleanupInProgress = false;

export class MediaService {
  private static storageRoot = path.resolve(process.cwd(), 'storage/media');

  /**
   * Ensures the root storage directory exists.
   */
  public static ensureStorageDir(): void {
    if (!fs.existsSync(this.storageRoot)) {
      try {
        fs.mkdirSync(this.storageRoot, { recursive: true });
      } catch (err: any) {
        logger.warn({ err: err.message }, '[MediaService] Failed creating media root directory');
      }
    }
  }

  /**
   * Helper to detect and extract media metadata from inbound WhatsApp messages.
   * Handles direct media messages as well as ephemeral, view-once, and captioned document envelopes.
   */
  public static detectInboundMedia(msg: proto.IWebMessageInfo): MediaDetectedInfo | null {
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
   * Downloads and saves inbound media attachment to disk and generates accessible public URL.
   */
  public static async processInboundMedia(
    sessionId: string,
    msg: proto.IWebMessageInfo,
    sock: WASocket,
    baileysLogger?: any
  ): Promise<InboundMediaMetadata | null> {
    const sessionLog = createSessionLogger(sessionId);
    const mediaInfo = this.detectInboundMedia(msg);
    if (!mediaInfo) return null;

    try {
      const buffer = await downloadMediaMessage(
        msg as any,
        'buffer',
        {},
        {
          logger: baileysLogger || logger,
          reuploadRequest: (update) => sock.updateMediaMessage(update),
        }
      );

      if (!buffer || buffer.length === 0) {
        return null;
      }

      const messageId = msg.key?.id || crypto.randomUUID();
      const ext = this.getMediaExtension(
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

      const sessionDir = path.join(this.storageRoot, sessionId);
      await fs.promises.mkdir(sessionDir, { recursive: true });

      const fileNameOnDisk = `${messageId}.${ext}`;
      const filePath = path.join(sessionDir, fileNameOnDisk);
      await fs.promises.writeFile(filePath, buffer);

      const mediaAccessUrl = `${getPublicBaseUrl()}/media/${encodeURIComponent(sessionId)}/${fileNameOnDisk}`;

      const inboundMedia: InboundMediaMetadata = {
        url: mediaAccessUrl,
        mimetype: mediaInfo.mimetype,
        fileSize: buffer.length,
        caption: mediaInfo.caption,
        type: mediaInfo.type,
        filename: mediaInfo.filename || fileNameOnDisk,
      };

      sessionLog.info(
        {
          messageId,
          type: mediaInfo.type,
          fileSize: buffer.length,
          url: mediaAccessUrl,
        },
        '[MediaService] Extracted, buffered to disk and access URL formed'
      );

      return inboundMedia;
    } catch (mediaErr: any) {
      sessionLog.error(
        { err: mediaErr.message, stack: mediaErr.stack, type: mediaInfo.type },
        '[MediaService] Failed to download inbound media attachment'
      );
      return null;
    }
  }

  /**
   * Scans the `storage/media` directory and removes files older than the retention threshold.
   * Also prunes empty tenant session directories to prevent disk accumulation.
   */
  public static async cleanStorage(retentionHours?: number): Promise<MediaCleanupResult> {
    const targetRetentionHours = retentionHours ?? config.mediaRetentionHours ?? 48;
    const retentionMs = targetRetentionHours * 60 * 60 * 1000;
    const cutoffTime = Date.now() - retentionMs;

    const result: MediaCleanupResult = {
      success: true,
      deletedFilesCount: 0,
      prunedDirsCount: 0,
      freedBytes: 0,
      freedBytesFormatted: '0 B',
      retentionHours: targetRetentionHours,
      timestamp: new Date().toISOString(),
    };

    if (!fs.existsSync(this.storageRoot)) {
      try {
        await fs.promises.mkdir(this.storageRoot, { recursive: true });
      } catch {
        // Ignore
      }
      return result;
    }

    if (isCleanupInProgress) {
      logger.debug('[MediaCleanup] Cleanup already in progress, skipping concurrent run');
      return result;
    }

    isCleanupInProgress = true;
    try {
      const rootEntries = await fs.promises.readdir(this.storageRoot, { withFileTypes: true });

      for (const entry of rootEntries) {
        const fullPath = path.join(this.storageRoot, entry.name);

        if (entry.isDirectory()) {
          const sessionDir = fullPath;
          try {
            const files = await fs.promises.readdir(sessionDir, { withFileTypes: true });

            for (const fileEntry of files) {
              const filePath = path.join(sessionDir, fileEntry.name);

              try {
                const stat = await fs.promises.stat(filePath);
                if (stat.isFile()) {
                  const fileAgeMs = Date.now() - stat.mtimeMs;
                  if (stat.mtimeMs < cutoffTime) {
                    await fs.promises.unlink(filePath);
                    result.deletedFilesCount++;
                    result.freedBytes += stat.size;
                    logger.debug(
                      {
                        filePath,
                        fileAgeHours: Math.round(fileAgeMs / (1000 * 60 * 60)),
                        size: stat.size,
                      },
                      '[MediaCleanup] Deleted expired media file'
                    );
                  }
                }
              } catch (fileErr: any) {
                logger.warn(
                  { filePath, err: fileErr.message },
                  '[MediaCleanup] Error checking/deleting file'
                );
              }
            }

            // Check if session directory is now empty and can be pruned
            const remainingFiles = await fs.promises.readdir(sessionDir);
            if (remainingFiles.length === 0) {
              try {
                await fs.promises.rmdir(sessionDir);
                result.prunedDirsCount++;
                logger.debug({ sessionDir }, '[MediaCleanup] Pruned empty session directory');
              } catch (rmDirErr: any) {
                logger.debug({ sessionDir, err: rmDirErr.message }, '[MediaCleanup] Note on rmdir');
              }
            }
          } catch (dirErr: any) {
            logger.warn(
              { sessionDir, err: dirErr.message },
              '[MediaCleanup] Error reading session directory'
            );
          }
        } else if (entry.isFile()) {
          // Loose file in root storage/media
          try {
            const stat = await fs.promises.stat(fullPath);
            if (stat.mtimeMs < cutoffTime) {
              await fs.promises.unlink(fullPath);
              result.deletedFilesCount++;
              result.freedBytes += stat.size;
            }
          } catch {
            // Ignore
          }
        }
      }

      result.freedBytesFormatted = formatBytes(result.freedBytes);

      logger.info(
        {
          deletedFiles: result.deletedFilesCount,
          prunedDirs: result.prunedDirsCount,
          freed: result.freedBytesFormatted,
          retentionHours: targetRetentionHours,
        },
        '[MediaCleanup] Media storage retention cleanup finished'
      );

      return result;
    } catch (err: any) {
      logger.error({ err: err.message }, '[MediaCleanup] Error executing media storage cleanup');
      result.success = false;
      result.freedBytesFormatted = formatBytes(result.freedBytes);
      return result;
    } finally {
      isCleanupInProgress = false;
    }
  }
}
