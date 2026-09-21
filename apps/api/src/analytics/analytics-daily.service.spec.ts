import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { AnalyticsDailyService, DAILY_FLOW_WINDOW_DAYS } from './analytics-daily.service';

const TENANT = '00000000-0000-0000-0000-00000000000a';

function build(opts: { refreshedAt?: Date | null; locked?: boolean; raw?: (sql: string) => unknown[] }) {
  const executed: { sql: string; args: unknown[] }[] = [];
  const client = {
    analyticsRefreshLog: {
      findFirst: vi
        .fn()
        .mockResolvedValue(opts.refreshedAt ? { refreshedAt: opts.refreshedAt } : null),
    },
    $queryRawUnsafe: vi.fn((sql: string) => {
      if (sql.includes('pg_try_advisory_xact_lock')) return Promise.resolve([{ locked: opts.locked ?? true }]);
      if (opts.raw) return Promise.resolve(opts.raw(sql));
      if (sql.includes('open_pos')) return Promise.resolve([{ open_pos: 3, in_flight: 5, active_vendors: 8 }]);
      return Promise.resolve([]);
    }),
    $executeRawUnsafe: vi.fn((sql: string, ...args: unknown[]) => {
      executed.push({ sql, args });
      return Promise.resolve(1);
    }),
  };
  const prisma = { client, currentTenantId: TENANT } as unknown as PrismaService;
  return { svc: new AnalyticsDailyService(prisma), client, executed };
}

describe('AnalyticsDailyService.ensureFresh (refresh on read)', () => {
  it('does nothing while the rollup is younger than 5 minutes', async () => {
    const at = new Date(Date.now() - 60_000);
    const { svc, executed } = build({ refreshedAt: at });
    expect(await svc.ensureFresh(TENANT)).toEqual(at);
    expect(executed).toHaveLength(0);
  });

  it('recomputes flows + snapshot and stamps the refresh log when stale', async () => {
    const { svc, executed } = build({ refreshedAt: new Date(Date.now() - 10 * 60_000) });
    await svc.ensureFresh(TENANT);
    const [flows, snapshot, stamp] = executed;
    expect(flows!.sql).toContain('INSERT INTO "AnalyticsDaily"');
    expect(flows!.sql).toContain('ON CONFLICT (tenant_id, day)');
    // Same status filter as the monthly spend refresh.
    expect(flows!.sql).toContain(`NOT IN ('REJECTED','RECEIVED','OCR_PENDING','OCR_DONE')`);
    expect((flows!.args[1] as string[]).length).toBe(DAILY_FLOW_WINDOW_DAYS);
    expect(flows!.args[0]).toBe(TENANT);
    expect(snapshot!.sql).toContain('UPDATE "AnalyticsDaily"');
    expect(snapshot!.args.slice(2, 5)).toEqual([3, 5, 8]);
    expect(snapshot!.args[5]).toBeNull(); // no MSME invoices fell due → null score
    expect(stamp!.sql).toContain('"AnalyticsRefreshLog"');
    expect(stamp!.args[2]).toBe('daily');
    expect(stamp!.args[4]).toBe('READ');
  });

  it('skips the recompute when another request holds the tenant lock', async () => {
    const { svc, executed } = build({ refreshedAt: null, locked: false });
    await svc.ensureFresh(TENANT);
    expect(executed).toHaveLength(0);
  });
});

describe('AnalyticsDailyService.msmeScoreSeries', () => {
  it('turns per-day on-time/total counts into a 0–100 score (null when nothing fell due)', async () => {
    const { svc } = build({
      raw: () => [
        { day: '2026-09-20', total: 0, on_time: 0 },
        { day: '2026-09-21', total: 4, on_time: 3 },
      ],
    });
    const s = await svc.msmeScoreSeries(
      TENANT,
      new Date('2026-09-20T00:00:00Z'),
      new Date('2026-09-21T00:00:00Z'),
    );
    expect(s).toEqual([
      { day: '2026-09-20', total: 0, onTime: 0, score: null },
      { day: '2026-09-21', total: 4, onTime: 3, score: 75 },
    ]);
  });
});
