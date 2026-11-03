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
} from './purchase-order.errors';

type Hook = (id: string, actorId: string) => Promise<void>;

/** PO-0527 as issued: 5,000 keychains @ ₹7 and a die @ ₹3,400, 18% intra-state. */
function line(id: string, lineNo: number, desc: string, qty: string, price: string) {
  return {
    id,
    lineNo,
    itemDesc: desc,
    uom: 'NOS',
    prLineId: null as string | null,
    contractLineId: null as string | null,
    qtyOrdered: new Decimal(qty),
    qtyReceived: new Decimal('0'),
    unitPrice: new Decimal(price),
    discountPct: new Decimal('0'),
    taxRate: new Decimal('0.18'),
  };
}

function build(
  opts: {
    status?: string;
    received?: string;
    invoices?: number;
    pending?: number;
    approvedByOthers?: number;
  } = {},
) {
  const lines = [
    line('pol_key', 1, 'SILICONE KEYCHAINS', '5000', '7'),
    line('pol_die', 2, 'DIE COST', '1', '3400'),
  ];
  if (opts.received) lines[0]!.qtyReceived = new Decimal(opts.received);
  const po = {
    id: 'po_527',
    tenantId: 'ten_1',
    number: 'PO-0527',
    status: opts.status ?? 'ACKNOWLEDGED',
    vendorId: 'ven_rn',
    requisitionId: null,
    billToPlantId: 'plt_del',
    requisition: null,
    vendor: { gstin: '07ABIFR0413R1ZV' },
    lines,
  };
  let amendment: Record<string, unknown> | null = null;
  const client = {
    purchaseOrder: {
      findUnique: vi.fn().mockResolvedValue(po),
      update: vi.fn().mockResolvedValue({}),
    },
    purchaseOrderLine: { update: vi.fn().mockResolvedValue({}) },
    poAmendment: {
      count: vi
        .fn()
        .mockImplementation((args: { where: { status?: string } }) =>
          Promise.resolve(args.where.status ? (opts.pending ?? 0) : 0),
        ),
      create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
        amendment = args.data;
        return Promise.resolve(args.data);
      }),
      findUnique: vi.fn().mockImplementation(() => Promise.resolve(amendment)),
      update: vi.fn().mockResolvedValue({}),
    },
    invoice: { count: vi.fn().mockResolvedValue(opts.invoices ?? 0) },
    approval: { count: vi.fn().mockResolvedValue(opts.approvedByOthers ?? 1) },
    plant: { findFirst: vi.fn().mockResolvedValue({ id: 'plt_del', stateCode: '07' }) },
    requisitionLine: { update: vi.fn(), findUnique: vi.fn() },
    vendorContact: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const hooks = new Map<string, Hook>();
  const routing = {
    submit: vi.fn(),
    onApproved: vi.fn((type: string, hook: Hook) => hooks.set(type, hook)),
  };
  const budgets = { adjustForPoAmendment: vi.fn() };
  const pdf = { generate: vi.fn().mockResolvedValue({ buffer: Buffer.from(''), hash: 'h' }) };
  const prisma = { client, currentTenantId: 'ten_1' } as unknown as PrismaService;
  const service = new PurchaseOrderService(
    prisma,
    { record: vi.fn() } as unknown as AuditLogService,
    { emit: vi.fn() } as unknown as DomainEventService,
    routing as unknown as ApprovalRoutingService,
    budgets as unknown as BudgetService,
    { put: vi.fn().mockResolvedValue(undefined) } as unknown as StorageService,
    pdf as unknown as PoDocumentService,
    { notify: vi.fn() } as unknown as NotificationService,
    { applyLibraryDefaults: vi.fn() } as unknown as PoTermsService,
  );
  service.onModuleInit();
  const approve = (id: string) => hooks.get('PO_AMENDMENT')!(id, 'usr_finance');
  return { service, client, routing, budgets, pdf, approve };
}

/** The PI's die cost: ₹4,200 instead of ₹3,400. */
const dieCostFix = {
  reason: 'Die cost is ₹4,200 per PI 393',
  lines: [{ lineId: 'pol_die', qtyOrdered: '1', unitPrice: '4200' }],
};

describe('PurchaseOrderService.requestAmendment', () => {
  it('parks the change for approval without touching the PO', async () => {
    const { service, client, routing } = build();
    const r = await service.requestAmendment('po_527', dieCostFix, 'usr_buyer');

    expect(r.id).toMatch(/^pam_/);
    const data = client.poAmendment.create.mock.calls[0]![0].data;
    expect(data.beforeTotal.toString()).toBe('45312');
    expect(data.afterTotal.toString()).toBe('46256');
    expect(data.amendmentNo).toBe(1);
    expect(data.lineChanges).toEqual([
      expect.objectContaining({
        lineId: 'pol_die',
        before: { qtyOrdered: '1', unitPrice: '3400' },
        after: { qtyOrdered: '1.0000', unitPrice: '4200.0000' },
      }),
    ]);
    expect(routing.submit).toHaveBeenCalledWith('PO_AMENDMENT', r.id, 'usr_buyer');
    expect(client.purchaseOrderLine.update).not.toHaveBeenCalled();
    expect(client.purchaseOrder.update).not.toHaveBeenCalled();
  });

  it('refuses an amendment that changes nothing', async () => {
    const { service } = build();
    await expect(
      service.requestAmendment(
        'po_527',
        { reason: 'x', lines: [{ lineId: 'pol_die', qtyOrdered: '1', unitPrice: '3400' }] },
        'usr_buyer',
      ),
    ).rejects.toBeInstanceOf(PurchaseOrderValidationError);
  });

  it('refuses once goods are received', async () => {
    const { service } = build({ received: '100' });
    await expect(
      service.requestAmendment('po_527', dieCostFix, 'usr_buyer'),
    ).rejects.toBeInstanceOf(PurchaseOrderStateError);
  });

  it('refuses once the PO is invoiced', async () => {
    const { service } = build({ invoices: 1 });
    await expect(
      service.requestAmendment('po_527', dieCostFix, 'usr_buyer'),
    ).rejects.toBeInstanceOf(PurchaseOrderStateError);
  });

  it('refuses while another amendment awaits approval', async () => {
    const { service } = build({ pending: 1 });
    await expect(
      service.requestAmendment('po_527', dieCostFix, 'usr_buyer'),
    ).rejects.toBeInstanceOf(PurchaseOrderStateError);
  });

  it('refuses a draft PO — drafts are edited directly', async () => {
    const { service } = build({ status: 'DRAFT' });
    await expect(
      service.requestAmendment('po_527', dieCostFix, 'usr_buyer'),
    ).rejects.toBeInstanceOf(PurchaseOrderStateError);
  });
});

describe('PO amendment approval', () => {
  it('writes the change onto the PO and sends it back to the vendor', async () => {
    const { service, client, budgets, pdf, approve } = build();
    const { id } = await service.requestAmendment('po_527', dieCostFix, 'usr_buyer');
    await approve(id);

    expect(budgets.adjustForPoAmendment).toHaveBeenCalledWith(
      'po_527',
      '46256.0000',
      'usr_finance',
    );
    const lineUpdates = client.purchaseOrderLine.update.mock.calls.map((c) => c[0]);
    const die = lineUpdates.find((u) => u.where.id === 'pol_die')!.data;
    expect(die.unitPrice.toString()).toBe('4200');
    expect(die.lineTotal.toString()).toBe('4956');
    const key = lineUpdates.find((u) => u.where.id === 'pol_key')!.data;
    expect(key.lineTotal.toString()).toBe('41300');

    const poUpdate = client.purchaseOrder.update.mock.calls[0]![0].data;
    expect(poUpdate.totalAmount.toString()).toBe('46256');
    expect(poUpdate.amendmentNo).toBe(1);
    // The vendor acknowledged the old price, so they acknowledge again.
    expect(poUpdate).toMatchObject({ status: 'ISSUED', acknowledgedAt: null });
    expect(pdf.generate).toHaveBeenCalledWith('po_527');
  });

  it('refuses when no one but the requester approved it', async () => {
    const { service, client, approve } = build({ approvedByOthers: 0 });
    const { id } = await service.requestAmendment('po_527', dieCostFix, 'usr_buyer');
    await expect(approve(id)).rejects.toBeInstanceOf(PurchaseOrderStateError);
    expect(client.purchaseOrderLine.update).not.toHaveBeenCalled();
  });
});
