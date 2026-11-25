import {
  CallHandler,
  ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { from, lastValueFrom, type Observable } from 'rxjs';

import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { TRANSACTION_TIMEOUT_KEY } from './transaction-timeout.decorator';

/**
 * TenantInterceptor (Master Context §4). Runs after JwtAuthGuard, so
 * `request.user` is set. Wraps the entire handler in a transaction with
 * `app.tenant_id` applied, so every DB statement the handler issues is RLS-
 * isolated to the caller's tenant. Public routes (no user) pass straight
 * through — they must not read tenanted data.
 *
 * The transaction uses Prisma's 5s default unless the route asks for longer
 * with @TransactionTimeout (see that decorator for when it is warranted).
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const tenantId = request.user?.tenantId;
    if (!tenantId) return next.handle();

    const timeout = this.reflector.getAllAndOverride<number | undefined>(
      TRANSACTION_TIMEOUT_KEY,
      [context.getHandler(), context.getClass()],
    );
    return from(
      this.prisma.runInTenantContext(
        tenantId,
        () => lastValueFrom(next.handle()),
        timeout ? { timeout } : undefined,
      ),
    );
  }
}
