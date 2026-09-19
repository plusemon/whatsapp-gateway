/**
 * Standardized API Response Utilities
 * Enforces unified JSON payload formatting across all HTTP controllers.
 */
import type { FastifyReply } from 'fastify';

export class ResponseUtil {
  /**
   * Sends a standardized successful JSON response.
   */
  public static success<T = any>(
    reply: FastifyReply,
    data: T,
    statusCode = 200,
    extra: Record<string, any> = {}
  ): FastifyReply {
    const payload: Record<string, any> = {
      success: true,
      data,
      ...extra,
    };

    // For backwards compatibility with legacy UI expecting top-level fields
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [key, val] of Object.entries(data)) {
        if (!(key in payload)) {
          payload[key] = val;
        }
      }
    }

    return reply.status(statusCode).send(payload);
  }

  /**
   * Sends a standardized failure JSON response.
   */
  public static error(
    reply: FastifyReply,
    message: string,
    statusCode = 400,
    code = 'ERROR',
    details: any = null,
    extra: Record<string, any> = {}
  ): FastifyReply {
    const errorObj: Record<string, any> = {
      code,
      message,
    };
    if (details !== null && details !== undefined) {
      errorObj.details = details;
    }

    return reply.status(statusCode).send({
      success: false,
      error: errorObj,
      ...extra,
    });
  }
}

export const sendSuccess = ResponseUtil.success;
export const sendError = ResponseUtil.error;
