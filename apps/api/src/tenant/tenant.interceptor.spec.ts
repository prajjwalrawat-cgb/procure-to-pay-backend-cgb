import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { VendorOnboardingController } from '../vendors/vendor-onboarding.controller';
import { TenantInterceptor } from './tenant.interceptor';
import { TransactionTimeout } from './transaction-timeout.decorator';

class Routes {
  plain(): void {}

  @TransactionTimeout(90_000)
  slow(): void {}
}

function run(handler: () => void, user: { tenantId: string } | undefined) {
  const runInTenantContext = vi.fn(
    (_tenantId: string, fn: () => Promise<unknown>, _opts?: unknown) => fn(),
  );
  const interceptor = new TenantInterceptor(
    { runInTenantContext } as unknown as PrismaService,
    new Reflector(),
  );
  const context = {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handler,
    getClass: () => Routes,
  } as unknown as ExecutionContext;
  const next: CallHandler = { handle: () => of('done') };
  return { result: lastValueFrom(interceptor.intercept(context, next)), runInTenantContext };
}

describe('TenantInterceptor', () => {
  it("keeps Prisma's default transaction timeout on an ordinary route", async () => {
    const { result, runInTenantContext } = run(Routes.prototype.plain, { tenantId: 'ten_1' });
    await expect(result).resolves.toBe('done');
    expect(runInTenantContext).toHaveBeenCalledWith('ten_1', expect.any(Function), undefined);
  });

  it('passes a route-level @TransactionTimeout through to the transaction', async () => {
    const { result, runInTenantContext } = run(Routes.prototype.slow, { tenantId: 'ten_1' });
    await expect(result).resolves.toBe('done');
    expect(runInTenantContext).toHaveBeenCalledWith('ten_1', expect.any(Function), {
      timeout: 90_000,
    });
  });

  it('opens no transaction for a public route', async () => {
    const { result, runInTenantContext } = run(Routes.prototype.slow, undefined);
    await expect(result).resolves.toBe('done');
    expect(runInTenantContext).not.toHaveBeenCalled();
  });

  it('gives the vendor document upload room for the OCR call', () => {
    // The 500 this guards against: S3 + OCR outlived the 5s default, so the
    // document row was written into an already-closed transaction.
    const timeout = new Reflector().get<number>(
      'tenantTransactionTimeoutMs',
      VendorOnboardingController.prototype.uploadDocumentFile,
    );
    expect(timeout).toBeGreaterThan(60_000);
  });
});
