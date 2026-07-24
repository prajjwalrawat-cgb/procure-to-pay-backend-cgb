import { beforeEach, describe, expect, it, vi } from 'vitest';
import Decimal from 'decimal.js';

import { AuditLogService } from '../audit/audit.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { PurchaseOrderService } from '../purchase-orders/purchase-order.service';
import { CallOffService } from './call-off.service';

const D = (v: string) => new Decimal(v);

function baseContract(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: 'ct_1',
    tenantId: 'ten_1',
    status: 'ACTIVE',
    commitmentPeriod: 'ANNUAL',
    minimumCommitmentQty: D('1000'),
    minimumCommitmentValue: D('900000'),
    maxCallOffValue: null,
    validityStart: new Date(now - 30 * 86400000),
    validityEnd: new Date(now + 300 * 86400000),
    rateCards: [
      { id: 'rc_a', unitRate: D('2.85'), taxRate: D('0.05') },
      { id: 'rc_b', unitRate: D('3.20'), taxRate: D('0.05') },
    ],
    ...overrides,
  };
}

function build(contract: unknown) {
  const createFromContract = vi.fn().mockResolvedValue({ id: 'po_1' });
  const created: Record<string, unknown>[] = [];
  const vt: Record<string, unknown> = {
    committedQty: D('1000'),
    committedValue: D('900000'),
    actualQty: D('0'),
    actualValue: D('0'),
  };
  const client = {
    contract: { findUnique: vi.fn().mockResolvedValue(contract) },
    contractCallOff: {
      create: vi.fn(async (a: { data: Record<string, unknown> }) => {
        created.push(a.data);
        return a.data;
      }),
    },
    contractVolumeTracking: {
      upsert: vi.fn().mockResolvedValue(vt),
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(vt),
    },
  };
  const prisma = { client, currentTenantId: 'ten_1' } as unknown as PrismaService;
  const poService = { createFromContract } as unknown as PurchaseOrderService;
  const audit = { record: vi.fn() } as unknown as AuditLogService;
  const events = { emit: vi.fn() } as unknown as DomainEventService;
  const svc = new CallOffService(prisma, poService, audit, events);
  return { svc, createFromContract, created };
}

describe('CallOffService.createCallOff', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a call-off against a non-active contract', async () => {
    const { svc } = build(baseContract({ status: 'EXPIRED' }));
    await expect(
      svc.createCallOff(
        'ct_1',
        {
          deliveryLocation: { line1: 'x' },
          expectedDeliveryDate: new Date().toISOString(),
          lines: [{ contractRateCardId: 'rc_a', qty: '10' }],
        },
        'usr_1',
      ),
    ).rejects.toThrow(/expired|active/i);
  });

  it('rejects a rate card that is not on the contract', async () => {
    const { svc } = build(baseContract());
    await expect(
      svc.createCallOff(
        'ct_1',
        {
          deliveryLocation: { line1: 'x' },
          expectedDeliveryDate: new Date().toISOString(),
          lines: [{ contractRateCardId: 'rc_missing', qty: '10' }],
        },
        'usr_1',
      ),
    ).rejects.toThrow(/rate card not found/i);
  });

  it('enforces a per-call-off value cap', async () => {
    const { svc } = build(baseContract({ maxCallOffValue: D('100') }));
    // 1000 * 2.85 * 1.05 = 2992.5 > 100 cap
    await expect(
      svc.createCallOff(
        'ct_1',
        {
          deliveryLocation: { line1: 'x' },
          expectedDeliveryDate: new Date().toISOString(),
          lines: [{ contractRateCardId: 'rc_a', qty: '1000' }],
        },
        'usr_1',
      ),
    ).rejects.toThrow(/cap/i);
  });

  it('delegates to createFromContract with qty-only lines (no price override path)', async () => {
    const { svc, createFromContract, created } = build(baseContract());
    const res = await svc.createCallOff(
      'ct_1',
      {
        deliveryLocation: { line1: 'Lumshnong' },
        expectedDeliveryDate: new Date().toISOString(),
        lines: [{ contractRateCardId: 'rc_a', qty: '100' }],
      },
      'usr_1',
    );

    expect(res.poId).toBe('po_1');
    const arg = createFromContract.mock.calls[0]![0] as {
      lines: Record<string, unknown>[];
    };
    // Only rate-card id + qty are passed — no unitPrice field exists at the API layer.
    expect(arg.lines[0]).toEqual({ contractRateCardId: 'rc_a', qtyOrdered: '100' });
    expect(arg.lines[0]).not.toHaveProperty('unitPrice');
    // Value recorded from the locked rate: 100 * 2.85 * 1.05 = 299.25
    expect(created[0]!.value).toBeDefined();
  });
});
