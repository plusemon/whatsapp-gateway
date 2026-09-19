import fs from 'fs';
import path from 'path';
import { config } from '../config/env.js';
import { logger } from './logger.js';
import type { MediaCleanupResult } from '../types/index.js';

let cleanupIntervalTimer: NodeJS.Timeout | null = null;
let isCleanupInProgress = false;

/**
 * Formats byte counts into human-readable strings (e.g., 2.45 MB).
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const formatted = parseFloat((bytes / Math.pow(k, i)).toFixed(2));
  return `${formatted} ${sizes[i]}`;
}

/**
 * Scans the `storage/media` directory and removes files older than the retention threshold.
 * Also prunes empty tenant session directories to prevent disk accumulation.
 *
 * @param retentionHours Threshold in hours (defaults to config.mediaRetentionHours or 48)
 */
export async function cleanMediaStorage(retentionHours?: number): Promise<MediaCleanupResult> {
  const targetRetentionHours = retentionHours ?? config.mediaRetentionHours ?? 48;
  const retentionMs = targetRetentionHours * 60 * 60 * 1000;
  const cutoffTime = Date.now() - retentionMs;
  const storageDir = path.resolve(process.cwd(), 'storage/media');

  const result: MediaCleanupResult = {
    success: true,
    deletedFilesCount: 0,
    prunedDirsCount: 0,
    freedBytes: 0,
    freedBytesFormatted: '0 B',
    retentionHours: targetRetentionHours,
    timestamp: new Date().toISOString(),
  };

  if (!fs.existsSync(storageDir)) {
    try {
      await fs.promises.mkdir(storageDir, { recursive: true });
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
    const rootEntries = await fs.promises.readdir(storageDir, { withFileTypes: true });

    for (const entry of rootEntries) {
      const fullPath = path.join(storageDir, entry.name);

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

export function startMediaCleanupWorker(
  intervalHours?: number,
  retentionHours?: number
): { stop: () => void; runNow: () => Promise<MediaCleanupResult> } {
  const targetIntervalHours = intervalHours ?? config.mediaCleanupIntervalHours ?? 6;
  const targetRetentionHours = retentionHours ?? config.mediaRetentionHours ?? 48;
  const intervalMs = targetIntervalHours * 60 * 60 * 1000;

  stopMediaCleanupWorker();

  logger.info(
    {
      intervalHours: targetIntervalHours,
      retentionHours: targetRetentionHours,
    },
    '[MediaCleanup] Media retention cleanup worker initialized'
  );

  setTimeout(() => {
    cleanMediaStorage(targetRetentionHours).catch((err) => {
      logger.error({ err: err.message }, '[MediaCleanup] Initial background cleanup failed');
    });
  }, 10000).unref();

  cleanupIntervalTimer = setInterval(() => {
    cleanMediaStorage(targetRetentionHours).catch((err) => {
      logger.error({ err: err.message }, '[MediaCleanup] Scheduled background cleanup failed');
    });
  }, intervalMs);

  if (cleanupIntervalTimer.unref) {
    cleanupIntervalTimer.unref();
  }

  return {
    stop: stopMediaCleanupWorker,
    runNow: () => cleanMediaStorage(targetRetentionHours),
  };
}

export function stopMediaCleanupWorker(): void {
  if (cleanupIntervalTimer) {
    clearInterval(cleanupIntervalTimer);
    cleanupIntervalTimer = null;
    logger.info('[MediaCleanup] Media retention cleanup worker stopped');
  }
}
