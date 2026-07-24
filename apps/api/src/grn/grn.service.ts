import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import {
  DOMAIN_EVENTS,
  type GrnCompleteQcInput,
  type GrnCreateInput,
  type GrnQcSampleInput,
  type GrnUpdateInput,
  type QcParameterSpecMap,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { AuditLogService } from '../audit/audit.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { MatchService } from '../invoices/match.service';
import { PrismaService } from '../prisma/prisma.service';
import { GrnStateError, GrnValidationError, OverReceiptError } from './grn.errors';
import { EwayBillValidationService } from '../compliance/eway-validation.service';
import { InventoryValuationService } from './inventory-valuation.service';
import { QcParameterEvaluator } from './qc-parameter-evaluator';
import { RmaService } from './rma.service';
import { SamplingPlanService } from './sampling-plan.service';
import { StockLedgerService } from './stock-ledger.service';

const RECEIVABLE_PO = ['ISSUED', 'ACKNOWLEDGED', 'PARTIALLY_RECEIVED'];
const INVOICE_LOCKED: Prisma.InvoiceWhereInput['status'] = {
  in: ['AWAITING_APPROVAL', 'APPROVED', 'SCHEDULED', 'PAID'],
};

/**
 * GrnService (Slice 5). Gate-to-post goods-receipt lifecycle: draft receipt with
 * tolerance + weighbridge checks, QC sampling & decisions, transactional post
 * (PO qty, stock ledger, RMA auto-draft, invoice re-match), and reversal.
 */
@Injectable()
export class GrnService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
    private readonly sampling: SamplingPlanService,
    private readonly qc: QcParameterEvaluator,
    private readonly valuation: InventoryValuationService,
    private readonly stock: StockLedgerService,
    private readonly rma: RmaService,
    private readonly match: MatchService,
    private readonly eway: EwayBillValidationService,
  ) {}

  async createDraft(input: GrnCreateInput, actorId: string): Promise<{ id: string }> {
    const po = await this.prisma.client.purchaseOrder.findUnique({
      where: { id: input.poId },
      include: { lines: { include: { item: true } }, vendor: true },
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    if (!RECEIVABLE_PO.includes(po.status)) {
      throw new GrnStateError('This PO cannot receive goods in its current state.', {
        status: po.status,
      });
    }

    const poLineById = new Map(po.lines.map((l) => [l.id, l]));
    const flags: string[] = [];
    const tenant = await this.prisma.client.tenant.findUniqueOrThrow({
      where: { id: this.tenantId() },
    });
    const tolerance = new Decimal(tenant.overReceiptTolerancePct.toString());
    const isOverReceiptType = input.receiptType === 'OVER_RECEIPT';

    // Resolve + validate each line, converting the received qty into PO UOM.
    const lineData: Prisma.GrnLineCreateManyGrnInput[] = [];
    for (const line of input.lines) {
      const poLine = poLineById.get(line.poLineId);
      if (!poLine) {
        throw new GrnValidationError('Line is not on the purchase order.', {
          poLineId: line.poLineId,
        });
      }
      const uomReceived = line.uomReceived ?? poLine.uom;
      const factor = await this.conversionFactor(poLine.itemId, uomReceived, poLine.uom);
      const qtyPoUom = new Decimal(line.qtyReceived).times(factor);
      if (qtyPoUom.lessThanOrEqualTo(0)) {
        throw new GrnValidationError('Received quantity must be greater than zero.');
      }

      const priorReceived = await this.priorReceived(poLine.id);
      const maxAllowed = new Decimal(poLine.qtyOrdered.toString()).times(
        new Decimal(1).plus(tolerance),
      );
      const projected = priorReceived.plus(qtyPoUom);
      if (projected.greaterThan(maxAllowed) && !isOverReceiptType) {
        throw new OverReceiptError(
          'Cumulative receipt exceeds the ordered quantity plus tolerance. Use an over-receipt with plant-head authority.',
          {
            poLineId: poLine.id,
            ordered: poLine.qtyOrdered.toString(),
            projected: projected.toFixed(4),
            tolerancePct: tolerance.toString(),
          },
        );
      }
      if (isOverReceiptType && projected.greaterThan(maxAllowed)) {
        if (!(await this.actorHasRole(actorId, 'PLANT_HEAD'))) {
          throw new OverReceiptError(
            'Over-receipt beyond tolerance requires PLANT_HEAD authority.',
            { poLineId: poLine.id },
          );
        }
        flags.push('OVER_RECEIPT');
      }

      const expiryFlag =
        line.expiryDate &&
        new Date(line.expiryDate).getTime() - Date.now() < 90 * 24 * 3600 * 1000;
      if (expiryFlag) flags.push('BATCH_NEAR_EXPIRY');

      lineData.push({
        id: newId('grnLine'),
        tenantId: this.tenantId(),
        poLineId: poLine.id,
        qtyReceived: new Prisma.Decimal(qtyPoUom.toFixed(4)),
        qtyAccepted: new Prisma.Decimal('0'),
        qtyRejected: new Prisma.Decimal('0'),
        uomReceived,
        uomConversionFactor: new Prisma.Decimal(factor.toFixed(6)),
        batchNumber: line.batchNumber ?? null,
        lotNumber: line.lotNumber ?? null,
        serialNumbers: line.serialNumbers ?? [],
        manufacturingDate: line.manufacturingDate
          ? new Date(line.manufacturingDate)
          : null,
        expiryDate: line.expiryDate ? new Date(line.expiryDate) : null,
        storageLocation: line.storageLocation ?? null,
        binCode: line.binCode ?? null,
        glStockAccount: poLine.item?.stockGlAccount ?? null,
      });
    }

    // E-way bill expiry + delivery-timing warnings (don't block).
    if (input.ewayBillValidUntil && new Date(input.ewayBillValidUntil) < new Date()) {
      flags.push('EWAY_BILL_EXPIRED');
    }
    // Slice 10a — live validity check via NIC (GSP-mediated); non-blocking.
    const ewayFlag = await this.eway.checkForGrn(input.ewayBillNo, this.tenantId());
    if (ewayFlag) flags.push(ewayFlag);
    if (input.packingCondition !== 'OK') flags.push('PACKING_DAMAGE');
    if (po.expectedDeliveryDate) {
      if (new Date() < po.expectedDeliveryDate) flags.push('EARLY_DELIVERY');
      else if (Date.now() - po.expectedDeliveryDate.getTime() > 24 * 3600 * 1000)
        flags.push('LATE_DELIVERY');
    }

    // Weighbridge cross-check (±2% of computed received weight in kg).
    const gross = input.grossWeightKg ? new Decimal(input.grossWeightKg) : null;
    const tare = input.tareWeightKg ? new Decimal(input.tareWeightKg) : null;
    const net = gross && tare ? gross.minus(tare) : null;
    let requiresPlantHeadSignoff = false;
    if (net) {
      const computedKg = await this.computeReceivedKg(input.lines, poLineById);
      if (computedKg && computedKg.greaterThan(0)) {
        const variance = net.minus(computedKg).dividedBy(computedKg).abs();
        if (variance.greaterThan('0.02')) {
          flags.push('WEIGHBRIDGE_VARIANCE');
          requiresPlantHeadSignoff = true;
        }
      }
    }

    const id = newId('grn');
    const number = await this.nextNumber();
    await this.prisma.client.goodsReceiptNote.create({
      data: {
        id,
        tenantId: this.tenantId(),
        number,
        poId: po.id,
        receiptType: input.receiptType,
        gateEntryRef: input.gateEntryRef ?? null,
        vehicleNo: input.vehicleNo ?? null,
        driverName: input.driverName ?? null,
        driverPhoneLast4: input.driverPhoneLast4 ?? null,
        transporter: input.transporter ?? null,
        ewayBillNo: input.ewayBillNo ?? null,
        ewayBillValidUntil: input.ewayBillValidUntil
          ? new Date(input.ewayBillValidUntil)
          : null,
        receivedBy: actorId,
        receivedAt: new Date(),
        unloadingLocation: input.unloadingLocation ?? null,
        packingCondition: input.packingCondition,
        weighbridgeSlipNo: input.weighbridgeSlipNo ?? null,
        grossWeightKg: gross ? new Prisma.Decimal(gross.toFixed(4)) : null,
        tareWeightKg: tare ? new Prisma.Decimal(tare.toFixed(4)) : null,
        netWeightKg: net ? new Prisma.Decimal(net.toFixed(4)) : null,
        deliveryNoteRef: input.deliveryNoteRef ?? null,
        status: 'DRAFT',
        qcStatus: 'NOT_STARTED',
        varianceFlags:
          flags.length > 0 ? (flags as Prisma.InputJsonValue) : Prisma.JsonNull,
        requiresPlantHeadSignoff,
        createdBy: actorId,
        lines: { createMany: { data: lineData } },
      },
    });

    await this.audit.record({
      action: 'GRN_CREATED',
      entityType: 'GoodsReceiptNote',
      entityId: id,
      actorId,
      after: { number, poNumber: po.number, lines: lineData.length, flags },
    });
    await this.events.emit(DOMAIN_EVENTS.GRN_DRAFTED, {
      grnId: id,
      poId: po.id,
      vendorId: po.vendorId,
    });

    if (input.submit) await this.submit(id, actorId);
    return { id };
  }

  async updateDraft(
    id: string,
    input: GrnUpdateInput,
    actorId: string,
  ): Promise<{ ok: true }> {
    const grn = await this.requireGrn(id);
    if (grn.status !== 'DRAFT') {
      throw new GrnStateError('Only a draft GRN can be edited.', { status: grn.status });
    }
    if (grn.receivedBy !== actorId && !(await this.actorHasRole(actorId, 'PLANT_HEAD'))) {
      throw new GrnStateError('Only the receiver can edit this draft.');
    }
    await this.prisma.client.goodsReceiptNote.update({
      where: { id },
      data: {
        gateEntryRef: input.gateEntryRef ?? undefined,
        vehicleNo: input.vehicleNo ?? undefined,
        driverName: input.driverName ?? undefined,
        transporter: input.transporter ?? undefined,
        unloadingLocation: input.unloadingLocation ?? undefined,
        packingCondition: input.packingCondition ?? undefined,
        deliveryNoteRef: input.deliveryNoteRef ?? undefined,
      },
    });
    await this.audit.record({
      action: 'GRN_UPDATED',
      entityType: 'GoodsReceiptNote',
      entityId: id,
      actorId,
    });
    return { ok: true };
  }

  /** DRAFT → PENDING_QC (if any item requires QC / packing damaged) else auto-post. */
  async submit(id: string, actorId: string): Promise<{ ok: true }> {
    const grn = await this.loadWithLines(id);
    if (grn.status !== 'DRAFT') {
      throw new GrnStateError('Only a draft GRN can be submitted.', {
        status: grn.status,
      });
    }
    const requiresQc =
      grn.packingCondition !== 'OK' ||
      grn.lines.some((l) => l.poLine.item?.requiresQc === true);

    if (requiresQc) {
      await this.prisma.client.goodsReceiptNote.update({
        where: { id },
        data: { status: 'PENDING_QC', qcStatus: 'NOT_STARTED' },
      });
      await this.audit.record({
        action: 'GRN_SENT_FOR_QC',
        entityType: 'GoodsReceiptNote',
        entityId: id,
        actorId,
      });
      return { ok: true };
    }

    // No QC required: accept the full received quantity and post immediately.
    for (const l of grn.lines) {
      await this.prisma.client.grnLine.update({
        where: { id: l.id },
        data: { qtyAccepted: l.qtyReceived, qtyRejected: new Prisma.Decimal('0') },
      });
    }
    await this.prisma.client.goodsReceiptNote.update({
      where: { id },
      data: { status: 'PENDING_QC', qcStatus: 'PASSED', qcBy: actorId, qcAt: new Date() },
    });
    await this.post(id, actorId);
    return { ok: true };
  }

  async startQc(id: string, actorId: string): Promise<{ ok: true }> {
    const grn = await this.requireGrn(id);
    if (grn.status !== 'PENDING_QC') {
      throw new GrnStateError('GRN is not awaiting QC.', { status: grn.status });
    }
    await this.prisma.client.goodsReceiptNote.update({
      where: { id },
      data: { qcStatus: 'IN_PROGRESS', qcBy: actorId },
    });
    await this.audit.record({
      action: 'GRN_QC_STARTED',
      entityType: 'GoodsReceiptNote',
      entityId: id,
      actorId,
    });
    return { ok: true };
  }

  async recordQcSample(
    grnId: string,
    input: GrnQcSampleInput,
    actorId: string,
  ): Promise<{ id: string; result: string }> {
    const grnLine = await this.prisma.client.grnLine.findFirst({
      where: { id: input.grnLineId, grnId },
      include: { poLine: { include: { item: true } } },
    });
    if (!grnLine) throw new NotFoundException('GRN line not found');

    const specMap =
      (grnLine.poLine.item?.qcParameters as unknown as QcParameterSpecMap | null) ?? {};
    const evaluation = this.qc.evaluateSample(specMap, input.parametersMeasured, {
      conditionalDefects: input.defectsFound,
    });
    const severity = this.defectSeverity(evaluation.result, input.defectsFound);

    const id = newId('grnQcSample');
    await this.prisma.client.grnQcSample.create({
      data: {
        id,
        tenantId: this.tenantId(),
        grnLineId: grnLine.id,
        sampleType: input.sampleType,
        sampleSize: input.sampleSize,
        samplePlanRef:
          input.samplePlanRef ?? grnLine.poLine.item?.samplingPlanRef ?? null,
        inspectedBy: actorId,
        parametersMeasured: input.parametersMeasured as Prisma.InputJsonValue,
        parametersSpec: specMap as unknown as Prisma.InputJsonValue,
        result: evaluation.result,
        defectsFound: input.defectsFound,
        defectSeverity: severity,
        certificateOfAnalysisS3: input.certificateOfAnalysisS3 ?? null,
      },
    });
    await this.audit.record({
      action: 'GRN_QC_SAMPLE_RECORDED',
      entityType: 'GoodsReceiptNote',
      entityId: grnId,
      actorId,
      after: { grnLineId: grnLine.id, result: evaluation.result },
    });
    return { id, result: evaluation.result };
  }

  async completeQc(
    grnId: string,
    input: GrnCompleteQcInput,
    actorId: string,
  ): Promise<{ ok: true }> {
    const grn = await this.loadWithLines(grnId);
    if (grn.status !== 'PENDING_QC') {
      throw new GrnStateError('GRN is not awaiting QC.', { status: grn.status });
    }
    const byId = new Map(grn.lines.map((l) => [l.id, l]));
    const decisionByLine = new Map(input.lines.map((d) => [d.grnLineId, d]));

    for (const d of input.lines) {
      const line = byId.get(d.grnLineId);
      if (!line)
        throw new GrnValidationError('Unknown GRN line.', { grnLineId: d.grnLineId });
      const accepted = new Decimal(d.qtyAccepted);
      const rejected = new Decimal(d.qtyRejected);
      const received = new Decimal(line.qtyReceived.toString());
      if (!accepted.plus(rejected).equals(received)) {
        throw new GrnValidationError(
          'Accepted + rejected must equal the received quantity.',
          { grnLineId: d.grnLineId, received: received.toFixed(4) },
        );
      }
      if (rejected.greaterThan(0) && !d.rejectionReason) {
        throw new GrnValidationError('A rejection reason is required.', {
          grnLineId: d.grnLineId,
        });
      }
      await this.prisma.client.grnLine.update({
        where: { id: d.grnLineId },
        data: {
          qtyAccepted: new Prisma.Decimal(accepted.toFixed(4)),
          qtyRejected: new Prisma.Decimal(rejected.toFixed(4)),
          rejectionReason: d.rejectionReason ?? null,
        },
      });
    }

    const samples = await this.prisma.client.grnQcSample.findMany({
      where: { grnLine: { grnId } },
    });
    const anyRejected = input.lines.some((d) =>
      new Decimal(d.qtyRejected).greaterThan(0),
    );
    const anyConditional = samples.some((s) => s.result === 'CONDITIONAL_PASS');
    const qcStatus = anyConditional
      ? 'CONDITIONAL_PASS'
      : anyRejected
        ? 'FAILED'
        : 'PASSED';

    await this.prisma.client.goodsReceiptNote.update({
      where: { id: grnId },
      data: { qcStatus, qcBy: actorId, qcAt: new Date() },
    });
    await this.audit.record({
      action: 'GRN_QC_COMPLETED',
      entityType: 'GoodsReceiptNote',
      entityId: grnId,
      actorId,
      after: { qcStatus },
    });
    await this.events.emit(DOMAIN_EVENTS.GRN_QC_COMPLETED, {
      grnId,
      poId: grn.poId,
      qcStatus,
      hasRejections: anyRejected,
    });
    // Guard against unused warning; decisions are already applied above.
    void decisionByLine;
    return { ok: true };
  }

  async post(id: string, actorId: string): Promise<{ ok: true }> {
    const grn = await this.loadWithLines(id);
    if (grn.status !== 'PENDING_QC') {
      throw new GrnStateError('Only a QC-complete GRN can be posted.', {
        status: grn.status,
      });
    }
    const postable = ['PASSED', 'FAILED', 'CONDITIONAL_PASS', 'WAIVED'];
    const skipsQc =
      grn.receiptType === 'OVER_RECEIPT' ||
      !grn.lines.some((l) => l.poLine.item?.requiresQc === true);
    if (!postable.includes(grn.qcStatus) && !skipsQc) {
      throw new GrnStateError('QC must be completed before posting.', {
        qcStatus: grn.qcStatus,
      });
    }
    if (
      grn.requiresPlantHeadSignoff &&
      !(await this.actorHasRole(actorId, 'PLANT_HEAD'))
    ) {
      throw new GrnStateError(
        'This GRN was flagged (weighbridge variance) and needs plant-head sign-off to post.',
      );
    }

    let acceptedValue = new Decimal(0);
    for (const line of grn.lines) {
      const accepted = new Decimal(line.qtyAccepted.toString());
      if (accepted.lessThanOrEqualTo(0)) continue;
      const landed = this.valuation.computeLandedCost({
        unitPrice: line.poLine.unitPrice.toString(),
      });
      acceptedValue = acceptedValue.plus(accepted.times(landed));
      await this.prisma.client.grnLine.update({
        where: { id: line.id },
        data: { unitLandedCost: new Prisma.Decimal(landed.toFixed(4)) },
      });
      await this.prisma.client.purchaseOrderLine.update({
        where: { id: line.poLineId },
        data: { qtyReceived: { increment: new Prisma.Decimal(accepted.toFixed(4)) } },
      });
      await this.stock.record({
        itemId: line.poLine.itemId,
        itemDesc: line.poLine.itemDesc,
        costCenterId: null,
        plantId: grn.po.requisition?.plantId ?? null,
        movementType: 'GRN_RECEIPT',
        sourceType: 'GRN',
        sourceId: grn.id,
        qtyDelta: accepted.toFixed(4),
        unitLandedCost: landed.toFixed(4),
        actorId,
      });
    }

    await this.prisma.client.goodsReceiptNote.update({
      where: { id },
      data: { status: 'POSTED', postedAt: new Date(), postedBy: actorId },
    });
    await this.recomputePoStatus(grn.poId);

    await this.audit.record({
      action: 'GRN_POSTED',
      entityType: 'GoodsReceiptNote',
      entityId: id,
      actorId,
      before: { status: 'PENDING_QC' },
      after: { status: 'POSTED', acceptedValue: acceptedValue.toFixed(4) },
    });
    await this.events.emit(DOMAIN_EVENTS.GRN_POSTED, {
      grnId: id,
      poId: grn.poId,
      vendorId: grn.po.vendorId,
      totalAcceptedValue: acceptedValue.toFixed(4),
      // Per-line accepted qty: the basis the 3-way match consumes (ADR-026).
      lines: grn.lines.map((l) => ({
        poLineId: l.poLineId,
        qtyAccepted: l.qtyAccepted.toString(),
      })),
    });

    // Auto-draft an RMA for any rejected quantity.
    const hasRejections = grn.lines.some((l) =>
      new Decimal(l.qtyRejected.toString()).greaterThan(0),
    );
    if (hasRejections) await this.rma.autoCreateFromGrn(id, actorId);

    // Re-run 3-way match for any invoice already linked to this PO (Slice 1).
    await this.rematchLinkedInvoices(grn.poId);
    return { ok: true };
  }

  async reverse(id: string, reason: string, actorId: string): Promise<{ ok: true }> {
    const grn = await this.loadWithLines(id);
    if (grn.status === 'REVERSED') {
      throw new GrnStateError('A reversed GRN cannot be reversed again.');
    }
    if (grn.status !== 'POSTED') {
      throw new GrnStateError('Only a posted GRN can be reversed.', {
        status: grn.status,
      });
    }
    const lockedInvoice = await this.prisma.client.invoice.findFirst({
      where: { poId: grn.poId, status: INVOICE_LOCKED },
    });
    if (lockedInvoice) {
      throw new GrnStateError(
        'Cannot reverse: an invoice has already matched against this receipt.',
        { invoiceId: lockedInvoice.id },
      );
    }

    for (const line of grn.lines) {
      const accepted = new Decimal(line.qtyAccepted.toString());
      if (accepted.lessThanOrEqualTo(0)) continue;
      await this.prisma.client.purchaseOrderLine.update({
        where: { id: line.poLineId },
        data: { qtyReceived: { decrement: new Prisma.Decimal(accepted.toFixed(4)) } },
      });
      await this.stock.record({
        itemId: line.poLine.itemId,
        itemDesc: line.poLine.itemDesc,
        costCenterId: null,
        plantId: grn.po.requisition?.plantId ?? null,
        movementType: 'RMA_ISSUE',
        sourceType: 'GRN_REVERSAL',
        sourceId: grn.id,
        qtyDelta: accepted.negated().toFixed(4),
        unitLandedCost: line.unitLandedCost.toString(),
        actorId,
      });
    }

    await this.prisma.client.goodsReceiptNote.update({
      where: { id },
      data: {
        status: 'REVERSED',
        reversedAt: new Date(),
        reversedBy: actorId,
        reversalReason: reason,
      },
    });
    // Cancel any auto-created RMA (still in draft/issued).
    await this.prisma.client.returnMaterialAuth.updateMany({
      where: { grnId: id, status: { in: ['DRAFT', 'ISSUED'] } },
      data: { status: 'CANCELLED' },
    });
    await this.recomputePoStatus(grn.poId);
    await this.audit.record({
      action: 'GRN_REVERSED',
      entityType: 'GoodsReceiptNote',
      entityId: id,
      actorId,
      before: { status: 'POSTED' },
      after: { reason },
    });
    await this.events.emit(DOMAIN_EVENTS.GRN_REVERSED, {
      grnId: id,
      poId: grn.poId,
      reason,
    });
    return { ok: true };
  }

  async hold(id: string, reason: string, actorId: string): Promise<{ ok: true }> {
    const grn = await this.requireGrn(id);
    if (!['DRAFT', 'PENDING_QC'].includes(grn.status)) {
      throw new GrnStateError('Only a draft/pending GRN can be held.', {
        status: grn.status,
      });
    }
    await this.prisma.client.goodsReceiptNote.update({
      where: { id },
      data: { status: 'HOLD', reversalReason: reason },
    });
    await this.audit.record({
      action: 'GRN_HELD',
      entityType: 'GoodsReceiptNote',
      entityId: id,
      actorId,
      after: { reason },
    });
    return { ok: true };
  }

  async addAttachment(
    grnId: string,
    input: { s3Key: string; docType: string },
    actorId: string,
  ): Promise<{ id: string }> {
    await this.requireGrn(grnId);
    const id = newId('grnAttachment');
    await this.prisma.client.grnAttachment.create({
      data: {
        id,
        tenantId: this.tenantId(),
        grnId,
        s3Key: input.s3Key,
        docType: input.docType as Prisma.GrnAttachmentCreateInput['docType'],
        uploadedBy: actorId,
      },
    });
    return { id };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async rematchLinkedInvoices(poId: string): Promise<void> {
    const invoices = await this.prisma.client.invoice.findMany({
      where: {
        poId,
        status: { in: ['RECEIVED', 'OCR_PENDING', 'OCR_DONE', 'MATCH_EXCEPTION'] },
      },
      select: { id: true },
    });
    for (const inv of invoices) await this.match.runFor(inv.id);
  }

  private async recomputePoStatus(poId: string): Promise<void> {
    const po = await this.prisma.client.purchaseOrder.findUnique({
      where: { id: poId },
      include: { lines: true },
    });
    if (!po) return;
    const anyReceived = po.lines.some((l) =>
      new Decimal(l.qtyReceived.toString()).greaterThan(0),
    );
    const allReceived =
      po.lines.length > 0 &&
      po.lines.every((l) =>
        new Decimal(l.qtyReceived.toString()).greaterThanOrEqualTo(
          l.qtyOrdered.toString(),
        ),
      );
    let status = po.status;
    if (allReceived) status = 'RECEIVED';
    else if (anyReceived) status = 'PARTIALLY_RECEIVED';
    else if (['PARTIALLY_RECEIVED', 'RECEIVED'].includes(po.status)) status = 'ISSUED';
    if (status !== po.status) {
      await this.prisma.client.purchaseOrder.update({
        where: { id: poId },
        data: { status },
      });
    }
  }

  private async priorReceived(poLineId: string): Promise<Decimal> {
    const rows = await this.prisma.client.grnLine.findMany({
      where: { poLineId, grn: { status: { notIn: ['REVERSED', 'HOLD'] } } },
      select: { qtyReceived: true },
    });
    return rows.reduce((a, r) => a.plus(r.qtyReceived.toString()), new Decimal(0));
  }

  private async conversionFactor(
    itemId: string | null,
    fromUom: string,
    toUom: string,
  ): Promise<Decimal> {
    if (fromUom === toUom || !itemId) return new Decimal(1);
    const conversions = await this.prisma.client.itemUomConversion.findMany({
      where: { itemId },
    });
    // Received-uom → PO-uom multiplier.
    const direct = conversions.find((c) => c.fromUom === fromUom && c.toUom === toUom);
    if (direct) return new Decimal(direct.factor.toString());
    const inverse = conversions.find((c) => c.fromUom === toUom && c.toUom === fromUom);
    if (inverse) return new Decimal(1).dividedBy(inverse.factor.toString());
    throw new GrnValidationError('No UOM conversion defined for this item.', {
      itemId,
      fromUom,
      toUom,
    });
  }

  private async computeReceivedKg(
    lines: GrnCreateInput['lines'],
    poLineById: Map<string, { id: string; uom: string; itemId: string | null }>,
  ): Promise<Decimal | null> {
    let total = new Decimal(0);
    for (const line of lines) {
      const poLine = poLineById.get(line.poLineId);
      if (!poLine) return null;
      const uomReceived = line.uomReceived ?? poLine.uom;
      if (uomReceived.toLowerCase() === 'kg') {
        total = total.plus(line.qtyReceived);
        continue;
      }
      try {
        const toKg = await this.conversionFactor(poLine.itemId, uomReceived, 'kg');
        total = total.plus(new Decimal(line.qtyReceived).times(toKg));
      } catch {
        return null; // no kg mapping → skip weighbridge cross-check
      }
    }
    return total;
  }

  private defectSeverity(
    result: string,
    defects: string[],
  ): Prisma.GrnQcSampleCreateInput['defectSeverity'] {
    if (result === 'FAIL') return 'MAJOR';
    if (defects.length > 0) return 'MINOR';
    return 'NONE';
  }

  private async actorHasRole(actorId: string, roleName: string): Promise<boolean> {
    const roles = await this.prisma.client.userRole.findMany({
      where: { userId: actorId },
      include: { role: true },
    });
    return roles.some((r) => r.role.name === roleName);
  }

  private loadWithLines(id: string) {
    return this.prisma.client.goodsReceiptNote
      .findUnique({
        where: { id },
        include: {
          po: { include: { requisition: true } },
          lines: { include: { poLine: { include: { item: true } } } },
        },
      })
      .then((grn) => {
        if (!grn) throw new NotFoundException('GRN not found');
        return grn;
      });
  }

  private async requireGrn(id: string) {
    const grn = await this.prisma.client.goodsReceiptNote.findUnique({ where: { id } });
    if (!grn) throw new NotFoundException('GRN not found');
    return grn;
  }

  private async nextNumber(): Promise<string> {
    const latest = await this.prisma.client.goodsReceiptNote.findMany({
      where: { number: { startsWith: 'GRN-' } },
      select: { number: true },
      orderBy: { number: 'desc' },
      take: 50,
    });
    let max = 311;
    for (const r of latest) {
      const n = Number.parseInt(r.number.replace('GRN-', ''), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `GRN-${String(max + 1).padStart(4, '0')}`;
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
