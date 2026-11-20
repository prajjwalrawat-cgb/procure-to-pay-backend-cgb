import { Global, Injectable, Module } from '@nestjs/common';
import type { PoStatus } from '@procureflow/db';
import Decimal from 'decimal.js';

import { AuditLogService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The post-issue states this service owns. Everything before issue (draft,
 * approval), ON_HOLD and CANCELLED are set by explicit actions and are never
 * overwritten here.
 */
const DERIVED: PoStatus[] = [
  'ISSUED',
  'ACKNOWLEDGED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'PARTIALLY_INVOICED',
  'INVOICED',
  'CLOSED',
];

/** ₹ an order's invoices may fall short of its value and still count as billed in full. */
const VALUE_ROUNDING = new Decimal(1);

/**
 * Keeps `PurchaseOrder.status` in step with what has happened against the
 * order after issue — the single writer for the post-issue states.
 *
 * Precedence, latest stage first:
 *   CLOSED              billed in full and every live invoice PAID
 *   INVOICED            billed in full (by linked quantity, or by value)
 *   PARTIALLY_INVOICED  at least one live (non-rejected) invoice
 *   RECEIVED / PARTIALLY_RECEIVED   from posted GRN quantities
 *   ACKNOWLEDGED / ISSUED           otherwise
 *
 * Closing does not require a goods receipt: the tenant currently accepts the
 * "no goods receipt" match exception and pays without GRNs. Receipt progress
 * stays visible on the order through its own derived axis (`fulfilment`).
 *
 * Fully derived, so it also walks back: rejecting an invoice or reversing a
 * GRN recomputes to the right earlier state. Callers invoke it after anything
 * that changes an order's receipts, invoices, invoice lines or payments.
 */
@Injectable()
export class PoStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async recompute(
    poId: string | null | undefined,
    actorId?: string | null,
  ): Promise<void> {
    if (!poId) return;
    const po = await this.prisma.client.purchaseOrder.findUnique({
      where: { id: poId },
      select: {
        id: true,
        tenantId: true,
        status: true,
        acknowledgedAt: true,
        totalAmount: true,
        lines: { select: { id: true, qtyOrdered: true, qtyReceived: true } },
      },
    });
    if (!po || !DERIVED.includes(po.status)) return;

    const invoices = await this.prisma.client.invoice.findMany({
      where: { poId, status: { not: 'REJECTED' } },
      select: {
        status: true,
        grossAmount: true,
        lines: { select: { poLineId: true, qty: true } },
      },
    });

    const next = PoStatusService.derive(po, invoices);
    if (next === po.status) return;

    await this.prisma.client.purchaseOrder.update({
      where: { id: poId },
      data: { status: next },
    });
    await this.audit.record({
      action: 'PO_STATUS_CHANGED',
      entityType: 'PurchaseOrder',
      entityId: poId,
      ...(actorId ? { actorId } : { actorType: 'SYSTEM' as const }),
      tenantId: po.tenantId,
      before: { status: po.status },
      after: { status: next, invoices: invoices.length },
    });
  }

  static derive(
    po: {
      acknowledgedAt: Date | null;
      totalAmount: { toString(): string };
      lines: {
        id: string;
        qtyOrdered: { toString(): string };
        qtyReceived: { toString(): string };
      }[];
    },
    invoices: {
      status: string;
      grossAmount: { toString(): string };
      lines: { poLineId: string | null; qty: { toString(): string } }[];
    }[],
  ): PoStatus {
    const sum = (xs: Decimal[]): Decimal =>
      xs.reduce((a, x) => a.plus(x), new Decimal(0));
    const ordered = sum(po.lines.map((l) => new Decimal(l.qtyOrdered.toString())));

    if (invoices.length > 0) {
      const ownLines = new Set(po.lines.map((l) => l.id));
      const billedQty = sum(
        invoices.flatMap((i) =>
          i.lines
            .filter((l) => l.poLineId && ownLines.has(l.poLineId))
            .map((l) => new Decimal(l.qty.toString())),
        ),
      );
      const billedValue = sum(invoices.map((i) => new Decimal(i.grossAmount.toString())));
      const orderValue = new Decimal(po.totalAmount.toString());
      const fullyBilled =
        (ordered.greaterThan(0) && billedQty.greaterThanOrEqualTo(ordered)) ||
        (orderValue.greaterThan(0) &&
          billedValue.greaterThanOrEqualTo(orderValue.minus(VALUE_ROUNDING)));

      if (!fullyBilled) return 'PARTIALLY_INVOICED';
      return invoices.every((i) => i.status === 'PAID') ? 'CLOSED' : 'INVOICED';
    }

    const received = sum(po.lines.map((l) => new Decimal(l.qtyReceived.toString())));
    const allReceived =
      po.lines.length > 0 &&
      po.lines.every((l) =>
        new Decimal(l.qtyReceived.toString()).greaterThanOrEqualTo(
          l.qtyOrdered.toString(),
        ),
      );
    if (allReceived) return 'RECEIVED';
    if (received.greaterThan(0)) return 'PARTIALLY_RECEIVED';
    return po.acknowledgedAt ? 'ACKNOWLEDGED' : 'ISSUED';
  }
}

/** Global so GRN, invoice, approval and payment modules can all keep POs in step. */
@Global()
@Module({
  providers: [PoStatusService],
  exports: [PoStatusService],
})
export class PoStatusModule {}
