import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import type { AnalyticsDailyService } from './analytics-daily.service';
import { AnalyticsInsightsService } from './analytics-insights.service';

const TENANT = '00000000-0000-0000-0000-00000000000a';
const NOW = new Date('2026-09-21T09:00:00Z');

function build(raw: (sql: string) => unknown[], extra: Record<string, unknown> = {}) {
  const client = {
    $queryRawUnsafe: vi.fn((sql: string) => Promise.resolve(raw(sql))),
    ...extra,
  };
  const prisma = { client, currentTenantId: TENANT } as unknown as PrismaService;
  const daily = {
    ensureFresh: vi.fn().mockResolvedValue(new Date('2026-09-21T08:59:00Z')),
    msmeScoreSeries: vi.fn().mockResolvedValue([{ day: '2026-09-21', score: 87.5, total: 8, onTime: 7 }]),
  } as unknown as AnalyticsDailyService;
  return { svc: new AnalyticsInsightsService(prisma, daily), client, daily };
}

describe('AnalyticsInsightsService.getOverview', () => {
  it('refreshes the rollup on read and maps the KPI row', async () => {
    const { svc, daily } = build(() => [
      { spend: '123456.5', pos_issued: 9, invoices_processed: 14, active_vendors: 31, median_days: 6.345 },
    ]);
    const res = await svc.getOverview({ period: 'LAST_12M' }, NOW);
    expect(daily.ensureFresh).toHaveBeenCalledWith(TENANT);
    expect(res).toEqual({
      asOf: '2026-09-21T08:59:00.000Z',
      spendUnderManagement: '123456.5000',
      posIssued: 9,
      invoicesProcessed: 14,
      activeVendors: 31,
      avgInvoiceToPayDays: 6.3,
      msmeComplianceScore: 87.5,
    });
  });

  it('median is null when nothing was paid in the period', async () => {
    const { svc } = build(() => [
      { spend: '0', pos_issued: 0, invoices_processed: 0, active_vendors: 0, median_days: null },
    ]);
    expect((await svc.getOverview({ period: 'YTD' }, NOW)).avgInvoiceToPayDays).toBeNull();
  });
});

describe('AnalyticsInsightsService.getSpendSavings', () => {
  it('savings %, top-5 concentration, maverick share, awards', async () => {
    const vendorNets = ['500', '200', '100', '100', '50', '50']; // total 1000, top5 950
    const { svc } = build(() => [{ total: '2000', maverick: '500' }], {
      savingsLedgerEntry: {
        aggregate: vi.fn().mockResolvedValue({
          _sum: { savingsAmount: '150', baselineValue: '1500' },
          _count: { _all: 3 },
        }),
      },
      analyticsVendorMonthly: {
        groupBy: vi
          .fn()
          .mockResolvedValue(vendorNets.map((n, i) => ({ vendorId: `v${i}`, _sum: { netSpend: n } }))),
      },
      award: { count: vi.fn().mockResolvedValue(2) },
    });
    const res = await svc.getSpendSavings({ period: 'LAST_12M' }, NOW);
    expect(res).toEqual({
      savingsRealized: { amount: '150.0000', pct: 10, count: 3 },
      top5Concentration: 95,
      maverick: { amount: '500.0000', pct: 25 },
      rfqsAwarded: 2,
    });
  });

  it('shares are null when there is no spend / no PO value', async () => {
    const { svc } = build(() => [{ total: '0', maverick: '0' }], {
      savingsLedgerEntry: {
        aggregate: vi.fn().mockResolvedValue({ _sum: { savingsAmount: null, baselineValue: null }, _count: { _all: 0 } }),
      },
      analyticsVendorMonthly: { groupBy: vi.fn().mockResolvedValue([]) },
      award: { count: vi.fn().mockResolvedValue(0) },
    });
    const res = await svc.getSpendSavings({ period: 'LAST_12M' }, NOW);
    expect(res.top5Concentration).toBeNull();
    expect(res.maverick.pct).toBeNull();
    expect(res.savingsRealized.pct).toBeNull();
  });
});

describe('AnalyticsInsightsService.getVelocity', () => {
  it('maps median/P90 per stage, queue depth and the slowest step', async () => {
    const { svc } = build((sql) => {
      if (sql.includes('first_po')) return [{ median: 2.04, p90: 5.55, n: 12 }];
      if (sql.includes('"GoodsReceiptNote"')) return [{ median: null, p90: null, n: 0 }];
      if (sql.includes('approvals')) return [{ approvals: 4, grns: 6, runs: 1 }];
      if (sql.includes('mode()')) {
        return [{ document_type: 'PURCHASE_ORDER', step_no: 2, step_name: 'Plant Head', median_hours: 30.26, n: 5 }];
      }
      return [{ median: 7, p90: 12, n: 3 }];
    });
    const res = await svc.getVelocity({ period: 'LAST_12M' }, NOW);
    expect(res.stages).toEqual([
      { key: 'req_to_po', label: 'Requisition → PO', medianDays: 2, p90Days: 5.6, n: 12 },
      { key: 'po_to_grn', label: 'PO → Goods receipt', medianDays: null, p90Days: null, n: 0 },
      { key: 'invoice_to_payment', label: 'Invoice → Payment', medianDays: 7, p90Days: 12, n: 3 },
    ]);
    expect(res.queue).toEqual({ pendingApprovals: 4, pendingGrns: 6, pendingPaymentRuns: 1 });
    expect(res.slowestStep).toEqual({
      documentType: 'PURCHASE_ORDER',
      stepNo: 2,
      stepName: 'Plant Head',
      medianHours: 30.3,
      n: 5,
    });
  });
});

describe('AnalyticsInsightsService.getMsmeCompliance', () => {
  it('outstanding = gross − paid, excludes rejected/paid, buckets by age, 5 most overdue', async () => {
    const { svc, client } = build((sql) => {
      if (sql.includes('LIMIT 5')) {
        return [{ id: 'inv_1', number: 'INV-1', vendor_name: 'Patel Eng', outstanding: '4000', days_overdue: 20 }];
      }
      return [
        {
          total: '10000', overdue: '4000', overdue_cnt: 1, approaching_cnt: 2,
          b0: '3000', c0: 2, b30: '3000', c30: 1, b45: '0', c45: 0, b60: '4000', c60: 1,
        },
      ];
    });
    const res = await svc.getMsmeCompliance({ period: 'LAST_12M' }, NOW);
    const sql = client.$queryRawUnsafe.mock.calls[0]![0] as string;
    expect(sql).toContain(`i.status NOT IN ('REJECTED','PAID')`);
    expect(sql).toContain('i."grossAmount" - i.paid_amount');
    expect(res.totalExposure).toBe('10000.0000');
    expect(res.overdueExposure).toBe('4000.0000');
    expect(res.overdueCount).toBe(1);
    expect(res.approachingCount).toBe(2);
    expect(res.complianceScore).toBe(87.5);
    expect(res.buckets.map((b) => [b.key, b.amount, b.count])).toEqual([
      ['0_29', '3000.0000', 2],
      ['30_44', '3000.0000', 1],
      ['45_59', '0.0000', 0],
      ['60_plus', '4000.0000', 1],
    ]);
    expect(res.atRisk).toEqual([
      { invoiceId: 'inv_1', invoiceNumber: 'INV-1', vendorName: 'Patel Eng', outstanding: '4000.0000', daysOverdue: 20 },
    ]);
  });
});
