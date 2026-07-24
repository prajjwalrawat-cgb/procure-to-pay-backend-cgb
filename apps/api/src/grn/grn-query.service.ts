import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@procureflow/db';
import type {
  AqlLevel,
  GrnDetailResponse,
  GrnLineView,
  GrnListItem,
  GrnListQuery,
  GrnListResponse,
  InspectionLevel,
  QcParameterSpecMap,
  VendorGrnListResponse,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { PrismaService } from '../prisma/prisma.service';
import { SamplingPlanService } from './sampling-plan.service';

type GrnWithRels = Prisma.GoodsReceiptNoteGetPayload<{
  include: {
    po: { include: { vendor: true } };
    lines: true;
  };
}>;

/** Read-side for goods receipts: tabbed/filtered list and full detail. */
@Injectable()
export class GrnQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sampling: SamplingPlanService,
  ) {}

  async list(query: GrnListQuery): Promise<GrnListResponse> {
    const where = this.whereForTab(query);
    if (query.poId) where.poId = query.poId;
    if (query.status)
      where.status = query.status as Prisma.GoodsReceiptNoteWhereInput['status'];
    if (query.qcStatus)
      where.qcStatus = query.qcStatus as Prisma.GoodsReceiptNoteWhereInput['qcStatus'];
    if (query.receiptType) where.receiptType = query.receiptType;
    if (query.vendorId) where.po = { vendorId: query.vendorId };

    const rows = await this.prisma.client.goodsReceiptNote.findMany({
      where,
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      include: { po: { include: { vendor: true } }, lines: true },
    });
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;

    return {
      items: page.map((g) => this.toListItem(g)),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      totalEstimate: await this.prisma.client.goodsReceiptNote.count({ where }),
      counts: await this.counts(),
    };
  }

  async detail(id: string): Promise<GrnDetailResponse> {
    const grn = await this.prisma.client.goodsReceiptNote.findUnique({
      where: { id },
      include: {
        po: {
          include: { vendor: true, lines: true, requisition: true, invoices: true },
        },
        lines: {
          include: {
            poLine: { include: { item: true } },
            qcSamples: true,
          },
          orderBy: { id: 'asc' },
        },
        attachments: true,
        rmas: { where: { status: { not: 'CANCELLED' } }, take: 1 },
      },
    });
    if (!grn) throw new NotFoundException('GRN not found');

    const lines: GrnLineView[] = [];
    let totalValue = new Decimal(0);
    for (const l of grn.lines) {
      const received = new Decimal(l.qtyReceived.toString());
      const accepted = new Decimal(l.qtyAccepted.toString());
      const landed = new Decimal(l.unitLandedCost.toString());
      const value = accepted.times(
        landed.isZero() ? l.poLine.unitPrice.toString() : landed,
      );
      totalValue = totalValue.plus(value);
      const item = l.poLine.item;
      const lotSize = Math.max(1, Math.round(received.toNumber()));
      const aql = (item?.aqlLevel as AqlLevel | undefined) ?? '2.5';
      const level = this.inspectionLevel(item?.samplingPlanRef ?? null);
      const plan =
        item?.requiresQc === true ? this.sampling.computePlan(lotSize, aql, level) : null;
      const balance = await this.stockBalances(l.poLineId, grn.id, l.poLine.itemId);

      lines.push({
        id: l.id,
        poLineId: l.poLineId,
        itemDesc: l.poLine.itemDesc,
        uom: l.poLine.uom,
        uomReceived: l.uomReceived,
        uomConversionFactor: l.uomConversionFactor.toString(),
        qtyOrdered: l.poLine.qtyOrdered.toString(),
        qtyReceived: received.toFixed(4),
        qtyAccepted: accepted.toFixed(4),
        qtyRejected: l.qtyRejected.toString(),
        qtyShort: l.qtyShort.toString(),
        rejectionReason: l.rejectionReason,
        batchNumber: l.batchNumber,
        lotNumber: l.lotNumber,
        serialNumbers: l.serialNumbers,
        manufacturingDate: l.manufacturingDate?.toISOString() ?? null,
        expiryDate: l.expiryDate?.toISOString() ?? null,
        storageLocation: l.storageLocation,
        binCode: l.binCode,
        unitLandedCost: landed.toFixed(4),
        lineValue: value.toFixed(4),
        varianceFlags: (l.varianceFlags as string[] | null) ?? [],
        requiresQc: item?.requiresQc ?? false,
        requiresCoa: item?.requiresCoa ?? false,
        qcParameters: (item?.qcParameters as GrnLineView['qcParameters'] | null) ?? {},
        samplePlan: plan
          ? {
              codeLetter: plan.codeLetter,
              sampleSize: plan.sampleSize,
              acceptNumber: plan.acceptNumber,
              rejectNumber: plan.rejectNumber,
              aqlLevel: plan.aqlLevel,
            }
          : null,
        qcSamples: l.qcSamples.map((s) => ({
          id: s.id,
          sampleType: s.sampleType,
          sampleSize: s.sampleSize,
          samplePlanRef: s.samplePlanRef,
          inspectedBy: s.inspectedBy,
          inspectedAt: s.inspectedAt.toISOString(),
          result: s.result,
          defectsFound: s.defectsFound,
          defectSeverity: s.defectSeverity,
          parameters: this.sampleParams(s.parametersMeasured, s.parametersSpec),
        })),
        stockBefore: balance.before,
        stockAfter: balance.after,
      });
    }

    const activity = await this.activity(id);
    const fulfil = this.poFulfilment(grn.po.lines);

    return {
      id: grn.id,
      number: grn.number,
      status: grn.status,
      qcStatus: grn.qcStatus,
      receiptType: grn.receiptType,
      po: { id: grn.po.id, number: grn.po.number, fulfilmentPct: fulfil },
      vendor: {
        id: grn.po.vendor.id,
        name: grn.po.vendor.name,
        code: grn.po.vendor.code,
        gstin: grn.po.vendor.gstin,
        isMsme: grn.po.vendor.isMsme,
      },
      gate: {
        gateEntryRef: grn.gateEntryRef,
        vehicleNo: grn.vehicleNo,
        driverName: grn.driverName,
        driverPhoneLast4: grn.driverPhoneLast4,
        transporter: grn.transporter,
        ewayBillNo: grn.ewayBillNo,
        ewayBillValidUntil: grn.ewayBillValidUntil?.toISOString() ?? null,
        unloadingLocation: grn.unloadingLocation,
        packingCondition: grn.packingCondition,
        weighbridgeSlipNo: grn.weighbridgeSlipNo,
        grossWeightKg: grn.grossWeightKg?.toString() ?? null,
        tareWeightKg: grn.tareWeightKg?.toString() ?? null,
        netWeightKg: grn.netWeightKg?.toString() ?? null,
      },
      receivedBy: grn.receivedBy,
      receivedAt: grn.receivedAt.toISOString(),
      postedAt: grn.postedAt?.toISOString() ?? null,
      varianceFlags: (grn.varianceFlags as string[] | null) ?? [],
      requiresPlantHeadSignoff: grn.requiresPlantHeadSignoff,
      stages: this.stages(grn.status),
      lines,
      attachments: grn.attachments.map((a) => ({
        id: a.id,
        docType: a.docType,
        s3Key: a.s3Key,
        uploadedAt: a.uploadedAt.toISOString(),
        uploadedBy: a.uploadedBy,
      })),
      rma: grn.rmas[0]
        ? { id: grn.rmas[0].id, number: grn.rmas[0].number, status: grn.rmas[0].status }
        : null,
      invoiceLinks: grn.po.invoices.map((i) => ({
        id: i.id,
        number: i.number,
        status: i.status,
      })),
      activity,
      totals: { value: totalValue.toFixed(4), currency: grn.po.currency },
      canEdit: grn.status === 'DRAFT',
      canStartQc: grn.status === 'PENDING_QC' && grn.qcStatus === 'NOT_STARTED',
      canCompleteQc: grn.status === 'PENDING_QC' && grn.qcStatus === 'IN_PROGRESS',
      canPost:
        grn.status === 'PENDING_QC' &&
        ['PASSED', 'FAILED', 'CONDITIONAL_PASS', 'WAIVED'].includes(grn.qcStatus),
      canReverse: grn.status === 'POSTED',
      canHold: ['DRAFT', 'PENDING_QC'].includes(grn.status),
    };
  }

  /** Vendor-portal list — posted/pending GRNs on the vendor's own POs. */
  async listForVendor(vendorId: string): Promise<VendorGrnListResponse> {
    const rows = await this.prisma.client.goodsReceiptNote.findMany({
      where: { po: { vendorId }, status: { in: ['PENDING_QC', 'POSTED', 'REVERSED'] } },
      orderBy: { receivedAt: 'desc' },
      include: { po: true, lines: true },
      take: 100,
    });
    return {
      items: rows.map((g) => {
        const received = g.lines.reduce(
          (a, l) => a.plus(l.qtyReceived.toString()),
          new Decimal(0),
        );
        const accepted = g.lines.reduce(
          (a, l) => a.plus(l.qtyAccepted.toString()),
          new Decimal(0),
        );
        return {
          id: g.id,
          number: g.number,
          poNumber: g.po.number,
          receivedAt: g.receivedAt.toISOString(),
          status: g.status,
          qcStatus: g.qcStatus,
          lineCount: g.lines.length,
          acceptedPct: received.isZero()
            ? 0
            : Number(accepted.dividedBy(received).times(100).toFixed(1)),
        };
      }),
      nextCursor: null,
      totalEstimate: rows.length,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private whereForTab(query: GrnListQuery): Prisma.GoodsReceiptNoteWhereInput {
    switch (query.tab) {
      case 'awaiting_qc':
        return { status: 'PENDING_QC' };
      case 'held':
        return { status: 'HOLD' };
      case 'posted_today': {
        const since = new Date();
        since.setUTCHours(0, 0, 0, 0);
        return { status: 'POSTED', postedAt: { gte: since } };
      }
      case 'pending_receipt':
        // POs issued/acknowledged with no posted receipt yet are surfaced via the
        // PO list; here we show draft GRNs in progress.
        return { status: 'DRAFT' };
      default:
        return {};
    }
  }

  private toListItem(g: GrnWithRels): GrnListItem {
    const received = g.lines.reduce(
      (a, l) => a.plus(l.qtyReceived.toString()),
      new Decimal(0),
    );
    const accepted = g.lines.reduce(
      (a, l) => a.plus(l.qtyAccepted.toString()),
      new Decimal(0),
    );
    const value = g.lines.reduce(
      (a, l) =>
        a.plus(
          new Decimal(l.qtyAccepted.toString()).times(
            new Decimal(l.unitLandedCost.toString()),
          ),
        ),
      new Decimal(0),
    );
    return {
      id: g.id,
      number: g.number,
      po: { id: g.po.id, number: g.po.number },
      vendor: { id: g.po.vendor.id, name: g.po.vendor.name, isMsme: g.po.vendor.isMsme },
      receiptType: g.receiptType,
      status: g.status,
      qcStatus: g.qcStatus,
      receivedAt: g.receivedAt.toISOString(),
      lineCount: g.lines.length,
      acceptedPct: received.isZero()
        ? 0
        : Number(accepted.dividedBy(received).times(100).toFixed(1)),
      totalValue: value.toFixed(4),
      currency: g.po.currency,
      hasRejections: g.lines.some((l) =>
        new Decimal(l.qtyRejected.toString()).greaterThan(0),
      ),
    };
  }

  private sampleParams(
    measured: Prisma.JsonValue,
    spec: Prisma.JsonValue,
  ): GrnDetailResponse['lines'][number]['qcSamples'][number]['parameters'] {
    const m = (measured as unknown as Record<string, number | boolean>) ?? {};
    const s = (spec as unknown as QcParameterSpecMap) ?? {};
    return Object.keys(s).map((name) => {
      const sp = s[name]!;
      const value = m[name];
      let pass = false;
      if (sp.kind === 'BOOLEAN') pass = Boolean(value) === sp.mustBe;
      else if (typeof value === 'number') {
        const min = sp.kind === 'RANGE' ? sp.min : sp.target - sp.tolerance;
        const max = sp.kind === 'RANGE' ? sp.max : sp.target + sp.tolerance;
        pass = value >= min && value <= max;
      }
      return {
        parameter: name,
        measured: value ?? null,
        result: pass ? 'PASS' : 'FAIL',
        message: `${name}: ${value ?? '—'}`,
      };
    });
  }

  private async stockBalances(
    _poLineId: string,
    grnId: string,
    itemId: string | null,
  ): Promise<{ before: string | null; after: string | null }> {
    if (!itemId) return { before: null, after: null };
    const movement = await this.prisma.client.stockLedger.findFirst({
      where: { itemId, sourceId: grnId, movementType: 'GRN_RECEIPT' },
      orderBy: { recordedAt: 'desc' },
    });
    if (!movement) return { before: null, after: null };
    const after = new Decimal(movement.balanceQtyAfter.toString());
    const before = after.minus(movement.qtyDelta.toString());
    return { before: before.toFixed(4), after: after.toFixed(4) };
  }

  private inspectionLevel(ref: string | null): InspectionLevel {
    if (!ref) return 'II';
    const match = /S-?([1-4])/i.exec(ref);
    if (match) return `S${match[1]}` as InspectionLevel;
    if (/level\s*iii/i.test(ref)) return 'III';
    if (/level\s*i\b/i.test(ref)) return 'I';
    return 'II';
  }

  private poFulfilment(
    lines: { qtyOrdered: Prisma.Decimal; qtyReceived: Prisma.Decimal }[],
  ): number {
    const ordered = lines.reduce(
      (a, l) => a.plus(l.qtyOrdered.toString()),
      new Decimal(0),
    );
    const received = lines.reduce(
      (a, l) => a.plus(l.qtyReceived.toString()),
      new Decimal(0),
    );
    if (ordered.isZero()) return 0;
    return Number(received.dividedBy(ordered).times(100).toFixed(1));
  }

  private stages(status: string): GrnDetailResponse['stages'] {
    const order = ['GATE_ENTRY', 'LINE_RECEIPT', 'QC', 'POSTED', 'CLOSED'];
    const idx = ((): number => {
      if (status === 'DRAFT') return 1;
      if (status === 'PENDING_QC' || status === 'HOLD') return 2;
      if (status === 'POSTED') return 3;
      if (status === 'REVERSED') return 4;
      return 0;
    })();
    const labels: Record<string, string> = {
      GATE_ENTRY: 'Gate entry',
      LINE_RECEIPT: 'Line receipt',
      QC: 'QC',
      POSTED: 'Posted',
      CLOSED: 'Closed',
    };
    return order.map((key, i) => ({
      key,
      label: labels[key] ?? key,
      state: i < idx ? 'done' : i === idx ? 'active' : 'todo',
    }));
  }

  private async activity(id: string): Promise<GrnDetailResponse['activity']> {
    const rows = await this.prisma.client.auditLog.findMany({
      where: { entityType: 'GoodsReceiptNote', entityId: id },
      orderBy: { timestamp: 'asc' },
      take: 100,
    });
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      actorId: r.actorId,
      at: r.timestamp.toISOString(),
    }));
  }

  private async counts(): Promise<GrnListResponse['counts']> {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const [awaitingQc, held, postedToday, drafts, all] = await Promise.all([
      this.prisma.client.goodsReceiptNote.count({ where: { status: 'PENDING_QC' } }),
      this.prisma.client.goodsReceiptNote.count({ where: { status: 'HOLD' } }),
      this.prisma.client.goodsReceiptNote.count({
        where: { status: 'POSTED', postedAt: { gte: since } },
      }),
      this.prisma.client.goodsReceiptNote.count({ where: { status: 'DRAFT' } }),
      this.prisma.client.goodsReceiptNote.count(),
    ]);
    return {
      pending_receipt: drafts,
      awaiting_qc: awaitingQc,
      posted_today: postedToday,
      held,
      all,
    };
  }
}
