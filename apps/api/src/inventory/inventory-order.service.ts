import { Injectable } from '@nestjs/common';
import { Prisma } from '@procureflow/db';
import type {
  AdjustmentInput,
  CustomerReturnInput,
  DamageWriteOffInput,
  OrderFulfillInput,
  RestockDecisionInput,
} from '@procureflow/shared';

import { AuditLogService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryLedgerService } from './inventory-ledger.service';
import { LedgerStateError } from './inventory.errors';
import { LocationService } from './location.service';
import { ProductService } from './product.service';

/**
 * InventoryOrderService (Slice 12c). The customer-facing end of the ledger —
 * D2C order fulfilment, customer returns and their restock decision — plus the
 * two housekeeping movements: damage write-offs and adjustments.
 */
@Injectable()
export class InventoryOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: InventoryLedgerService,
    private readonly products: ProductService,
    private readonly locations: LocationService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * POST /inventory/orders/fulfill — CUSTOMER_ORDER_OUT (business rule 4).
   *
   * Blocked when the chosen location cannot cover the quantity. The source sheet
   * has no such control today; this is the control being added. `allowNegative
   * Stock` is the deliberate override for the cases where the floor knows better
   * than the ledger, and it is recorded on the entry so the exception is visible.
   */
  async fulfill(input: OrderFulfillInput, actorId: string): Promise<{ id: string }> {
    await this.products.require(input.productId);
    await this.locations.require(input.locationId);

    const available = await this.ledger.stockAt(input.productId, input.locationId);
    const overridden = input.allowNegativeStock && available < input.qty;

    const id = await this.ledger.post({
      productId: input.productId,
      locationId: input.locationId,
      txnType: 'CUSTOMER_ORDER_OUT',
      qty: input.qty,
      platform: input.platform ?? null,
      orderId: input.orderId ?? null,
      customerName: input.customerName ?? null,
      courierName: input.courierName ?? null,
      trackingId: input.trackingId ?? null,
      paymentMode: input.paymentMode ?? null,
      orderValue: input.orderValue ? new Prisma.Decimal(input.orderValue) : null,
      performedById: actorId,
      remark: overridden
        ? [input.remark?.trim(), `Stock-check overridden (${available} on hand)`]
            .filter(Boolean)
            .join(' | ')
        : (input.remark ?? null),
      txnDate: input.txnDate ? new Date(input.txnDate) : null,
      allowNegativeStock: input.allowNegativeStock,
    });

    await this.audit.record({
      action: overridden
        ? 'INVENTORY_ORDER_FULFILLED_OVERRIDE'
        : 'INVENTORY_ORDER_FULFILLED',
      entityType: 'StockLedgerEntry',
      entityId: id,
      actorId,
      after: {
        productId: input.productId,
        qty: input.qty,
        orderId: input.orderId ?? null,
        platform: input.platform ?? null,
        availableBefore: available,
        overridden,
      },
    });
    return { id };
  }

  /**
   * POST /inventory/returns — CUSTOMER_RETURN_IN (business rule 5).
   *
   * The goods are physically back, so the entry posts inward immediately, but it
   * lands with `restockDecision = null`: pending. Until someone decides, it shows
   * in the pending-restock queue.
   */
  async customerReturn(
    input: CustomerReturnInput,
    actorId: string,
  ): Promise<{ id: string }> {
    await this.products.require(input.productId);
    await this.locations.require(input.locationId);

    const id = await this.ledger.post({
      productId: input.productId,
      locationId: input.locationId,
      txnType: 'CUSTOMER_RETURN_IN',
      qty: input.qty,
      orderId: input.orderId ?? null,
      customerName: input.customerName ?? null,
      returnReason: input.returnReason ?? null,
      productCondition: input.productCondition ?? null,
      restockDecision: null,
      performedById: actorId,
      remark: input.remark ?? null,
      txnDate: input.txnDate ? new Date(input.txnDate) : null,
    });

    await this.audit.record({
      action: 'INVENTORY_CUSTOMER_RETURN_RECEIVED',
      entityType: 'StockLedgerEntry',
      entityId: id,
      actorId,
      after: {
        productId: input.productId,
        qty: input.qty,
        orderId: input.orderId ?? null,
        productCondition: input.productCondition ?? null,
      },
    });
    return { id };
  }

  /**
   * POST /inventory/returns/:id/restock-decision.
   *
   * `restock = true` leaves the returned quantity in sellable stock (the return
   * entry already added it). `restock = false` posts a DAMAGE_WRITE_OFF that
   * takes it straight back out — matching the sheet's Restock Y/N behaviour
   * without ever rewriting the original return row.
   */
  async restockDecision(
    entryId: string,
    input: RestockDecisionInput,
    actorId: string,
  ): Promise<{ ok: true; writeOffEntryId: string | null }> {
    const entry = await this.prisma.client.stockLedgerEntry.findUnique({
      where: { id: entryId },
    });
    if (!entry) throw new LedgerStateError(`Return ${entryId} not found.`);
    if (entry.txnType !== 'CUSTOMER_RETURN_IN') {
      throw new LedgerStateError(
        `Entry ${entryId} is a ${entry.txnType}, not a customer return.`,
      );
    }
    if (entry.restockDecision !== null) {
      throw new LedgerStateError(
        `A restock decision (${entry.restockDecision ? 'restock' : 'write off'}) has already been recorded for this return.`,
      );
    }

    // restock_decision is one of the three workflow columns the immutability
    // trigger leaves mutable — it carries no stock arithmetic of its own.
    await this.prisma.client.stockLedgerEntry.update({
      where: { id: entryId },
      data: { restockDecision: input.restock },
    });

    let writeOffEntryId: string | null = null;
    if (!input.restock) {
      writeOffEntryId = await this.ledger.post({
        productId: entry.productId,
        locationId: entry.locationId,
        txnType: 'DAMAGE_WRITE_OFF',
        qty: entry.qty,
        orderId: entry.orderId,
        correctionOfId: entryId,
        performedById: actorId,
        remark: [
          `Customer return ${entryId} not restocked`,
          entry.productCondition ? `Condition: ${entry.productCondition}` : null,
          input.remark?.trim() || null,
        ]
          .filter(Boolean)
          .join(' | '),
      });
    }

    await this.audit.record({
      action: 'INVENTORY_RESTOCK_DECISION_RECORDED',
      entityType: 'StockLedgerEntry',
      entityId: entryId,
      actorId,
      after: { restock: input.restock, writeOffEntryId },
    });
    return { ok: true, writeOffEntryId };
  }

  /** POST /inventory/damage — DAMAGE_WRITE_OFF. */
  async writeOffDamage(
    input: DamageWriteOffInput,
    actorId: string,
  ): Promise<{ id: string }> {
    await this.products.require(input.productId);
    await this.locations.require(input.locationId);

    const id = await this.ledger.post({
      productId: input.productId,
      locationId: input.locationId,
      txnType: 'DAMAGE_WRITE_OFF',
      qty: input.qty,
      performedById: actorId,
      remark: [input.reason.trim(), input.remark?.trim() || null].filter(Boolean).join(' | '),
      txnDate: input.txnDate ? new Date(input.txnDate) : null,
    });

    await this.audit.record({
      action: 'INVENTORY_DAMAGE_WRITTEN_OFF',
      entityType: 'StockLedgerEntry',
      entityId: id,
      actorId,
      after: { productId: input.productId, qty: input.qty, reason: input.reason },
    });
    return { id };
  }

  /**
   * POST /inventory/adjustments — ADJUSTMENT.
   *
   * The only signed movement, and the only way to fix a mistake (business rule
   * 6): pass `correctionOfId` and the compensating entry is linked to the entry
   * it offsets, so the audit trail shows both sides.
   */
  async adjust(input: AdjustmentInput, actorId: string): Promise<{ id: string }> {
    await this.products.require(input.productId);
    await this.locations.require(input.locationId);

    if (input.correctionOfId) {
      const original = await this.prisma.client.stockLedgerEntry.findUnique({
        where: { id: input.correctionOfId },
        select: { id: true },
      });
      if (!original) {
        throw new LedgerStateError(
          `Cannot correct ${input.correctionOfId}: no such ledger entry.`,
        );
      }
    }

    const id = await this.ledger.post({
      productId: input.productId,
      locationId: input.locationId,
      txnType: 'ADJUSTMENT',
      signedQty: input.signedQty,
      correctionOfId: input.correctionOfId ?? null,
      performedById: actorId,
      remark: input.reason.trim(),
      txnDate: input.txnDate ? new Date(input.txnDate) : null,
      // An adjustment is how a stock count is reconciled, so it is allowed to
      // take a location negative — that is the discrepancy being recorded.
      allowNegativeStock: true,
    });

    await this.audit.record({
      action: input.correctionOfId
        ? 'INVENTORY_CORRECTION_POSTED'
        : 'INVENTORY_ADJUSTMENT_POSTED',
      entityType: 'StockLedgerEntry',
      entityId: id,
      actorId,
      after: {
        productId: input.productId,
        signedQty: input.signedQty,
        reason: input.reason,
        correctionOfId: input.correctionOfId ?? null,
      },
    });
    return { id };
  }
}
