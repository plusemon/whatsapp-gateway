/**
 * WhatsApp Session Controller
 * Thin HTTP handler delegating business logic to SessionService.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { getRedisClient } from '../config/redis.js';
import { sessionService } from '../services/session.service.js';
import { ResponseUtil } from '../utils/response.util.js';
import { getCachedWhatsAppVersion, getWhatsAppVersion } from '../utils/versionGuard.js';
import type { PairCodeBody, SessionParams } from '../types/index.js';

export class SessionController {
  /**
   * POST /api/sessions/:id/init
   * Initializes or boots the WhatsApp Baileys socket session.
   */
  public static async initSession(
    request: FastifyRequest<{ Params: SessionParams }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const { id } = request.params;

    try {
      const sessionMeta = await sessionService.initSession(id);
      return ResponseUtil.success(
        reply,
        {
          sessionId: id,
          status: sessionMeta.status,
          message:
            sessionMeta.status === 'connected'
              ? 'Session is already connected'
              : 'Session socket initialized; waiting for QR scan or connection',
          qr: sessionMeta.qr,
        },
        200
      );
    } catch (err: any) {
      request.log.error({ sessionId: id, err: err.message }, 'Failed to initialize session');
      return ResponseUtil.error(
        reply,
        `Failed to initialize session: ${err.message}`,
        500,
        'INIT_FAILED',
        null,
        { sessionId: id, status: 'disconnected', qr: null }
      );
    }
  }

  /**
   * GET /api/sessions/:id/qr
   * Returns current raw QR string and rendered base64 data URL.
   */
  public static async getQr(
    request: FastifyRequest<{ Params: SessionParams; Querystring: { format?: string } }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const { id } = request.params;
    const meta = sessionService.getSession(id);
    const rawQr = await sessionService.getQR(id);

    if (!meta && !rawQr) {
      return ResponseUtil.error(
        reply,
        `Session '${id}' does not exist. Call POST /api/sessions/${id}/init first.`,
        404,
        'SESSION_NOT_FOUND',
        null,
        { sessionId: id, qr: null, status: 'disconnected' }
      );
    }

    let qrDataUrl: string | null = null;
    if (rawQr) {
      try {
        qrDataUrl = await QRCode.toDataURL(rawQr, { margin: 2, scale: 6 });
      } catch {
        // Ignore QR render error
      }
    }

    let message = 'Waiting for QR generation or device connection...';
    if (meta?.status === 'connected') {
      message = 'Device is already authenticated & connected';
    } else if (meta?.status === 'qr_expired') {
      message = 'QR code pairing timed out without being scanned. Re-initialize session to generate a new QR code.';
    } else if (rawQr) {
      message = 'Scan this QR code with WhatsApp';
    }

    return ResponseUtil.success(
      reply,
      {
        sessionId: id,
        qr: rawQr,
        status: meta?.status || (rawQr ? 'qr_ready' : 'idle'),
        qrDataUrl,
        message,
      },
      200
    );
  }

  /**
   * POST /api/sessions/:id/pair-code
   * Alternative to QR: requests an 8-character pairing code for phone number pairing.
   */
  public static async requestPairingCode(
    request: FastifyRequest<{ Params: SessionParams; Body: PairCodeBody }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const { id } = request.params;
    const { phoneNumber } = request.body;

    try {
      const formattedCode = await sessionService.requestPairingCode(id, phoneNumber);
      return ResponseUtil.success(
        reply,
        {
          sessionId: id,
          code: formattedCode,
          message: 'Pairing code generated. Enter this code in WhatsApp > Linked Devices > Link with phone number.',
        },
        200
      );
    } catch (err: any) {
      request.log.error({ sessionId: id, phoneNumber, err: err.message }, 'Failed to generate pairing code');
      return ResponseUtil.error(
        reply,
        err.message || 'Failed to request pairing code',
        400,
        'PAIRING_CODE_FAILED',
        null,
        { sessionId: id, code: null }
      );
    }
  }

  /**
   * DELETE /api/sessions/:id or POST /api/sessions/:id/purge
   * Disconnects socket and purges tenant session state from Redis.
   */
  public static async deleteSession(
    request: FastifyRequest<{ Params: SessionParams }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const { id } = request.params;

    try {
      await sessionService.deleteSession(id);
      return ResponseUtil.success(
        reply,
        {
          sessionId: id,
          message: 'Session purged successfully',
        },
        200
      );
    } catch (err: any) {
      request.log.error({ sessionId: id, err: err.message }, 'Failed to purge session');
      return ResponseUtil.error(
        reply,
        `Error purging session '${id}': ${err.message}`,
        500,
        'PURGE_FAILED',
        null,
        { sessionId: id }
      );
    }
  }

  /**
   * GET /api/sessions
   * Lists all active or registered sessions.
   */
  public static async listSessions(
    _request: FastifyRequest,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const sessions = sessionService.listSessions();
    return ResponseUtil.success(
      reply,
      {
        count: sessions.length,
        sessions,
      },
      200
    );
  }

  /**
   * GET /api/sessions/:id/status
   */
  public static async getSessionStatus(
    request: FastifyRequest<{ Params: SessionParams }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const { id } = request.params;
    const session = sessionService.getSession(id);

    if (!session) {
      return ResponseUtil.error(
        reply,
        `Session '${id}' not found`,
        404,
        'SESSION_NOT_FOUND'
      );
    }

    return ResponseUtil.success(
      reply,
      {
        session,
      },
      200
    );
  }

  /**
   * GET /api/events
   * Returns recent gateway events.
   */
  public static async getRecentEvents(
    _request: FastifyRequest,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    return ResponseUtil.success(
      reply,
      {
        events: sessionService.getRecentEvents(),
      },
      200
    );
  }

  /**
   * GET /api/system/version
   * WhatsApp Web Protocol Version Check & Guard
   */
  public static async getVersion(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    try {
      const redis = await getRedisClient();
      const versionInfo = await getWhatsAppVersion(redis);
      return ResponseUtil.success(
        reply,
        {
          protocolVersion: versionInfo.version.join('.'),
          versionTuple: versionInfo.version,
          isLatest: versionInfo.isLatest,
          source: versionInfo.source,
          fetchedAt: new Date(versionInfo.fetchedAt).toISOString(),
        },
        200
      );
    } catch (err: any) {
      request.log.error({ err: err.message }, 'Failed to retrieve WhatsApp protocol version');
      const cached = getCachedWhatsAppVersion();
      return ResponseUtil.success(
        reply,
        {
          protocolVersion: cached ? cached.version.join('.') : '2.3000.1015901307',
          versionTuple: cached ? cached.version : [2, 3000, 1015901307],
          isLatest: cached ? cached.isLatest : true,
          source: 'fallback',
          fetchedAt: new Date().toISOString(),
        },
        200
      );
    }
  }
}
