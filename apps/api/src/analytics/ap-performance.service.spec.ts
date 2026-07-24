import { describe, expect, it } from 'vitest';

import { PrismaService } from '../prisma/prisma.service';
import { ApPerformanceService } from './ap-performance.service';

interface Inv {
  id: string;
  status: string;
  exceptions: { exceptionType: string }[];
}

function build(invoices: Inv[], approvals: { documentId: string; decidedAt: Date }[]) {
  const base = new Date('2026-06-01T00:00:00Z');
  const fullInvoices = invoices.map((i) => ({
    ...i,
    receivedAt: base,
    paidAt: new Date('2026-06-03T00:00:00Z'),
    updatedAt: new Date('2026-06-03T00:00:00Z'),
  }));
  const client = {
    invoice: { findMany: () => Promise.resolve(fullInvoices) },
    approval: { findMany: () => Promise.resolve(approvals) },
    $queryRawUnsafe: () => Promise.resolve([{ cnt: 0 }]),
  };
  const prisma = { client } as unknown as PrismaService;
  return new ApPerformanceService(prisma);
}

describe('ApPerformanceService.getPerformance', () => {
  it('first-pass yield counts ZERO exceptions EVER (not zero currently-open); STP excludes any human approval', async () => {
    const invoices: Inv[] = [
      { id: 'i1', status: 'APPROVED', exceptions: [] }, // first-pass + straight-through (no approval row)
      { id: 'i2', status: 'PAID', exceptions: [{ exceptionType: 'RATE_VARIANCE' }] }, // exception (even if later resolved)
      { id: 'i3', status: 'APPROVED', exceptions: [] }, // first-pass but had a human approval → not STP
      { id: 'i4', status: 'RECEIVED', exceptions: [] }, // not yet approved
    ];
    const approvals = [{ documentId: 'i3', decidedAt: new Date('2026-06-02T00:00:00Z') }];
    const res = await build(invoices, approvals).getPerformance({ period: 'LAST_12M' });

    expect(res.invoicesTotal).toBe(4);
    // approvedTotal = i1,i2,i3 = 3; first-pass (0 exceptions) = i1,i3 = 2 → 66.7%
    expect(res.firstPassYieldPct).toBe(66.7);
    // exception rate over ALL invoices = i2 / 4 = 25%
    expect(res.exceptionRatePct).toBe(25);
    // straight-through = i1 (approved, 0 exceptions, no approval decision) / 4 = 25%
    expect(res.straightThroughPct).toBe(25);
    expect(res.exceptionBreakdown).toEqual([
      { exceptionType: 'RATE_VARIANCE', count: 1, pct: 100 },
    ]);
  });

  it('discount capture is null (honest) when no tenant uses early-payment discount terms', async () => {
    const res = await build(
      [{ id: 'i1', status: 'APPROVED', exceptions: [] }],
      [],
    ).getPerformance({
      period: 'LAST_12M',
    });
    expect(res.discountCapturePct).toBeNull();
  });

  it('a resolved exception still disqualifies first pass', async () => {
    // Only invoice had an exception (raised then resolved) → FPY 0%.
    const res = await build(
      [{ id: 'i1', status: 'APPROVED', exceptions: [{ exceptionType: 'QTY_VARIANCE' }] }],
      [],
    ).getPerformance({ period: 'LAST_12M' });
    expect(res.firstPassYieldPct).toBe(0);
    expect(res.straightThroughPct).toBe(0);
  });
});
