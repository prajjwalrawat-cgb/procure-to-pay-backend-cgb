import { Injectable } from '@nestjs/common';
import { Prisma } from '@procureflow/db';
import {
  DOMAIN_EVENTS,
  type ReceiptCreateInput,
  type ReceiptQcInput,
  type SampleInwardInput,
  type VendorReturnInput,
} from '@procureflow/shared';

import { AuditLogService } from '../audit/audit.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryLedgerService } from './inventory-ledger.service';
import { LedgerStateError, PoRequiredError } from './inventory.errors';
import { LocationService } from './location.service';
import { ProductService } from './product.service';

/**
 * PO states that can still legitimately receive goods. A DRAFT or AWAITING_
 * APPROVAL order has no commercial commitment behind it; a CANCELLED or CLOSED
 * one is finished.
 */
const RECEIVABLE_PO_STATUSES = [
  'APPROVED',
  'ISSUED',
  'ACKNOWLEDGED',
  'PARTIALLY_RECEIVED',
] as const;

/**
 * InventoryReceiptService (Slice 12b). Vendor-side movements: goods receipt
 * against a PO, the QC gate, vendor returns and sample receipts.
 *
 * This is the integration point between procurement and stock (business rule 1):
 * a VENDOR_INWARD entry must reference a PO that actually exists and is in a
 * receivable state. Challan-only receipts — which the source workbook genuinely
 * contains — are allowed but require an explicit `nonPoReceipt` flag plus a
 * reason, so they are always a deliberate act and never a silent default.
 *
 * Note this is deliberately NOT the formal Slice 5 GRN flow (AQL sampling plans,
 * weighbridge, gate entry). It is the warehouse-floor counterpart, and may carry
 * an informational `grnId` when a formal GRN also exists.
 */
@Injectable()
export class InventoryReceiptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: InventoryLedgerService,
    private readonly products: ProductService,
    private readonly locations: LocationService,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
  ) {}

  /** POST /inventory/receipts — VENDOR_INWARD. */
  async receive(input: ReceiptCreateInput, actorId: string): Promise<{ id: string }> {
    await this.products.require(input.productId);
    await this.locations.require(input.locationId);

    if (input.nonPoReceipt) {
      // Explicit override — recorded on the entry so the exception is auditable.
    } else {
      await this.assertReceivablePo(input.purchaseOrderId ?? null);
    }

    // Rejected-on-arrival stock never posts to sellable stock (business rule 2):
    // only the accepted balance moves, and the damaged portion is carried on the
    // row for the summary view's Damage Qty. column.
    const rejectedUpFront = input.qcStatus === 'REJECTED';
    const sellableQty = rejectedUpFront ? 0 : input.qty - input.damageQty;

    const remark = this.composeRemark(input.remark, [
      input.nonPoReceipt ? `Non-PO receipt: ${input.nonPoReason ?? 'no reason given'}` : null,
      input.invoiceNo ? `Invoice ${input.invoiceNo}` : null,
    ]);

    // A fully rejected or fully damaged consignment still needs a ledger row —
    // it physically arrived — so post the full quantity and immediately write
    // off the non-sellable portion. That keeps Total IN honest on the sheet.
    const id = await this.ledger.post({
      productId: input.productId,
      locationId: input.locationId,
      txnType: 'VENDOR_INWARD',
      qty: input.qty,
      vendorId: input.vendorId ?? null,
      purchaseOrderId: input.purchaseOrderId ?? null,
      invoiceId: input.invoiceId ?? null,
      grnId: input.grnId ?? null,
      grnNo: input.grnNo ?? null,
      rate: this.decimal(input.rate),
      taxPct: this.decimal(input.taxPct),
      qcStatus: input.qcStatus,
      damageQty: input.damageQty,
      performedById: actorId,
      remark,
      txnDate: input.txnDate ? new Date(input.txnDate) : null,
    });

    const nonSellable = input.qty - sellableQty;
    if (nonSellable > 0) {
      await this.ledger.post({
        productId: input.productId,
        locationId: input.locationId,
        txnType: 'DAMAGE_WRITE_OFF',
        qty: nonSellable,
        performedById: actorId,
        correctionOfId: id,
        remark: rejectedUpFront
          ? 'QC rejected on arrival — held for disposition, not sellable stock'
          : 'Damaged on arrival',
        txnDate: input.txnDate ? new Date(input.txnDate) : null,
        // The receipt above already added this quantity in the same transaction.
        allowNegativeStock: true,
      });
    }

    await this.audit.record({
      action: 'INVENTORY_RECEIPT_POSTED',
      entityType: 'StockLedgerEntry',
      entityId: id,
      actorId,
      after: {
        productId: input.productId,
        qty: input.qty,
        purchaseOrderId: input.purchaseOrderId ?? null,
        nonPoReceipt: input.nonPoReceipt,
        qcStatus: input.qcStatus,
        damageQty: input.damageQty,
      },
    });
    return { id };
  }

  /**
   * POST /inventory/receipts/:id/qc — the QC gate (business rule 2).
   *
   * Rejected quantity does not post to sellable stock: it routes to a pending
   * disposition, either back to the vendor for repair (VENDOR_RETURN_OUT,
   * mirroring the observed "Return For Repair" flow) or a write-off.
   */
  async recordQc(
    entryId: string,
    input: ReceiptQcInput,
    actorId: string,
  ): Promise<{ ok: true; dispositionEntryId: string | null }> {
    const entry = await this.requireInwardEntry(entryId);
    if (entry.qcStatus !== 'PENDING') {
      throw new LedgerStateError(
        `Receipt already has a QC verdict of ${entry.qcStatus}. Post a correcting ADJUSTMENT instead.`,
      );
    }

    const rejectedQty = input.qcStatus === 'REJECTED' ? (input.rejectedQty ?? entry.qty) : 0;
    if (rejectedQty > entry.qty) {
      throw new LedgerStateError(
        `Rejected quantity ${rejectedQty} exceeds the received quantity ${entry.qty}.`,
      );
    }

    // qc_status is one of the three workflow columns the immutability trigger
    // deliberately leaves mutable — it carries no stock arithmetic.
    await this.prisma.client.stockLedgerEntry.update({
      where: { id: entryId },
      data: { qcStatus: input.qcStatus },
    });

    let dispositionEntryId: string | null = null;
    if (rejectedQty > 0) {
      dispositionEntryId = await this.ledger.post({
        productId: entry.productId,
        locationId: entry.locationId,
        txnType:
          input.disposition === 'RETURN_TO_VENDOR' ? 'VENDOR_RETURN_OUT' : 'DAMAGE_WRITE_OFF',
        qty: rejectedQty,
        vendorId: entry.vendorId,
        purchaseOrderId: entry.purchaseOrderId,
        grnNo: entry.grnNo,
        correctionOfId: entryId,
        performedById: actorId,
        remark: this.composeRemark(input.remark, [
          `QC rejected on receipt ${entryId}`,
          input.disposition === 'RETURN_TO_VENDOR' ? 'Return for repair' : 'Written off',
        ]),
      });

      await this.events.emit(DOMAIN_EVENTS.INVENTORY_QC_REJECTED, {
        entryId,
        dispositionEntryId,
        productId: entry.productId,
        rejectedQty,
        disposition: input.disposition ?? 'WRITE_OFF',
      });
    }

    await this.audit.record({
      action: 'INVENTORY_RECEIPT_QC_RECORDED',
      entityType: 'StockLedgerEntry',
      entityId: entryId,
      actorId,
      before: { qcStatus: entry.qcStatus },
      after: { qcStatus: input.qcStatus, rejectedQty, disposition: input.disposition ?? null },
    });
    return { ok: true, dispositionEntryId };
  }

  /** POST /inventory/vendor-returns — VENDOR_RETURN_OUT (gate pass out). */
  async vendorReturn(
    input: VendorReturnInput,
    actorId: string,
  ): Promise<{ id: string }> {
    await this.products.require(input.productId);
    await this.locations.require(input.locationId);

    const id = await this.ledger.post({
      productId: input.productId,
      locationId: input.locationId,
      txnType: 'VENDOR_RETURN_OUT',
      qty: input.qty,
      vendorId: input.vendorId ?? null,
      rmaId: input.rmaId ?? null,
      gatePassNo: input.gatePassNo ?? null,
      tentativeReturnDate: input.tentativeReturnDate
        ? new Date(input.tentativeReturnDate)
        : null,
      performedById: actorId,
      remark: this.composeRemark(input.remark, [
        input.purpose ? `Purpose: ${input.purpose}` : null,
        input.invoiceNo ? `Against ${input.invoiceNo}` : null,
      ]),
      txnDate: input.txnDate ? new Date(input.txnDate) : null,
    });

    await this.audit.record({
      action: 'INVENTORY_VENDOR_RETURN_POSTED',
      entityType: 'StockLedgerEntry',
      entityId: id,
      actorId,
      after: { productId: input.productId, qty: input.qty, purpose: input.purpose ?? null },
    });
    return { id };
  }

  /**
   * POST /inventory/samples — SAMPLE_INWARD. Samples are tracked but are not
   * sellable stock in the business sense; they are kept in the ledger so the
   * Sample Inward Sheet stays reproducible.
   */
  async sampleInward(
    input: SampleInwardInput,
    actorId: string,
  ): Promise<{ id: string }> {
    await this.products.require(input.productId);
    await this.locations.require(input.locationId);

    const id = await this.ledger.post({
      productId: input.productId,
      locationId: input.locationId,
      txnType: 'SAMPLE_INWARD',
      qty: input.qty,
      vendorId: input.vendorId ?? null,
      rate: this.decimal(input.rate),
      qcStatus: input.qcStatus,
      performedById: actorId,
      remark: input.remark ?? null,
      txnDate: input.txnDate ? new Date(input.txnDate) : null,
    });

    await this.audit.record({
      action: 'INVENTORY_SAMPLE_RECEIVED',
      entityType: 'StockLedgerEntry',
      entityId: id,
      actorId,
      after: { productId: input.productId, qty: input.qty },
    });
    return { id };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Business rule 1 — no freeform vendor receiving without a live PO. */
  private async assertReceivablePo(purchaseOrderId: string | null): Promise<void> {
    if (!purchaseOrderId) {
      throw new PoRequiredError(
        'A goods receipt requires a purchase order. Set nonPoReceipt=true with a reason for a Challan-only receipt.',
      );
    }
    const po = await this.prisma.client.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      select: { id: true, number: true, status: true },
    });
    if (!po) {
      throw new PoRequiredError(`Purchase order ${purchaseOrderId} does not exist.`);
    }
    if (!RECEIVABLE_PO_STATUSES.includes(po.status as (typeof RECEIVABLE_PO_STATUSES)[number])) {
      throw new PoRequiredError(
        `Purchase order ${po.number} is ${po.status} and cannot receive goods.`,
        { purchaseOrderId, status: po.status, receivable: RECEIVABLE_PO_STATUSES },
      );
    }
  }

  private async requireInwardEntry(entryId: string) {
    const entry = await this.prisma.client.stockLedgerEntry.findUnique({
      where: { id: entryId },
    });
    if (!entry) throw new LedgerStateError(`Ledger entry ${entryId} not found.`);
    if (entry.txnType !== 'VENDOR_INWARD' && entry.txnType !== 'SAMPLE_INWARD') {
      throw new LedgerStateError(
        `QC applies to receipts only; entry ${entryId} is a ${entry.txnType}.`,
      );
    }
    return entry;
  }

  private decimal(value: string | null | undefined): Prisma.Decimal | null {
    return value === null || value === undefined ? null : new Prisma.Decimal(value);
  }

  /** Fold contextual notes into the free-text remark without losing the input. */
  private composeRemark(
    base: string | null | undefined,
    extras: (string | null)[],
  ): string | null {
    const parts = [base?.trim() || null, ...extras].filter(Boolean);
    return parts.length > 0 ? parts.join(' | ') : null;
  }
}
