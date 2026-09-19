/**
 * Outbound Message Controller
 * Thin HTTP handler delegating message and media dispatching to SessionService.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sessionService } from '../services/session.service.js';
import { DbService, MessageDirection } from '../services/db.service.js';
import { ResponseUtil } from '../utils/response.util.js';
import type {
  SendMediaBody,
  SendMediaV1Body,
  SendMessageBody,
  SendTextV1Body,
  SessionParams,
} from '../types/index.js';

export class MessageController {
  /**
   * GET /api/v1/sessions/:sessionId/messages
   * Paginated list of historical messages for a tenant session.
   */
  public static async listSessionMessages(
    request: FastifyRequest<{
      Params: { sessionId?: string; id?: string };
      Querystring: {
        direction?: MessageDirection;
        remoteJid?: string;
        limit?: number;
        offset?: number;
      };
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const sessionId = request.params.sessionId || request.params.id;
    const { direction, remoteJid, limit, offset } = request.query || {};

    if (!sessionId) {
      return ResponseUtil.error(reply, 'sessionId parameter is required.', 400, 'VALIDATION_ERROR');
    }

    try {
      const data = await DbService.listSessionMessages(sessionId, {
        direction,
        remoteJid,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      });

      return ResponseUtil.success(reply, data, 200);
    } catch (err: any) {
      request.log.error({ sessionId, err: err.message }, 'Failed to list session messages');
      return ResponseUtil.error(reply, err.message || 'Failed to list messages', 500, 'QUERY_FAILED');
    }
  }

  /**
   * GET /api/v1/messages/:messageId
   * Retrieve message delivery lifecycle status and metadata by message ID.
   */
  public static async getMessageById(
    request: FastifyRequest<{ Params: { messageId?: string; id?: string } }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const messageId = request.params.messageId || request.params.id;

    if (!messageId) {
      return ResponseUtil.error(reply, 'messageId parameter is required.', 400, 'VALIDATION_ERROR');
    }

    try {
      const message = await DbService.getMessage(messageId);
      if (!message) {
        return ResponseUtil.error(reply, `Message '${messageId}' not found`, 404, 'MESSAGE_NOT_FOUND');
      }

      return ResponseUtil.success(reply, message, 200);
    } catch (err: any) {
      request.log.error({ messageId, err: err.message }, 'Failed to query message by ID');
      return ResponseUtil.error(reply, err.message || 'Failed to query message', 500, 'QUERY_FAILED');
    }
  }

  /**
   * POST /api/v1/messages/send-text
   * Standardized REST API v1 Text Dispatch
   */
  public static async sendTextV1(
    request: FastifyRequest<{ Body: SendTextV1Body }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const { sessionId, to, message, presence, jid, text } = request.body || {};
    const targetSession = sessionId;
    const targetRecipient = to || jid;
    const messageText = message || text;

    if (!targetSession || !targetRecipient || !messageText) {
      return ResponseUtil.error(
        reply,
        'sessionId, to, and message are required fields.',
        400,
        'VALIDATION_ERROR'
      );
    }

    try {
      const result = await sessionService.sendMessage(
        targetSession,
        targetRecipient,
        messageText,
        presence !== false
      );

      return ResponseUtil.success(
        reply,
        {
          messageId: result.messageId,
          status: 'SERVER_ACK',
        },
        200
      );
    } catch (err: any) {
      request.log.error(
        { sessionId: targetSession, to: targetRecipient, err: err.message },
        'Failed to dispatch v1 text message'
      );
      const isNotConnected = err.message?.includes('not active or connected');
      return ResponseUtil.error(
        reply,
        err.message || 'Failed to dispatch outbound message',
        isNotConnected ? 400 : 500,
        isNotConnected ? 'SESSION_NOT_CONNECTED' : 'SEND_FAILED'
      );
    }
  }

  /**
   * POST /api/v1/messages/send-media
   * Standardized REST API v1 Media Dispatch
   */
  public static async sendMediaV1(
    request: FastifyRequest<{ Body: SendMediaV1Body }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      sessionId,
      to,
      mediaUrl,
      mediaType,
      caption,
      fileName,
      jid,
      url,
      type,
      filename,
      ptt,
    } = request.body || {};

    const targetSession = sessionId;
    const targetRecipient = to || jid;
    const targetUrl = mediaUrl || url;
    const targetType = (mediaType || type) as 'document' | 'image' | 'video' | 'audio';
    const targetFilename = fileName || filename;

    if (!targetSession || !targetRecipient || !targetUrl || !targetType) {
      return ResponseUtil.error(
        reply,
        'sessionId, to, mediaUrl, and mediaType are required fields.',
        400,
        'VALIDATION_ERROR'
      );
    }

    const validTypes = ['document', 'image', 'video', 'audio'];
    if (!validTypes.includes(targetType)) {
      return ResponseUtil.error(
        reply,
        `Invalid mediaType '${targetType}'. Must be one of: document, image, video, audio.`,
        400,
        'VALIDATION_ERROR'
      );
    }

    try {
      const result = await sessionService.sendMedia(
        targetSession,
        targetRecipient,
        targetType,
        targetUrl,
        {
          caption,
          filename: targetFilename,
          ptt,
        }
      );

      return ResponseUtil.success(
        reply,
        {
          messageId: result.messageId,
          status: 'SERVER_ACK',
        },
        200
      );
    } catch (err: any) {
      request.log.error(
        { sessionId: targetSession, to: targetRecipient, mediaType: targetType, err: err.message },
        'Failed to dispatch v1 media message'
      );
      const isNotConnected = err.message?.includes('not active or connected');
      return ResponseUtil.error(
        reply,
        err.message || 'Failed to dispatch outbound media message',
        isNotConnected ? 400 : 500,
        isNotConnected ? 'SESSION_NOT_CONNECTED' : 'SEND_MEDIA_FAILED'
      );
    }
  }

  /**
   * POST /api/sessions/:id/send
   * Dispatches outbound text message via tenant socket with anti-ban simulation (legacy).
   */
  public static async sendTextMessage(
    request: FastifyRequest<{ Params: SessionParams; Body: SendMessageBody }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const { id } = request.params;
    const { jid, text } = request.body;

    try {
      const result = await sessionService.sendMessage(id, jid, text);
      return ResponseUtil.success(
        reply,
        {
          sessionId: id,
          jid,
          messageId: result.messageId,
          timestamp: result.timestamp,
        },
        200
      );
    } catch (err: any) {
      request.log.error({ sessionId: id, jid, err: err.message }, 'Failed to send message');
      return ResponseUtil.error(
        reply,
        err.message || 'Failed to dispatch outbound message',
        400,
        'SEND_FAILED',
        null,
        { sessionId: id, jid, messageId: '', timestamp: Date.now() }
      );
    }
  }

  /**
   * POST /api/sessions/:id/send-media
   * Dispatches outbound media (image, audio, document) with presence simulation (legacy).
   */
  public static async sendMediaMessage(
    request: FastifyRequest<{ Params: SessionParams; Body: SendMediaBody }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const { id } = request.params;
    const { jid, type, url, caption, filename, ptt } = request.body;

    try {
      const result = await sessionService.sendMedia(id, jid, type, url, {
        caption,
        filename,
        ptt,
      });

      return ResponseUtil.success(
        reply,
        {
          sessionId: id,
          jid,
          type,
          messageId: result.messageId,
          timestamp: result.timestamp,
        },
        200
      );
    } catch (err: any) {
      request.log.error(
        { sessionId: id, jid, type, url, err: err.message },
        'Failed to send outbound media'
      );
      return ResponseUtil.error(
        reply,
        err.message || 'Failed to dispatch outbound media message',
        400,
        'SEND_MEDIA_FAILED',
        null,
        { sessionId: id, jid, type, messageId: '', timestamp: Date.now() }
      );
    }
  }
}
