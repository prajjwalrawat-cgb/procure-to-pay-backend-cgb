import { describe, expect, it } from 'vitest';

import { PrismaService } from '../prisma/prisma.service';
import { MsmeComplianceService } from './msme-compliance.service';

function build(rows: unknown[], rbiPct = '6.5') {
  const client = {
    tenantComplianceConfig: {
      findFirst: () => Promise.resolve({ rbiReferenceRatePct: rbiPct }),
    },
    $queryRawUnsafe: () => Promise.resolve(rows),
  };
  const prisma = { client } as unknown as PrismaService;
  return new MsmeComplianceService(prisma);
}

const row = (net: string, daysLate: number, daysOut = daysLate + 45) => ({
  id: `inv_${net}`,
  number: `INV-${net}`,
  vendorId: 'v1',
  vendorName: 'Patel Engineering',
  invoiceDate: new Date('2026-01-01T00:00:00Z'),
  msmeDueDate: new Date('2026-02-15T00:00:00Z'),
  netAmount: net,
  daysOutstanding: daysOut,
  daysLate,
});

describe('MsmeComplianceService.getExposureDetail — interest = net × RBI×3 × daysLate / 365', () => {
  it('scenario 1: ₹10,00,000 @ 30 days late', async () => {
    const svc = build([row('1000000', 30)]);
    const res = await svc.getExposureDetail('BREACH_45_PLUS');
    // 1000000 × 0.195 × 30 / 365 = 16027.3973
    expect(res.rows[0].interestIfBreached).toBe('16027.3973');
    expect(res.rbiReferenceRatePct).toBe('6.5000');
    expect(res.interestMultiplier).toBe(3);
  });

  it('scenario 2: ₹5,00,000 @ 100 days late', async () => {
    const svc = build([row('500000', 100)]);
    const res = await svc.getExposureDetail('BREACH_45_PLUS');
    // 500000 × 0.195 × 100 / 365 = 26712.3288
    expect(res.rows[0].interestIfBreached).toBe('26712.3288');
  });

  it('scenario 3: ₹20,00,000 @ 5 days late', async () => {
    const svc = build([row('2000000', 5)]);
    const res = await svc.getExposureDetail('BREACH_45_PLUS');
    // 2000000 × 0.195 × 5 / 365 = 5342.4658
    expect(res.rows[0].interestIfBreached).toBe('5342.4658');
  });

  it('aggregates exposure + interest across rows and reflects tenant RBI rate', async () => {
    const svc = build([row('1000000', 30), row('2000000', 5)], '7.0');
    const res = await svc.getExposureDetail('BREACH_45_PLUS');
    expect(res.totalExposure).toBe('3000000.0000');
    // 7% rate: 1e6×0.21×30/365 + 2e6×0.21×5/365
    expect(res.rbiReferenceRatePct).toBe('7.0000');
    expect(Number(res.totalInterest)).toBeGreaterThan(0);
  });

  it('approaching bucket (daysLate 0) accrues no interest', async () => {
    const svc = build([{ ...row('1000000', 0, 35) }]);
    const res = await svc.getExposureDetail('APPROACHING_30_44');
    expect(res.rows[0].interestIfBreached).toBe('0.0000');
  });
});

describe('MsmeComplianceService.getAgingDashboard — open MSME exposure', () => {
  it('excludes rejected invoices and counts only the unpaid balance of part-paid ones', async () => {
    const sqls: string[] = [];
    const client = {
      tenantComplianceConfig: { findFirst: () => Promise.resolve(null) },
      $queryRawUnsafe: (sql: string) => {
        sqls.push(sql);
        return Promise.resolve(
          sql.includes('bucket')
            ? [{ bucket: 'BREACH_45_PLUS', cnt: 2, exposure: '1500', avg_days: 50.4 }]
            : [{ msme: '100', total: '400' }],
        );
      },
    };
    const svc = new MsmeComplianceService({ client } as unknown as PrismaService);
    const res = await svc.getAgingDashboard();

    const bucketSql = sqls[0]!;
    expect(bucketSql).toContain(`i.status NOT IN ('PAID','REJECTED')`);
    expect(bucketSql).toContain(`WHEN i.status = 'PARTIALLY_PAID'`);
    expect(bucketSql).toContain('i."grossAmount" - i.paid_amount');
    // Response shape unchanged.
    expect(res.buckets.map((b) => b.bucket)).toEqual(['SAFE_0_29', 'APPROACHING_30_44', 'BREACH_45_PLUS']);
    expect(res.buckets[2]).toEqual({
      bucket: 'BREACH_45_PLUS',
      invoiceCount: 2,
      totalExposure: '1500.0000',
      avgDays: 50,
    });
    expect(res.msmeSpendPct).toBe(25);
  });

  it('drill-down uses the same open-invoice filter and balance as the dashboard', async () => {
    const sqls: string[] = [];
    const client = {
      tenantComplianceConfig: { findFirst: () => Promise.resolve({ rbiReferenceRatePct: '6.5' }) },
      $queryRawUnsafe: (sql: string) => {
        sqls.push(sql);
        return Promise.resolve([]);
      },
    };
    await new MsmeComplianceService({ client } as unknown as PrismaService).getExposureDetail('SAFE_0_29');
    expect(sqls[0]).toContain(`i.status NOT IN ('PAID','REJECTED')`);
    expect(sqls[0]).toContain(`WHEN i.status = 'PARTIALLY_PAID'`);
  });
});
