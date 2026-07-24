import Decimal from 'decimal.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import { NotificationService } from '../approvals/notification.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { VendorNotEligibleError } from '../purchase-orders/purchase-order.errors';
import { PurchaseOrderService } from '../purchase-orders/purchase-order.service';
import { AwardService } from './award.service';
import { SourcingAuditService } from './sourcing-audit.service';

/**
 * I6 (audit) — a non-ACTIVE (suspended / still-onboarding) vendor must never
 * receive a PO. The guard reads the canonical lifecycle_status via
 * PurchaseOrderService.assertVendorEligible, at recommendation AND before the
 * award moves to terminal state (so a mid-flight suspension can't orphan
 * allocations).
 */
function build(overrides: {
  award?: unknown;
  rfq?: unknown;
  quotes?: unknown[];
  eligible?: boolean;
}) {
  const client = {
    award: {
      findUnique: vi.fn().mockResolvedValue(overrides.award ?? null),
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
    },
    rfq: {
      findUnique: vi.fn().mockResolvedValue(overrides.rfq ?? null),
      update: vi.fn().mockResolvedValue({}),
    },
    quote: { findMany: vi.fn().mockResolvedValue(overrides.quotes ?? []) },
    awardAllocation: { update: vi.fn().mockResolvedValue({}) },
  };
  const prisma = { client } as unknown as PrismaService;
  const audit = { award: vi.fn() } as unknown as SourcingAuditService;
  const events = { emit: vi.fn() } as unknown as DomainEventService;
  const routing = {
    onApproved: vi.fn(),
    submit: vi.fn(),
  } as unknown as ApprovalRoutingService;
  const notifications = {} as unknown as NotificationService;
  const assertVendorEligible = vi.fn(
    overrides.eligible === false
      ? () => Promise.reject(new VendorNotEligibleError('Vendor is not active.', {}))
      : () => Promise.resolve(),
  );
  const purchaseOrders = {
    assertVendorEligible,
  } as unknown as PurchaseOrderService;
  const service = new AwardService(
    prisma,
    audit,
    events,
    routing,
    notifications,
    purchaseOrders,
  );
  return { service, client, assertVendorEligible };
}

describe('AwardService — I6 vendor-eligibility guard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('onApproved refuses to advance to terminal state for an ineligible vendor (no orphaned allocations)', async () => {
    const { service, client, assertVendorEligible } = build({
      eligible: false,
      award: {
        id: 'aw_1',
        rfqId: 'rfq_1',
        allocations: [{ id: 'al_1', vendorId: 'ven_suspended' }],
        rfq: { lines: [] },
      },
    });

    await expect(service.onApproved('aw_1', 'usr_1')).rejects.toBeInstanceOf(
      VendorNotEligibleError,
    );
    expect(assertVendorEligible).toHaveBeenCalledWith('ven_suspended');
    // Terminal state never set → allocation cannot be left with a null po_id.
    expect(client.award.update).not.toHaveBeenCalled();
    expect(client.rfq.update).not.toHaveBeenCalled();
    expect(client.awardAllocation.update).not.toHaveBeenCalled();
  });

  it('recommendAward refuses to persist a recommendation for an ineligible vendor', async () => {
    const { service, client } = build({
      eligible: false,
      rfq: {
        id: 'rfq_1',
        tenantId: 'ten_1',
        status: 'COMMERCIAL_OPEN',
        lines: [
          {
            id: 'rl_1',
            itemId: 'item_1',
            qtyRequired: new Decimal(10),
            qtyMinSplit: new Decimal(0),
          },
        ],
      },
      quotes: [
        { id: 'q_1', vendorId: 'ven_suspended', totalCommercialValue: new Decimal(500) },
      ],
    });

    await expect(
      service.recommendAward(
        'rfq_1',
        {
          allocations: [
            { quoteId: 'q_1', rfqLineId: 'rl_1', qtyAllocated: '5', unitPrice: '100' },
          ],
        } as never,
        'usr_1',
      ),
    ).rejects.toBeInstanceOf(VendorNotEligibleError);
    expect(client.award.create).not.toHaveBeenCalled();
  });
});
