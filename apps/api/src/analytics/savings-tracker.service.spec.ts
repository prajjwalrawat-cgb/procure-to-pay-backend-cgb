import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import { AuditLogService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { SavingsTrackerService } from './savings-tracker.service';

function build(award: unknown, quotes: unknown[]) {
  const created: { data: Record<string, unknown> }[] = [];
  const client = {
    award: { findUnique: vi.fn().mockResolvedValue(award) },
    quote: { findMany: vi.fn().mockResolvedValue(quotes) },
    savingsLedgerEntry: {
      deleteMany: vi.fn().mockResolvedValue({}),
      create: vi.fn(async (a: { data: Record<string, unknown> }) => {
        created.push(a);
        return a.data;
      }),
    },
  };
  const prisma = { client, currentTenantId: 'ten_1' } as unknown as PrismaService;
  const routing = { onApproved: vi.fn() } as unknown as ApprovalRoutingService;
  const audit = { record: vi.fn() } as unknown as AuditLogService;
  const svc = new SavingsTrackerService(prisma, routing, audit);
  return { svc, created, client };
}

const line = (rfqLineId: string, price: string) => ({
  rfqLineId,
  unitPriceInrLanded: price,
  unitPriceNative: price,
});

describe('SavingsTrackerService.recordRfqSavings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('computes split-award hard savings: baseline (highest qualified) − awarded, per allocation', async () => {
    // Baseline = TATA @ 142000; awarded split BHILAI 16@128500 + CONTI 8@135000.
    const award = {
      id: 'aw_1',
      rfqId: 'rfq_1',
      recommendationBy: 'usr_harpreet',
      approvedAt: new Date('2026-06-25T00:00:00Z'),
      rfq: { category: 'Mechanical spares' },
      allocations: [
        { rfqLineId: 'rl1', qtyAllocated: '16', unitPrice: '128500' },
        { rfqLineId: 'rl1', qtyAllocated: '8', unitPrice: '135000' },
      ],
    };
    const quotes = [
      { lines: [line('rl1', '142000')] }, // TATA (baseline, not awarded)
      { lines: [line('rl1', '128500')] }, // BHILAI
      { lines: [line('rl1', '135000')] }, // CONTI
    ];
    const { svc, created } = build(award, quotes);
    await svc.recordRfqSavings('aw_1', 'usr_harpreet');

    expect(created).toHaveLength(1);
    const d = created[0].data;
    expect(d.initiativeType).toBe('HARD_RFQ');
    expect(d.sourceType).toBe('RFQ_AWARD');
    expect(d.baselineValue).toBe('3408000.0000'); // 142000 × 24
    expect(d.awardedValue).toBe('3136000.0000'); // 128500×16 + 135000×8
    expect(d.savingsAmount).toBe('272000.0000'); // (142000−128500)×16 + (142000−135000)×8
    expect(d.savingsPct).toBe('7.9812');
    expect(d.buyerId).toBe('usr_harpreet');
    expect(d.periodMonth).toBe('2026-06');
  });

  it('never records negative savings (awarded above baseline floors at 0)', async () => {
    const award = {
      id: 'aw_2',
      rfqId: 'rfq_2',
      recommendationBy: 'u',
      approvedAt: new Date('2026-06-25T00:00:00Z'),
      rfq: { category: null },
      allocations: [{ rfqLineId: 'rl1', qtyAllocated: '10', unitPrice: '150000' }],
    };
    const quotes = [{ lines: [line('rl1', '140000')] }];
    const { svc, created } = build(award, quotes);
    await svc.recordRfqSavings('aw_2', 'u');
    expect(created[0].data.savingsAmount).toBe('0.0000');
  });

  it('does nothing for an award with no allocations', async () => {
    const { svc, created } = build({ id: 'x', allocations: [] }, []);
    await svc.recordRfqSavings('x', 'u');
    expect(created).toHaveLength(0);
  });
});
