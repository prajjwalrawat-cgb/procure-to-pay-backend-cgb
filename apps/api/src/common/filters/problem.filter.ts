import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { DomainError } from '../errors/domain-error';

/** RFC 7807 problem+json body (Master Context §8). */
interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance: string;
  context?: Record<string, unknown>;
}

/**
 * Global exception filter — every error leaves the API as problem+json.
 * Never leaks stack traces or internals; unknown errors become a generic 500.
 */
@Catch()
export class ProblemExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const problem = this.toProblem(exception, req.originalUrl);

    // Unexpected server errors (not deliberate Domain/Http responses) carry no
    // detail in the problem+json body, so log the full cause here — otherwise a
    // 500 is silent server-side and near-impossible to diagnose.
    if (problem.status >= 500) {
      this.logger.error(
        `Unhandled ${problem.status} on ${req.method} ${req.originalUrl}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    res
      .status(problem.status)
      .setHeader('Content-Type', 'application/problem+json')
      .json(problem);
  }

  private toProblem(exception: unknown, instance: string): Problem {
    if (exception instanceof DomainError) {
      return {
        type: exception.type,
        title: exception.title,
        status: exception.status,
        detail: exception.message,
        instance,
        context: exception.context,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const detail =
        typeof response === 'string'
          ? response
          : ((response as { message?: string | string[] }).message ?? exception.message);
      return {
        type: `https://procureflow.io/errors/http-${status}`,
        title: HttpStatus[status] ?? 'Error',
        status,
        detail: Array.isArray(detail) ? detail.join(', ') : detail,
        instance,
      };
    }

    return {
      type: 'https://procureflow.io/errors/internal',
      title: 'Internal Server Error',
      status: 500,
      instance,
    };
  }
}
