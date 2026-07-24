import Decimal from 'decimal.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditLogService } from '../audit/audit.service';
import type { DomainEventService } from '../common/events/domain-event.service';
import type { MatchService } from '../invoices/match.service';
import type { EwayBillValidationService } from '../compliance/eway-validation.service';
import type { PrismaService } from '../prisma/prisma.service';
import { GrnService } from './grn.service';
import { GrnStateError, OverReceiptError } from './grn.errors';
import { InventoryValuationService } from './inventory-valuation.service';
import { QcParameterEvaluator } from './qc-parameter-evaluator';
import type { RmaService } from './rma.service';
import { SamplingPlanService } from './sampling-plan.service';
import type { StockLedgerService } from './stock-ledger.service';

const D = (v: string) =>
  new Decimal(v) as unknown as import('@procureflow/db').Prisma.Decimal;

type MockClient = Record<string, Record<string, ReturnType<typeof vi.fn>>>;

function makePo(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'po_1',
    tenantId: 'ten_1',
    number: 'PO-0493',
    vendorId: 'ven_1',
    status,
    requisition: { plantId: 'plt_1' },
    lines: [
      {
        id: 'pol_1',
        poId: 'po_1',
        itemId: 'item_1',
        itemDesc: 'Forged steel grinding balls 25mm',
        uom: 'tonne',
        qtyOrdered: D('8'),
        qtyReceived: D('0'),
        unitPrice: D('128500'),
        item: { requiresQc: true, stockGlAccount: '1400', qcParameters: {} },
      },
    ],
    ...overrides,
  };
}

function buildService(client: MockClient): {
  service: GrnService;
  client: MockClient;
  audit: { record: ReturnType<typeof vi.fn> };
  events: { emit: ReturnType<typeof vi.fn> };
  match: { runFor: ReturnType<typeof vi.fn> };
  stock: { record: ReturnType<typeof vi.fn> };
  rma: { autoCreateFromGrn: ReturnType<typeof vi.fn> };
} {
  const prisma = { client, currentTenantId: 'ten_1' } as unknown as PrismaService;
  const audit = { record: vi.fn() };
  const events = { emit: vi.fn() };
  const match = { runFor: vi.fn() };
  const stock = { record: vi.fn().mockResolvedValue('stk_1') };
  const rma = { autoCreateFromGrn: vi.fn() };
  const service = new GrnService(
    prisma,
    audit as unknown as AuditLogService,
    events as unknown as DomainEventService,
    new SamplingPlanService(),
    new QcParameterEvaluator(),
    new InventoryValuationService(),
    stock as unknown as StockLedgerService,
    rma as unknown as RmaService,
    match as unknown as MatchService,
    // Slice 10a — live e-Way validity check; benign in tests (no eway bill number).
    { checkForGrn: async () => null } as unknown as EwayBillValidationService,
  );
  return { service, client, audit, events, match, stock, rma };
}

describe('GrnService.createDraft', () => {
  let client: MockClient;

  beforeEach(() => {
    client = {
      purchaseOrder: { findUnique: vi.fn().mockResolvedValue(makePo('ISSUED')) },
      tenant: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          overReceiptTolerancePct: D('0.02'),
        }),
      },
      grnLine: { findMany: vi.fn().mockResolvedValue([]) },
      itemUomConversion: { findMany: vi.fn().mockResolvedValue([]) },
      goodsReceiptNote: {
        create: vi.fn().mockResolvedValue({ id: 'grn_1' }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      userRole: { findMany: vi.fn().mockResolvedValue([]) },
    };
  });

  const input = (over: Record<string, unknown> = {}) => ({
    poId: 'po_1',
    receiptType: 'PARTIAL' as const,
    packingCondition: 'OK' as const,
    returnFreightBorneBy: 'VENDOR' as const,
    submit: false,
    lines: [{ poLineId: 'pol_1', qtyReceived: '7.8', serialNumbers: [] }],
    ...over,
  });

  it('creates a DRAFT GRN within tolerance', async () => {
    const { service, client: c, audit } = buildService(client);
    const res = await service.createDraft(input() as never, 'usr_1');
    expect(res.id).toMatch(/^grn_/);
    expect(c.goodsReceiptNote.create).toHaveBeenCalledOnce();
    const data = c.goodsReceiptNote.create.mock.calls[0][0].data;
    expect(data.status).toBe('DRAFT');
    expect(audit.record).toHaveBeenCalled();
  });

  it('rejects receipt against a non-issued PO', async () => {
    client.purchaseOrder.findUnique.mockResolvedValue(makePo('DRAFT'));
    const { service } = buildService(client);
    await expect(service.createDraft(input() as never, 'usr_1')).rejects.toBeInstanceOf(
      GrnStateError,
    );
  });

  it('blocks over-tolerance receipt without OVER_RECEIPT type', async () => {
    const { service } = buildService(client);
    await expect(
      service.createDraft(
        input({
          lines: [{ poLineId: 'pol_1', qtyReceived: '9', serialNumbers: [] }],
        }) as never,
        'usr_1',
      ),
    ).rejects.toBeInstanceOf(OverReceiptError);
  });

  it('allows over-tolerance receipt for a PLANT_HEAD with OVER_RECEIPT', async () => {
    client.userRole.findMany.mockResolvedValue([{ role: { name: 'PLANT_HEAD' } }]);
    const { service, client: c } = buildService(client);
    await service.createDraft(
      input({
        receiptType: 'OVER_RECEIPT',
        lines: [{ poLineId: 'pol_1', qtyReceived: '9', serialNumbers: [] }],
      }) as never,
      'usr_1',
    );
    const data = c.goodsReceiptNote.create.mock.calls[0][0].data;
    expect(data.varianceFlags).toContain('OVER_RECEIPT');
  });

  it('flags weighbridge variance and requires plant-head sign-off', async () => {
    client.itemUomConversion.findMany.mockResolvedValue([
      { fromUom: 'tonne', toUom: 'kg', factor: D('1000') },
    ]);
    const { service, client: c } = buildService(client);
    // received 7.8T = 7800kg; weighbridge net 7000kg → >2% variance.
    await service.createDraft(
      input({ grossWeightKg: '7400', tareWeightKg: '400' }) as never,
      'usr_1',
    );
    const data = c.goodsReceiptNote.create.mock.calls[0][0].data;
    expect(data.varianceFlags).toContain('WEIGHBRIDGE_VARIANCE');
    expect(data.requiresPlantHeadSignoff).toBe(true);
  });

  it('applies UOM conversion (bags → tonnes) for tolerance math', async () => {
    // PO in tonnes; receive 160 bags where 1 bag = 0.05 tonne (kg conversion inverse).
    client.itemUomConversion.findMany.mockResolvedValue([
      { fromUom: 'tonne', toUom: 'bag', factor: D('20') }, // 1 tonne = 20 bags
    ]);
    const { service, client: c } = buildService(client);
    await service.createDraft(
      input({
        lines: [
          {
            poLineId: 'pol_1',
            qtyReceived: '160',
            uomReceived: 'bag',
            serialNumbers: [],
          },
        ],
      }) as never,
      'usr_1',
    );
    const line = c.goodsReceiptNote.create.mock.calls[0][0].data.lines.createMany.data[0];
    // 160 bags / 20 = 8 tonnes stored in PO UOM.
    expect(new Decimal(line.qtyReceived.toString()).toFixed(2)).toBe('8.00');
  });
});

describe('GrnService.post', () => {
  function grn(qcStatus: string, rejected = '0') {
    return {
      id: 'grn_1',
      poId: 'po_1',
      status: 'PENDING_QC',
      qcStatus,
      receiptType: 'PARTIAL',
      requiresPlantHeadSignoff: false,
      po: { vendorId: 'ven_1', requisition: { plantId: 'plt_1' } },
      lines: [
        {
          id: 'grnl_1',
          poLineId: 'pol_1',
          qtyReceived: D('7.8'),
          qtyAccepted: D('7.6'),
          qtyRejected: D(rejected),
          unitLandedCost: D('0'),
          poLine: {
            itemId: 'item_1',
            itemDesc: 'balls',
            unitPrice: D('128500'),
            item: { requiresQc: true },
          },
        },
      ],
    };
  }

  function baseClient(grnValue: unknown) {
    return {
      goodsReceiptNote: {
        findUnique: vi.fn().mockResolvedValue(grnValue),
        update: vi.fn().mockResolvedValue({}),
      },
      grnLine: { update: vi.fn().mockResolvedValue({}) },
      purchaseOrderLine: { update: vi.fn().mockResolvedValue({}) },
      purchaseOrder: {
        findUnique: vi.fn().mockResolvedValue({
          status: 'ISSUED',
          lines: [{ qtyOrdered: D('8'), qtyReceived: D('7.6') }],
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      invoice: { findMany: vi.fn().mockResolvedValue([{ id: 'inv_9' }]) },
    };
  }

  it('increments PO qty, records stock, transitions PO to PARTIALLY_RECEIVED, re-matches invoices', async () => {
    const client = baseClient(grn('CONDITIONAL_PASS'));
    const { service, client: c, stock, match } = buildService(client);
    await service.post('grn_1', 'usr_1');
    expect(c.purchaseOrderLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { qtyReceived: { increment: expect.anything() } },
      }),
    );
    expect(stock.record).toHaveBeenCalledWith(
      expect.objectContaining({ movementType: 'GRN_RECEIPT' }),
    );
    expect(c.purchaseOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'PARTIALLY_RECEIVED' } }),
    );
    expect(match.runFor).toHaveBeenCalledWith('inv_9');
  });

  it('auto-drafts an RMA when there are rejections', async () => {
    const client = baseClient(grn('FAILED', '0.2'));
    const { service, rma } = buildService(client);
    await service.post('grn_1', 'usr_1');
    expect(rma.autoCreateFromGrn).toHaveBeenCalledWith('grn_1', 'usr_1');
  });

  it('emits GrnPosted carrying per-line accepted qty (the match basis, ADR-026)', async () => {
    const client = baseClient(grn('CONDITIONAL_PASS'));
    const { service, events } = buildService(client);
    await service.post('grn_1', 'usr_1');
    expect(events.emit).toHaveBeenCalledWith(
      'GrnPosted',
      expect.objectContaining({
        grnId: 'grn_1',
        poId: 'po_1',
        lines: [{ poLineId: 'pol_1', qtyAccepted: '7.6' }],
      }),
    );
  });

  it('refuses to post before QC completes', async () => {
    const client = baseClient(grn('IN_PROGRESS'));
    const { service } = buildService(client);
    await expect(service.post('grn_1', 'usr_1')).rejects.toBeInstanceOf(GrnStateError);
  });
});

describe('GrnService.reverse', () => {
  function postedGrn() {
    return {
      id: 'grn_1',
      poId: 'po_1',
      status: 'POSTED',
      po: { requisition: { plantId: 'plt_1' } },
      lines: [
        {
          id: 'grnl_1',
          poLineId: 'pol_1',
          qtyAccepted: D('7.6'),
          unitLandedCost: D('128500'),
          poLine: { itemId: 'item_1', itemDesc: 'balls' },
        },
      ],
    };
  }

  it('reverses a posted GRN, compensates stock, cancels RMA', async () => {
    const client = {
      goodsReceiptNote: {
        findUnique: vi.fn().mockResolvedValue(postedGrn()),
        update: vi.fn().mockResolvedValue({}),
      },
      invoice: { findFirst: vi.fn().mockResolvedValue(null) },
      purchaseOrderLine: { update: vi.fn().mockResolvedValue({}) },
      returnMaterialAuth: { updateMany: vi.fn().mockResolvedValue({}) },
      purchaseOrder: {
        findUnique: vi.fn().mockResolvedValue({
          status: 'PARTIALLY_RECEIVED',
          lines: [{ qtyOrdered: D('8'), qtyReceived: D('0') }],
        }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const { service, client: c, stock } = buildService(client);
    await service.reverse('grn_1', 'wrong lot', 'usr_1');
    expect(stock.record).toHaveBeenCalledWith(
      expect.objectContaining({ movementType: 'RMA_ISSUE' }),
    );
    expect(c.returnMaterialAuth.updateMany).toHaveBeenCalled();
    expect(c.goodsReceiptNote.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REVERSED' }) }),
    );
  });

  it('blocks reversal when an invoice has already matched', async () => {
    const client = {
      goodsReceiptNote: { findUnique: vi.fn().mockResolvedValue(postedGrn()) },
      invoice: { findFirst: vi.fn().mockResolvedValue({ id: 'inv_matched' }) },
    };
    const { service } = buildService(client);
    await expect(service.reverse('grn_1', 'x', 'usr_1')).rejects.toBeInstanceOf(
      GrnStateError,
    );
  });

  it('cannot reverse an already-reversed GRN', async () => {
    const client = {
      goodsReceiptNote: {
        findUnique: vi.fn().mockResolvedValue({ ...postedGrn(), status: 'REVERSED' }),
      },
    };
    const { service } = buildService(client);
    await expect(service.reverse('grn_1', 'x', 'usr_1')).rejects.toBeInstanceOf(
      GrnStateError,
    );
  });
});
