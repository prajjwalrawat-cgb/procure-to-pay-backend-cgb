import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@procureflow/db';

interface TenantContext {
  tenantId: string;
  tx: Prisma.TransactionClient;
}

/**
 * PrismaService — the single Prisma entrypoint (Master Context §3 rule #2).
 *
 * `runInTenantContext` opens a transaction, sets `app.tenant_id` via
 * `set_config(..., is_local => true)` so Postgres RLS filters every statement to
 * the tenant (§3 rule #1, §4), and stores the transaction client in an
 * AsyncLocalStorage. `client` transparently returns that transaction client to
 * any service running inside the context, so request-scoped queries are always
 * tenant-isolated without threading the tx through every call.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly als = new AsyncLocalStorage<TenantContext>();

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** The active client: the request transaction when inside a tenant context,
   *  otherwise the base (unscoped) client. */
  get client(): Prisma.TransactionClient | PrismaClient {
    return this.als.getStore()?.tx ?? this;
  }

  /** The tenant id of the current request context, if any. */
  get currentTenantId(): string | undefined {
    return this.als.getStore()?.tenantId;
  }

  /**
   * `options` forwards Prisma's interactive-transaction settings. The 5s default
   * suits an HTTP handler but not bulk work (a 625-row import blows straight
   * through it), so background jobs pass a longer `timeout` — and should still
   * chunk, so no single transaction holds locks for long.
   */
  async runInTenantContext<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { timeout?: number; maxWait?: number },
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      // Parameterised set_config (local to this tx) — no SQL injection surface.
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return this.als.run({ tenantId, tx }, () => fn(tx));
    }, options);
  }
}
