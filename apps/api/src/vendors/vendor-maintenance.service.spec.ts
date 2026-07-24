import { describe, expect, it, vi } from 'vitest';

import { VendorMaintenanceService } from './vendor-maintenance.service';

/**
 * The nightly sweep must run the document-expiry scan and the scorecard refresh
 * for EVERY tenant, each in its own RLS context. (Before the audit fix these
 * methods existed but were never scheduled/called.)
 */
describe('VendorMaintenanceService.sweepAll', () => {
  it('runs expiry + scorecard refresh for every tenant in its own context', async () => {
    const runInTenantContext = vi.fn((_tid: string, fn: () => Promise<unknown>) => fn());
    const prisma = {
      tenant: {
        findMany: vi.fn().mockResolvedValue([{ id: 't1' }, { id: 't2' }]),
      },
      runInTenantContext,
    } as never;
    const expireCheck = vi
      .fn()
      .mockResolvedValue({ warned: 1, expired: 2, suspended: 1 });
    const refreshAll = vi.fn().mockResolvedValue({ updated: 3 });
    const documents = { expireCheck } as never;
    const scorecards = { refreshAll } as never;
    const config = { get: vi.fn() } as never;
    const logger = { setContext: vi.fn(), error: vi.fn() } as never;

    const svc = new VendorMaintenanceService(
      config,
      prisma,
      documents,
      scorecards,
      logger,
    );
    const res = await svc.sweepAll();

    expect(expireCheck).toHaveBeenCalledTimes(2);
    expect(expireCheck).toHaveBeenCalledWith('t1');
    expect(expireCheck).toHaveBeenCalledWith('t2');
    expect(refreshAll).toHaveBeenCalledTimes(2);
    expect(runInTenantContext).toHaveBeenCalledWith('t1', expect.any(Function));
    // Aggregated across both tenants.
    expect(res).toEqual({ tenants: 2, expired: 4, suspended: 2 });
  });
});
