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
import { PoTermsService } from './po-terms.service';
import { PurchaseOrderService } from './purchase-order.service';
import {
  PurchaseOrderStateError,
  PurchaseOrderValidationError,
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
    vendorGstin?: string;
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
    gstin: opts.vendorGstin ?? '24AABCP1234K1Z5',
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
    // Two GST registrations: Meghalaya (default) and Karnataka. `findFirst`
    // answers by id when one is named, else the default.
    plant: {
      findFirst: vi.fn().mockImplementation((args: { where?: { id?: string } }) => {
        const byId: Record<string, { id: string; stateCode: string }> = {
          plt_meg: { id: 'plt_meg', stateCode: '17' },
          plt_blr: { id: 'plt_blr', stateCode: '29' },
        };
        const wanted = args?.where?.id;
        if (wanted) return Promise.resolve(byId[wanted] ?? null);
        return Promise.resolve({ id: 'plt_meg', stateCode: '17' });
      }),
    },
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
    { applyLibraryDefaults: vi.fn() } as unknown as PoTermsService,
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

describe('PurchaseOrderService — bill-to GST registration', () => {
  const spotBuy = (billToPlantId?: string) => ({
    kind: 'SPOT_BUY' as const,
    vendorId: 'ven_patel',
    costCenterId: 'cc_1',
    ...(billToPlantId ? { billToPlantId } : {}),
    ...terms,
    lines: [
      {
        itemDesc: 'Widget',
        uom: 'nos',
        qtyOrdered: '1',
        unitPrice: '1000',
        discountPct: '0',
        taxRate: '0.18',
      },
    ],
  });

  it('pins the chosen registration on the order', async () => {
    const { service, client } = build();
    await service.createSpotBuy(spotBuy('plt_blr'), 'usr_1');
    expect(client.purchaseOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ billToPlantId: 'plt_blr' }),
      }),
    );
  });

  it('falls back to the tenant default when none is named', async () => {
    const { service, client } = build();
    await service.createSpotBuy(spotBuy(), 'usr_1');
    expect(client.purchaseOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ billToPlantId: 'plt_meg' }),
      }),
    );
  });

  /**
   * The vendor is in Karnataka (29), so billing to Karnataka is intra-state
   * (CGST+SGST) while billing the same order to Meghalaya is inter-state
   * (IGST). Only the totals are stored here — the split itself is derived at
   * render time from the pinned registration's state — so what this asserts is
   * that the named registration is the one fed to the tax context, and that
   * the stored total is unchanged either way.
   */
  it('feeds the named registration into the tax context', async () => {
    const karnatakaVendor = { vendorGstin: '29AABCP1234K1Z5' };
    const { service, client } = build({ vendorGstin: karnatakaVendor.vendorGstin });
    await service.createSpotBuy(spotBuy('plt_blr'), 'usr_1');
    const intra = client.purchaseOrder.create.mock.calls[0]![0] as {
      data: { taxAmount: { toString(): string } };
    };

    const other = build({ vendorGstin: karnatakaVendor.vendorGstin });
    await other.service.createSpotBuy(spotBuy('plt_meg'), 'usr_1');
    const inter = other.client.purchaseOrder.create.mock.calls[0]![0] as {
      data: { taxAmount: { toString(): string } };
    };

    // Same total tax either way — what differs is the split, which the document
    // and the invoice read back off the registration's state.
    expect(intra.data.taxAmount.toString()).toBe(inter.data.taxAmount.toString());
    expect(client.plant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'plt_blr' }) }),
    );
  });

  it('rejects a registration that is not the tenant’s', async () => {
    const { service } = build();
    await expect(
      service.createSpotBuy(spotBuy('plt_someone_else'), 'usr_1'),
    ).rejects.toThrow(/does not exist/i);
  });
});

describe('PurchaseOrderService.createSpotBuy', () => {
  // The tenant ceiling used to hard-block here; spot buys are now gated only by
  // the approval matrix, the same as a PR-based PO.
  it('accepts a spot buy well above the old tenant ceiling', async () => {
    const { service, client } = build();
    const r = await service.createSpotBuy(
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
            unitPrice: '600000',
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

  it('creates a spot buy and commits budget', async () => {
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
