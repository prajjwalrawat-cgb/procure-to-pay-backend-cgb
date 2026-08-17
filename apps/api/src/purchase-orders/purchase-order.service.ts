import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import {
  computeDocTax,
  DOMAIN_EVENTS,
  type PoCreateFromContractInput,
  type PoCreateFromPrInput,
  type PoCreateInput,
  type PoCreateSpotBuyInput,
  type PoUpdateInput,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import { NotificationService } from '../approvals/notification.service';
import { AuditLogService } from '../audit/audit.service';
import { BudgetService } from '../budgets/budget.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { StorageService } from '../common/storage/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { PoDocumentService } from './po-document.service';
import { PoTermsService } from './po-terms.service';
import {
  NotImplementedError,
  PurchaseOrderStateError,
  PurchaseOrderValidationError,
  VendorNotEligibleError,
} from './purchase-order.errors';
import { defaultPlantQuery } from '../common/plants/default-plant';

const ISSUED_OR_BEYOND = [
  'ISSUED',
  'ACKNOWLEDGED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'PARTIALLY_INVOICED',
  'INVOICED',
  'CLOSED',
];

/**
 * PurchaseOrderService (Slice 4). Creates POs from an approved PR (split-award
 * supported) or as a spot buy, routes them through the Slice 2 approval engine,
 * and issues them — generating a signed PDF and transferring budget from the PR.
 */
@Injectable()
export class PurchaseOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
    private readonly routing: ApprovalRoutingService,
    private readonly budgets: BudgetService,
    private readonly storage: StorageService,
    private readonly pdf: PoDocumentService,
    private readonly notifications: NotificationService,
    private readonly terms: PoTermsService,
  ) {}

  /** Dispatch the union create schema (from-PR, spot-buy, or contract call-off). */
  /**
   * The GST registration an order bills to, resolved once at creation and
   * stored on the row.
   *
   * Pinned rather than derived on read: the place of supply is part of what was
   * agreed when the order went out, so editing a requisition's branch later
   * must not silently re-tax an issued PO. Precedence is the caller's explicit
   * choice, then the requisition's branch, then the tenant's default.
   */
  private async resolveBillToPlant(
    explicitId: string | null | undefined,
    requisitionPlantId?: string | null,
  ): Promise<{ id: string; stateCode: string } | null> {
    if (explicitId) {
      const chosen = await this.prisma.client.plant.findFirst({
        where: { id: explicitId, tenantId: this.tenantId() },
        select: { id: true, stateCode: true },
      });
      if (!chosen) {
        throw new PurchaseOrderStateError('That GST registration does not exist.', {
          billToPlantId: explicitId,
        });
      }
      return chosen;
    }
    if (requisitionPlantId) {
      const fromPr = await this.prisma.client.plant.findFirst({
        where: { id: requisitionPlantId, tenantId: this.tenantId() },
        select: { id: true, stateCode: true },
      });
      if (fromPr) return fromPr;
    }
    return this.prisma.client.plant.findFirst({
      ...defaultPlantQuery(this.tenantId()),
      select: { id: true, stateCode: true },
    });
  }

  async create(input: PoCreateInput, actorId: string): Promise<{ id: string }> {
    if (input.kind === 'FROM_PR') return this.createFromRequisition(input, actorId);
    if (input.kind === 'FROM_CONTRACT') return this.createFromContract(input, actorId);
    return this.createSpotBuy(input, actorId);
  }

  /**
   * Create a PO as a call-off against an active contract (Slice 9). Parallels
   * `createFromRequisition` but sources every unit price from the contract's rate
   * card — there is deliberately no price argument, so no override path exists at
   * the API layer (ADR-029). In-terms call-offs skip the standard PO approval
   * matrix (ADR-030) and are issued directly.
   */
  async createFromContract(
    input: PoCreateFromContractInput,
    actorId: string,
  ): Promise<{ id: string }> {
    const contract = await this.prisma.client.contract.findUnique({
      where: { id: input.contractId },
      include: { rateCards: true },
    });
    if (!contract) throw new NotFoundException('Contract not found');
    if (contract.status !== 'ACTIVE') {
      throw new PurchaseOrderValidationError('Contract is not active for call-offs.', {
        status: contract.status,
      });
    }
    const now = new Date();
    if (now < contract.validityStart || now > contract.validityEnd) {
      throw new PurchaseOrderValidationError('Contract is outside its validity window.');
    }
    const vendor = await this.requireEligibleVendor(contract.vendorId);

    const cardById = new Map(contract.rateCards.map((r) => [r.id, r]));
    const lines = input.lines.map((line, idx) => {
      const card = cardById.get(line.contractRateCardId);
      if (!card) {
        throw new PurchaseOrderValidationError('Rate card not found on this contract.', {
          rateCardId: line.contractRateCardId,
        });
      }
      if (now < card.effectiveFrom || now > card.effectiveTo) {
        throw new PurchaseOrderValidationError(
          'Rate card is outside its current validity.',
          {
            rateCardId: card.id,
          },
        );
      }
      const qty = new Decimal(line.qtyOrdered);
      if (qty.lessThanOrEqualTo(0)) {
        throw new PurchaseOrderValidationError('Quantity must be greater than zero.');
      }
      if (card.volumeBandMin && qty.lessThan(card.volumeBandMin.toString())) {
        throw new PurchaseOrderValidationError(
          'Quantity is below the rate-card volume band.',
          {
            rateCardId: card.id,
            band: card.volumeBandMin.toString(),
          },
        );
      }
      if (card.volumeBandMax && qty.greaterThan(card.volumeBandMax.toString())) {
        throw new PurchaseOrderValidationError(
          'Quantity is above the rate-card volume band.',
          {
            rateCardId: card.id,
            band: card.volumeBandMax.toString(),
          },
        );
      }
      return {
        id: newId('purchaseOrderLine'),
        tenantId: this.tenantId(),
        lineNo: idx + 1,
        contractLineId: card.id,
        itemId: card.itemId,
        itemDesc: card.itemDesc,
        hsnCode: null,
        uom: card.uom,
        qtyOrdered: new Prisma.Decimal(line.qtyOrdered),
        unitPrice: card.unitRate, // locked from the rate card — never caller-supplied
        discountPct: new Prisma.Decimal('0'),
        taxRate: card.taxRate,
        glAccount: null,
        deliveryDateLine: null,
      };
    });

    const plant = await this.resolveBillToPlant(input.billToPlantId);
    const tax = computeDocTax(
      lines.map((l) => ({
        qty: l.qtyOrdered.toString(),
        unitPrice: l.unitPrice.toString(),
        taxRate: l.taxRate.toString(),
      })),
      { plantStateCode: plant?.stateCode ?? '', vendorGstin: vendor.gstin },
    );

    const skip = contract.skipPoApprovalWithinContract;
    const id = newId('purchaseOrder');
    const number = await this.nextNumber();
    await this.prisma.client.purchaseOrder.create({
      data: {
        id,
        tenantId: this.tenantId(),
        number,
        vendorId: contract.vendorId,
        contractId: contract.id,
        status: skip ? 'APPROVED' : 'DRAFT',
        poType: 'CONTRACT_CALLOFF',
        billToPlantId: plant?.id ?? null,
        totalAmount: new Prisma.Decimal(tax.total),
        taxAmount: new Prisma.Decimal(tax.taxAmount),
        currency: contract.currency,
        deliveryAddress: (input.deliveryAddress ?? null) as Prisma.InputJsonValue,
        deliveryTerms: input.deliveryTerms,
        paymentTermsSnapshot: (contract.paymentTermsSnapshot ??
          Prisma.JsonNull) as Prisma.InputJsonValue,
        expectedDeliveryDate: new Date(input.expectedDeliveryDate),
        expectedAt: new Date(input.expectedDeliveryDate),
        createdBy: actorId,
        lines: { createMany: { data: lines } },
      },
    });

    await this.audit.record({
      action: 'PO_CREATED_FROM_CONTRACT',
      entityType: 'PurchaseOrder',
      entityId: id,
      actorId,
      after: { number, contract: contract.number, vendor: vendor.name, total: tax.total },
    });
    await this.events.emit(DOMAIN_EVENTS.PURCHASE_ORDER_DRAFTED, {
      poId: id,
      requisitionId: null,
      vendorId: contract.vendorId,
    });

    if (skip) {
      // In-terms call-off: bypass the approval matrix and issue immediately.
      await this.issue(id, actorId);
    } else {
      await this.submitForApproval(id, actorId);
    }
    return { id };
  }

  async createFromRequisition(
    input: PoCreateFromPrInput,
    actorId: string,
  ): Promise<{ id: string }> {
    const pr = await this.prisma.client.requisition.findUnique({
      where: { id: input.requisitionId },
      include: { lines: true, plant: true },
    });
    if (!pr) throw new NotFoundException('Requisition not found');
    if (pr.status !== 'APPROVED' && pr.status !== 'PARTIALLY_ISSUED') {
      throw new PurchaseOrderStateError(
        'Only an approved requisition can be converted to a PO.',
        { status: pr.status },
      );
    }
    const vendor = await this.requireEligibleVendor(input.vendorId);

    const prLineById = new Map(pr.lines.map((l) => [l.id, l]));
    const seen = new Set<string>();
    for (const line of input.lines) {
      if (seen.has(line.prLineId)) {
        throw new PurchaseOrderValidationError('Duplicate PR line in the same PO.', {
          prLineId: line.prLineId,
        });
      }
      seen.add(line.prLineId);
      const prLine = prLineById.get(line.prLineId);
      if (!prLine) {
        throw new PurchaseOrderValidationError('PR line not found.', {
          prLineId: line.prLineId,
        });
      }
      const remaining = new Decimal(prLine.qty.toString()).minus(
        prLine.qtyIssued.toString(),
      );
      const qty = new Decimal(line.qtyOrdered);
      if (qty.lessThanOrEqualTo(0)) {
        throw new PurchaseOrderValidationError('Quantity must be greater than zero.');
      }
      if (qty.greaterThan(remaining)) {
        throw new PurchaseOrderValidationError(
          'Ordered quantity exceeds the PR line remaining quantity.',
          {
            prLineId: line.prLineId,
            remaining: remaining.toFixed(4),
            requested: line.qtyOrdered,
          },
        );
      }
    }

    const lines = input.lines.map((line, idx) => {
      const prLine = prLineById.get(line.prLineId)!;
      const unitPrice = line.unitPrice ?? prLine.unitPrice.toString();
      const taxRate = line.taxRate ?? prLine.taxRate.toString();
      return {
        id: newId('purchaseOrderLine'),
        tenantId: this.tenantId(),
        lineNo: idx + 1,
        prLineId: line.prLineId,
        itemId: prLine.itemId,
        itemDesc: prLine.itemDesc,
        hsnCode: prLine.hsnCode,
        uom: prLine.uom,
        qtyOrdered: new Prisma.Decimal(line.qtyOrdered),
        unitPrice: new Prisma.Decimal(unitPrice),
        discountPct: new Prisma.Decimal('0'),
        taxRate: new Prisma.Decimal(taxRate),
        glAccount: line.glAccount ?? null,
        deliveryDateLine: line.deliveryDateLine ? new Date(line.deliveryDateLine) : null,
      };
    });

    const billTo = await this.resolveBillToPlant(input.billToPlantId, pr.plantId);
    const tax = computeDocTax(
      lines.map((l) => ({
        qty: l.qtyOrdered.toString(),
        unitPrice: l.unitPrice.toString(),
        taxRate: l.taxRate.toString(),
      })),
      {
        plantStateCode: billTo?.stateCode ?? pr.plant.stateCode,
        vendorGstin: vendor.gstin,
      },
    );

    const id = newId('purchaseOrder');
    const number = await this.nextNumber();
    await this.prisma.client.purchaseOrder.create({
      data: {
        id,
        tenantId: this.tenantId(),
        number,
        vendorId: input.vendorId,
        requisitionId: input.requisitionId,
        billToPlantId: billTo?.id ?? null,
        status: 'DRAFT',
        poType: 'STANDARD',
        totalAmount: new Prisma.Decimal(tax.total),
        taxAmount: new Prisma.Decimal(tax.taxAmount),
        currency: pr.currency,
        deliveryAddress: (input.deliveryAddress ?? null) as Prisma.InputJsonValue,
        deliveryTerms: input.deliveryTerms,
        paymentTermsSnapshot: input.paymentTerms as unknown as Prisma.InputJsonValue,
        expectedDeliveryDate: new Date(input.expectedDeliveryDate),
        expectedAt: new Date(input.expectedDeliveryDate),
        createdBy: actorId,
        lines: { createMany: { data: lines } },
      },
    });

    // Reserve the ordered qty against the PR lines (split-award tracking).
    for (const line of input.lines) {
      await this.prisma.client.requisitionLine.update({
        where: { id: line.prLineId },
        data: { qtyIssued: { increment: new Prisma.Decimal(line.qtyOrdered) } },
      });
    }
    await this.recomputePrStatus(input.requisitionId);
    await this.terms.applyLibraryDefaults(id, actorId);

    await this.audit.record({
      action: 'PO_CREATED_FROM_PR',
      entityType: 'PurchaseOrder',
      entityId: id,
      actorId,
      after: { number, prNumber: pr.number, vendor: vendor.name, total: tax.total },
    });
    await this.events.emit(DOMAIN_EVENTS.PURCHASE_ORDER_DRAFTED, {
      poId: id,
      requisitionId: input.requisitionId,
      vendorId: input.vendorId,
    });
    return { id };
  }

  async createSpotBuy(
    input: PoCreateSpotBuyInput,
    actorId: string,
  ): Promise<{ id: string }> {
    const vendor = await this.requireEligibleVendor(input.vendorId);
    // No requisition behind a spot buy, so the buyer's chosen registration —
    // or the tenant default — is the only place of supply available.
    const plant = await this.resolveBillToPlant(input.billToPlantId);

    const lines = input.lines.map((line, idx) => ({
      id: newId('purchaseOrderLine'),
      tenantId: this.tenantId(),
      lineNo: idx + 1,
      itemId: line.itemId ?? null,
      itemDesc: line.itemDesc,
      hsnCode: line.hsnCode ?? null,
      uom: line.uom,
      qtyOrdered: new Prisma.Decimal(line.qtyOrdered),
      unitPrice: new Prisma.Decimal(line.unitPrice),
      discountPct: new Prisma.Decimal(line.discountPct),
      taxRate: new Prisma.Decimal(line.taxRate),
      glAccount: line.glAccount ?? null,
    }));
    const tax = computeDocTax(
      lines.map((l) => ({
        qty: l.qtyOrdered.toString(),
        unitPrice: l.unitPrice.toString(),
        discountPct: l.discountPct.toString(),
        taxRate: l.taxRate.toString(),
      })),
      { plantStateCode: plant?.stateCode ?? '', vendorGstin: vendor.gstin },
    );

    // No value ceiling on a spot buy: procurement raises these against an
    // offline quote from a registered vendor, and the approval matrix already
    // gates by value exactly as it does for a PR-based PO. `tenant.spotBuyCeiling`
    // is retained on the model but no longer enforced here.

    const id = newId('purchaseOrder');
    const number = await this.nextNumber();
    await this.prisma.client.purchaseOrder.create({
      data: {
        id,
        tenantId: this.tenantId(),
        number,
        vendorId: input.vendorId,
        status: 'DRAFT',
        poType: 'SPOT_BUY',
        isSpotBuy: true,
        billToPlantId: plant?.id ?? null,
        totalAmount: new Prisma.Decimal(tax.total),
        taxAmount: new Prisma.Decimal(tax.taxAmount),
        currency: 'INR',
        deliveryAddress: (input.deliveryAddress ?? null) as Prisma.InputJsonValue,
        deliveryTerms: input.deliveryTerms,
        paymentTermsSnapshot: input.paymentTerms as unknown as Prisma.InputJsonValue,
        expectedDeliveryDate: new Date(input.expectedDeliveryDate),
        expectedAt: new Date(input.expectedDeliveryDate),
        createdBy: actorId,
        lines: { createMany: { data: lines } },
      },
    });
    // Reserve budget immediately (no PR to transfer from).
    await this.budgets.commitSpotBuy(input.costCenterId, id, tax.total, actorId);
    // Pre-tick the clauses legal marked as default, so the common order needs no
    // term selection at all; the buyer can still edit the set before issuing.
    await this.terms.applyLibraryDefaults(id, actorId);
    await this.audit.record({
      action: 'SPOT_BUY_CREATED',
      entityType: 'PurchaseOrder',
      entityId: id,
      actorId,
      after: { number, vendor: vendor.name, total: tax.total },
    });
    await this.events.emit(DOMAIN_EVENTS.PURCHASE_ORDER_DRAFTED, {
      poId: id,
      requisitionId: null,
      vendorId: input.vendorId,
    });
    return { id };
  }

  async updateDraft(
    id: string,
    input: PoUpdateInput,
    actorId: string,
  ): Promise<{ ok: true }> {
    const po = await this.requirePo(id);
    if (po.status !== 'DRAFT') {
      throw new PurchaseOrderStateError('Only a draft PO can be edited.', {
        status: po.status,
      });
    }
    await this.prisma.client.purchaseOrder.update({
      where: { id },
      data: {
        deliveryAddress:
          input.deliveryAddress === undefined
            ? undefined
            : (input.deliveryAddress as Prisma.InputJsonValue),
        deliveryTerms: input.deliveryTerms ?? undefined,
        paymentTermsSnapshot:
          input.paymentTerms === undefined
            ? undefined
            : (input.paymentTerms as unknown as Prisma.InputJsonValue),
        expectedDeliveryDate: input.expectedDeliveryDate
          ? new Date(input.expectedDeliveryDate)
          : undefined,
      },
    });
    await this.audit.record({
      action: 'PO_UPDATED',
      entityType: 'PurchaseOrder',
      entityId: id,
      actorId,
    });
    return { ok: true };
  }

  async submitForApproval(id: string, actorId: string): Promise<{ ok: true }> {
    const po = await this.prisma.client.purchaseOrder.findUnique({
      where: { id },
      include: { lines: true },
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    if (po.status !== 'DRAFT') {
      throw new PurchaseOrderStateError('Only a draft PO can be submitted.', {
        status: po.status,
      });
    }
    if (po.lines.length === 0) {
      throw new PurchaseOrderValidationError('Add at least one line first.');
    }
    await this.requireEligibleVendor(po.vendorId);
    await this.audit.record({
      action: 'SUBMITTED_FOR_APPROVAL',
      entityType: 'PurchaseOrder',
      entityId: id,
      actorId,
      after: { total: po.totalAmount.toString() },
    });
    await this.routing.submit('PURCHASE_ORDER', id, actorId);
    return { ok: true };
  }

  async decide(
    approvalId: string,
    decision: 'APPROVE' | 'REJECT' | 'REQUEST_CHANGES',
    comment: string | null,
    actorId: string,
  ): Promise<{ ok: true }> {
    await this.routing.decide(approvalId, decision, comment, actorId);
    return { ok: true };
  }

  async issue(id: string, actorId: string): Promise<{ ok: true }> {
    const po = await this.prisma.client.purchaseOrder.findUnique({
      where: { id },
      include: { requisition: true },
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    if (po.status !== 'APPROVED') {
      throw new PurchaseOrderStateError('Only an approved PO can be issued.', {
        status: po.status,
      });
    }

    const now = new Date();
    await this.prisma.client.purchaseOrder.update({
      where: { id },
      data: { status: 'ISSUED', issuedAt: now, issuedBy: actorId },
    });

    // Generate the signed PDF, upload, and record the hash.
    const { buffer, hash } = await this.pdf.generate(id);
    const s3Key = `${po.tenantId}/purchase-orders/${id}/${po.number}.pdf`;
    await this.storage.put(s3Key, buffer, 'application/pdf').catch(() => s3Key); // storage is best-effort in stub mode
    await this.prisma.client.purchaseOrder.update({
      where: { id },
      data: { pdfS3Key: s3Key, pdfGeneratedHash: hash },
    });

    // Move budget from the PR commitment onto this PO (spot buys are pre-committed).
    if (po.requisitionId) {
      const prCommitment = await this.prisma.client.budgetCommitment.findFirst({
        where: {
          requisitionId: po.requisitionId,
          sourceType: 'PR',
          status: { in: ['COMMITTED', 'PARTIALLY_TRANSFERRED'] },
        },
      });
      if (prCommitment) {
        await this.budgets.transferToPo(
          prCommitment.id,
          id,
          po.totalAmount.toString(),
          actorId,
        );
      }
    }

    await this.recomputePrStatus(po.requisitionId);
    await this.notifyVendor(po.vendorId, id, po.number);
    await this.audit.record({
      action: 'PO_ISSUED',
      entityType: 'PurchaseOrder',
      entityId: id,
      actorId,
      after: { number: po.number, pdfHash: hash },
    });
    await this.events.emit(DOMAIN_EVENTS.PURCHASE_ORDER_ISSUED, {
      poId: id,
      vendorId: po.vendorId,
      requisitionId: po.requisitionId,
      totalAmount: po.totalAmount.toString(),
    });
    return { ok: true };
  }

  async cancel(id: string, reason: string, actorId: string): Promise<{ ok: true }> {
    const po = await this.prisma.client.purchaseOrder.findUnique({
      where: { id },
      include: { lines: true },
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    const blocked = ['PARTIALLY_RECEIVED', 'RECEIVED', 'INVOICED', 'CLOSED', 'CANCELLED'];
    if (blocked.includes(po.status)) {
      throw new PurchaseOrderStateError('This PO can no longer be cancelled.', {
        status: po.status,
      });
    }
    const wasIssued = ISSUED_OR_BEYOND.includes(po.status);

    // Drop pending approvals + release the ordered qty back to the PR.
    await this.prisma.client.approval.deleteMany({
      where: { documentType: 'PURCHASE_ORDER', documentId: id },
    });
    for (const line of po.lines) {
      if (line.prLineId) {
        await this.prisma.client.requisitionLine.update({
          where: { id: line.prLineId },
          data: { qtyIssued: { decrement: line.qtyOrdered } },
        });
      }
    }
    await this.budgets.releaseForPo(id, reason, actorId);
    await this.prisma.client.purchaseOrder.update({
      where: { id },
      data: { status: 'CANCELLED', cancelReason: reason, cancelledAt: new Date() },
    });
    if (po.requisitionId) await this.recomputePrStatus(po.requisitionId);

    // Regenerate a watermarked PDF for issued POs; notify the vendor.
    if (wasIssued) {
      const { buffer, hash } = await this.pdf.generate(id, { watermark: 'CANCELLED' });
      const s3Key = `${po.tenantId}/purchase-orders/${id}/${po.number}-CANCELLED.pdf`;
      await this.storage.put(s3Key, buffer, 'application/pdf').catch(() => s3Key);
      await this.prisma.client.purchaseOrder.update({
        where: { id },
        data: { pdfS3Key: s3Key, pdfGeneratedHash: hash },
      });
      await this.notifyVendor(po.vendorId, id, po.number, 'PO_CANCELLED');
    }
    await this.audit.record({
      action: 'PO_CANCELLED',
      entityType: 'PurchaseOrder',
      entityId: id,
      actorId,
      before: { status: po.status },
      after: { reason },
    });
    await this.events.emit(DOMAIN_EVENTS.PURCHASE_ORDER_CANCELLED, { poId: id, reason });
    return { ok: true };
  }

  async hold(id: string, reason: string, actorId: string): Promise<{ ok: true }> {
    const po = await this.requirePo(id);
    if (!ISSUED_OR_BEYOND.includes(po.status) && po.status !== 'APPROVED') {
      throw new PurchaseOrderStateError('Only an approved/issued PO can be held.', {
        status: po.status,
      });
    }
    await this.prisma.client.purchaseOrder.update({
      where: { id },
      data: { status: 'ON_HOLD', holdReason: reason },
    });
    await this.audit.record({
      action: 'PO_HELD',
      entityType: 'PurchaseOrder',
      entityId: id,
      actorId,
      after: { reason },
    });
    return { ok: true };
  }

  /** Slice 4: amendment is stubbed — create an amendment PO instead (Slice 5.5). */
  amend(_id: string, _actorId: string): never {
    throw new NotImplementedError(
      'PO amendment is not implemented in Slice 4 (backlog: Slice 5.5).',
    );
  }

  async addComment(id: string, body: string, actorId: string): Promise<{ id: string }> {
    await this.requirePo(id);
    const commentId = newId('purchaseOrderComment');
    await this.prisma.client.purchaseOrderComment.create({
      data: {
        id: commentId,
        tenantId: this.tenantId(),
        poId: id,
        authorId: actorId,
        source: 'BUYER',
        body,
      },
    });
    return { id: commentId };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async recomputePrStatus(prId: string | null): Promise<void> {
    if (!prId) return;
    const pr = await this.prisma.client.requisition.findUnique({
      where: { id: prId },
      include: { lines: true, purchaseOrders: true },
    });
    if (!pr) return;
    if (['CANCELLED', 'REJECTED', 'CLOSED'].includes(pr.status)) return;

    const totalQty = pr.lines.reduce(
      (acc, l) => acc.plus(l.qty.toString()),
      new Decimal(0),
    );
    const totalIssued = pr.lines.reduce(
      (acc, l) => acc.plus(l.qtyIssued.toString()),
      new Decimal(0),
    );
    const activePos = pr.purchaseOrders.filter((p) => p.status !== 'CANCELLED');
    const allIssued =
      activePos.length > 0 && activePos.every((p) => ISSUED_OR_BEYOND.includes(p.status));

    let status: string;
    if (
      totalIssued.greaterThanOrEqualTo(totalQty) &&
      totalQty.greaterThan(0) &&
      allIssued
    ) {
      status = 'FULLY_ISSUED';
    } else if (totalIssued.greaterThan(0)) {
      status = 'PARTIALLY_ISSUED';
    } else {
      status = 'APPROVED';
    }
    if (status !== pr.status) {
      await this.prisma.client.requisition.update({
        where: { id: prId },
        data: { status: status as Prisma.RequisitionUpdateInput['status'] },
      });
    }
  }

  private async requireEligibleVendor(vendorId: string) {
    const vendor = await this.prisma.client.vendor.findUnique({
      where: { id: vendorId },
      include: { banks: true },
    });
    if (!vendor) throw new NotFoundException('Vendor not found');
    // Gate on the Slice-7 canonical lifecycle_status, not the legacy `status`
    // field (the two can drift; lifecycle_status is authoritative — audit I6).
    if (vendor.lifecycleStatus !== 'ACTIVE') {
      throw new VendorNotEligibleError('Vendor is not active.', {
        lifecycleStatus: vendor.lifecycleStatus,
      });
    }
    if (!vendor.banks.some((b) => b.isVerified)) {
      throw new VendorNotEligibleError('Vendor has no verified bank account.', {
        vendor: vendor.code,
      });
    }
    return vendor;
  }

  /**
   * Public eligibility guard so callers (e.g. AwardService) can pre-validate a
   * vendor before committing terminal state — throws VendorNotEligibleError if
   * the vendor is not lifecycle-ACTIVE or has no verified bank.
   */
  async assertVendorEligible(vendorId: string): Promise<void> {
    await this.requireEligibleVendor(vendorId);
  }

  private async notifyVendor(
    vendorId: string,
    poId: string,
    poNumber: string,
    type = 'PO_ISSUED',
  ): Promise<void> {
    const contacts = await this.prisma.client.vendorContact.findMany({
      where: { vendorId, email: { not: null } },
      select: { email: true },
    });
    const emails = contacts.map((c) => c.email).filter((e): e is string => !!e);
    if (emails.length === 0) return;
    const users = await this.prisma.client.user.findMany({
      where: { email: { in: emails } },
      select: { id: true },
    });
    for (const u of users) {
      await this.notifications.notify({
        userId: u.id,
        type,
        title:
          type === 'PO_CANCELLED'
            ? `Purchase order ${poNumber} cancelled`
            : `New purchase order ${poNumber}`,
        entityType: 'PurchaseOrder',
        entityId: poId,
        href: `/purchase-orders/${poId}`,
      });
    }
  }

  private async nextNumber(): Promise<string> {
    const latest = await this.prisma.client.purchaseOrder.findMany({
      where: { number: { startsWith: 'PO-' } },
      select: { number: true },
      orderBy: { number: 'desc' },
      take: 50,
    });
    let max = 495;
    for (const r of latest) {
      const n = Number.parseInt(r.number.replace('PO-', ''), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `PO-${String(max + 1).padStart(4, '0')}`;
  }

  private async requirePo(id: string) {
    const po = await this.prisma.client.purchaseOrder.findUnique({ where: { id } });
    if (!po) throw new NotFoundException('Purchase order not found');
    return po;
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
