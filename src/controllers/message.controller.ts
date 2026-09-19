/**
 * Outbound Message Controller
 * Thin HTTP handler delegating message and media dispatching to SessionService.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sessionService } from '../services/session.service.js';
import { ResponseUtil } from '../utils/response.util.js';
import type { SendMediaBody, SendMessageBody, SessionParams } from '../types/index.js';

export class MessageController {
  /**
   * POST /api/sessions/:id/send
   * Dispatches outbound text message via tenant socket with anti-ban simulation.
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
   * Dispatches outbound media (image, audio, document) with presence simulation.
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
