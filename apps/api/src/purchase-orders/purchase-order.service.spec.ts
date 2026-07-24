import Decimal from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import { NotificationService } from '../approvals/notification.service';
import { AuditLogService } from '../audit/audit.service';
import { BudgetService } from '../budgets/budget.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { StorageService } from '../common/storage/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { PoDocumentService } from './po-document.service';
import { PurchaseOrderService } from './purchase-order.service';
import {
  PurchaseOrderStateError,
  PurchaseOrderValidationError,
  SpotBuyCeilingError,
  VendorNotEligibleError,
} from './purchase-order.errors';

function prLine(id: string, qty: string, issued: string) {
  return {
    id,
    qty: new Decimal(qty),
    qtyIssued: new Decimal(issued),
    unitPrice: new Decimal('128500'),
    taxRate: new Decimal('0.18'),
    itemId: 'item_1',
    itemDesc: 'Forged steel grinding balls',
    hsnCode: '7325',
    uom: 'tonne',
  };
}

function build(
  opts: {
    prStatus?: string;
    vendorStatus?: string;
    vendorLifecycleStatus?: string;
    bankVerified?: boolean;
    prLines?: ReturnType<typeof prLine>[];
  } = {},
) {
  const requisition = {
    id: 'pr_1',
    status: opts.prStatus ?? 'APPROVED',
    currency: 'INR',
    number: 'PR-1141',
    plant: { stateCode: '17' },
    lines: opts.prLines ?? [prLine('prl_1', '12', '0')],
    purchaseOrders: [],
  };
  const vendor = {
    id: 'ven_patel',
    name: 'Patel Engineering',
    code: 'V-PATEL',
    gstin: '24AABCP1234K1Z5',
    status: opts.vendorStatus ?? 'ACTIVE',
    lifecycleStatus: opts.vendorLifecycleStatus ?? 'ACTIVE',
    banks: [{ isVerified: opts.bankVerified ?? true }],
  };
  const client = {
    requisition: { findUnique: vi.fn().mockResolvedValue(requisition) },
    vendor: { findUnique: vi.fn().mockResolvedValue(vendor) },
    purchaseOrder: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'po_new' }),
    },
    requisitionLine: { update: vi.fn().mockResolvedValue({}) },
    tenant: {
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue({ spotBuyCeiling: new Decimal('50000') }),
    },
    plant: { findFirst: vi.fn().mockResolvedValue({ stateCode: '17' }) },
    budgetCommitment: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  const prisma = { client, currentTenantId: 'ten_1' } as unknown as PrismaService;
  const service = new PurchaseOrderService(
    prisma,
    { record: vi.fn() } as unknown as AuditLogService,
    { emit: vi.fn() } as unknown as DomainEventService,
    { submit: vi.fn(), decide: vi.fn() } as unknown as ApprovalRoutingService,
    {
      commitSpotBuy: vi.fn(),
      transferToPo: vi.fn(),
      releaseForPo: vi.fn(),
    } as unknown as BudgetService,
    { put: vi.fn() } as unknown as StorageService,
    { generate: vi.fn() } as unknown as PoDocumentService,
    { notify: vi.fn() } as unknown as NotificationService,
  );
  return { service, client };
}

const terms = {
  deliveryTerms: 'DDP' as const,
  paymentTerms: { kind: 'MSME_45' as const, days: 45 },
  expectedDeliveryDate: '2026-08-01T00:00:00.000Z',
};

describe('PurchaseOrderService.createFromRequisition', () => {
  it('creates a PO for a full-quantity single line', async () => {
    const { service, client } = build();
    const r = await service.createFromRequisition(
      {
        kind: 'FROM_PR',
        requisitionId: 'pr_1',
        vendorId: 'ven_patel',
        lines: [{ prLineId: 'prl_1', qtyOrdered: '12' }],
        ...terms,
      },
      'usr_1',
    );
    expect(r.id).toMatch(/^po_/);
    expect(client.purchaseOrder.create).toHaveBeenCalledOnce();
    expect(client.requisitionLine.update).toHaveBeenCalledOnce();
  });

  it('supports a partial split-award quantity', async () => {
    const { service, client } = build();
    await service.createFromRequisition(
      {
        kind: 'FROM_PR',
        requisitionId: 'pr_1',
        vendorId: 'ven_patel',
        lines: [{ prLineId: 'prl_1', qtyOrdered: '8' }],
        ...terms,
      },
      'usr_1',
    );
    const arg = client.requisitionLine.update.mock.calls[0]![0] as {
      data: { qtyIssued: { increment: Decimal } };
    };
    expect(arg.data.qtyIssued.increment.toString()).toBe('8');
  });

  it('rejects qty greater than the PR line remaining', async () => {
    const { service } = build({ prLines: [prLine('prl_1', '12', '10')] });
    await expect(
      service.createFromRequisition(
        {
          kind: 'FROM_PR',
          requisitionId: 'pr_1',
          vendorId: 'ven_patel',
          lines: [{ prLineId: 'prl_1', qtyOrdered: '5' }],
          ...terms,
        },
        'usr_1',
      ),
    ).rejects.toBeInstanceOf(PurchaseOrderValidationError);
  });

  it('rejects a non-positive quantity', async () => {
    const { service } = build();
    await expect(
      service.createFromRequisition(
        {
          kind: 'FROM_PR',
          requisitionId: 'pr_1',
          vendorId: 'ven_patel',
          lines: [{ prLineId: 'prl_1', qtyOrdered: '0' }],
          ...terms,
        },
        'usr_1',
      ),
    ).rejects.toBeInstanceOf(PurchaseOrderValidationError);
  });

  it('rejects a duplicate PR line reference within one PO', async () => {
    const { service } = build();
    await expect(
      service.createFromRequisition(
        {
          kind: 'FROM_PR',
          requisitionId: 'pr_1',
          vendorId: 'ven_patel',
          lines: [
            { prLineId: 'prl_1', qtyOrdered: '4' },
            { prLineId: 'prl_1', qtyOrdered: '4' },
          ],
          ...terms,
        },
        'usr_1',
      ),
    ).rejects.toBeInstanceOf(PurchaseOrderValidationError);
  });

  it('rejects an unknown PR line', async () => {
    const { service } = build();
    await expect(
      service.createFromRequisition(
        {
          kind: 'FROM_PR',
          requisitionId: 'pr_1',
          vendorId: 'ven_patel',
          lines: [{ prLineId: 'nope', qtyOrdered: '1' }],
          ...terms,
        },
        'usr_1',
      ),
    ).rejects.toBeInstanceOf(PurchaseOrderValidationError);
  });

  it('rejects a vendor whose lifecycle_status is not ACTIVE (even if legacy status=ACTIVE)', async () => {
    // status stays ACTIVE; only lifecycle_status is SUSPENDED — the guard must
    // read the canonical lifecycle field (audit I6).
    const { service } = build({
      vendorStatus: 'ACTIVE',
      vendorLifecycleStatus: 'SUSPENDED',
    });
    await expect(
      service.createFromRequisition(
        {
          kind: 'FROM_PR',
          requisitionId: 'pr_1',
          vendorId: 'ven_patel',
          lines: [{ prLineId: 'prl_1', qtyOrdered: '4' }],
          ...terms,
        },
        'usr_1',
      ),
    ).rejects.toBeInstanceOf(VendorNotEligibleError);
  });

  it('rejects a vendor with no verified bank', async () => {
    const { service } = build({ bankVerified: false });
    await expect(
      service.createFromRequisition(
        {
          kind: 'FROM_PR',
          requisitionId: 'pr_1',
          vendorId: 'ven_patel',
          lines: [{ prLineId: 'prl_1', qtyOrdered: '4' }],
          ...terms,
        },
        'usr_1',
      ),
    ).rejects.toBeInstanceOf(VendorNotEligibleError);
  });

  it('rejects conversion of a non-approved requisition', async () => {
    const { service } = build({ prStatus: 'DRAFT' });
    await expect(
      service.createFromRequisition(
        {
          kind: 'FROM_PR',
          requisitionId: 'pr_1',
          vendorId: 'ven_patel',
          lines: [{ prLineId: 'prl_1', qtyOrdered: '4' }],
          ...terms,
        },
        'usr_1',
      ),
    ).rejects.toBeInstanceOf(PurchaseOrderStateError);
  });
});

describe('PurchaseOrderService.createSpotBuy', () => {
  it('rejects a spot buy above the tenant ceiling', async () => {
    const { service } = build();
    await expect(
      service.createSpotBuy(
        {
          kind: 'SPOT_BUY',
          vendorId: 'ven_patel',
          costCenterId: 'cc_1',
          ...terms,
          lines: [
            {
              itemDesc: 'Big buy',
              uom: 'nos',
              qtyOrdered: '1',
              unitPrice: '60000',
              discountPct: '0',
              taxRate: '0.18',
            },
          ],
        },
        'usr_1',
      ),
    ).rejects.toBeInstanceOf(SpotBuyCeilingError);
  });

  it('accepts a spot buy under the ceiling and commits budget', async () => {
    const { service, client } = build();
    const r = await service.createSpotBuy(
      {
        kind: 'SPOT_BUY',
        vendorId: 'ven_patel',
        costCenterId: 'cc_1',
        ...terms,
        lines: [
          {
            itemDesc: 'Small buy',
            uom: 'nos',
            qtyOrdered: '1',
            unitPrice: '40000',
            discountPct: '0',
            taxRate: '0.18',
          },
        ],
      },
      'usr_1',
    );
    expect(r.id).toMatch(/^po_/);
    expect(client.purchaseOrder.create).toHaveBeenCalledOnce();
  });
});
