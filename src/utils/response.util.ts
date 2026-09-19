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
    // If data is already an object, spread it alongside success: true for backward compatibility
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return reply.status(statusCode).send({
        success: true,
        ...data,
        ...extra,
      });
    }

    return reply.status(statusCode).send({
      success: true,
      data,
      ...extra,
    });
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
    return reply.status(statusCode).send({
      success: false,
      message,
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
      ...extra,
    });
  }
}

export const sendSuccess = ResponseUtil.success;
export const sendError = ResponseUtil.error;
