import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@procureflow/db';
import { computeDocTax, taxKindLabel, type VendorPoOption } from '@procureflow/shared';
import Decimal from 'decimal.js';

import { PrismaService } from '../prisma/prisma.service';
import { TdsService } from './domain/tds.service';
import { defaultPlantQuery } from '../common/plants/default-plant';

export type RefCard =
  | {
      kind: 'vendor';
      id: string;
      name: string;
      code: string;
      isMsme: boolean;
      riskScore: string | null;
      onTimePct: string | null;
      qualityPct: string | null;
      fytdSpend: string;
      status: string;
    }
  | {
      kind: 'po';
      id: string;
      number: string;
      status: string;
      vendorName: string;
      total: string;
    }
  | { kind: 'grn'; id: string; number: string; qcStatus: string; receivedAt: string }
  | {
      kind: 'invoice';
      id: string;
      number: string;
      status: string;
      grossAmount: string;
      vendorName: string;
    };

/** Lazy hover-preview cards + vendor PO options (Master Context §6 hover cards). */
@Injectable()
export class RefsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tds: TdsService,
  ) {}

  async card(kind: string, id: string): Promise<RefCard> {
    switch (kind) {
      case 'vendor':
        return this.vendorCard(id);
      case 'po':
        return this.poCard(id);
      case 'grn':
        return this.grnCard(id);
      case 'invoice':
        return this.invoiceCard(id);
      default:
        throw new NotFoundException('Unknown reference kind');
    }
  }

  private async vendorCard(id: string): Promise<RefCard> {
    const v = await this.prisma.client.vendor.findUnique({ where: { id } });
    if (!v) throw new NotFoundException('Vendor not found');
    const fytd = await this.tds.priorFytdBase(v.id, new Date());
    return {
      kind: 'vendor',
      id: v.id,
      name: v.name,
      code: v.code,
      isMsme: v.isMsme,
      riskScore: v.riskScore?.toString() ?? null,
      onTimePct: v.onTimePct?.toString() ?? null,
      qualityPct: v.qualityPct?.toString() ?? null,
      fytdSpend: fytd.toFixed(2),
      status: v.status,
    };
  }

  private async poCard(id: string): Promise<RefCard> {
    const po = await this.prisma.client.purchaseOrder.findUnique({
      where: { id },
      include: { vendor: { select: { name: true } } },
    });
    if (!po) throw new NotFoundException('PO not found');
    return {
      kind: 'po',
      id: po.id,
      number: po.number,
      status: po.status,
      vendorName: po.vendor.name,
      total: po.totalAmount.toString(),
    };
  }

  private async grnCard(id: string): Promise<RefCard> {
    const grn = await this.prisma.client.goodsReceiptNote.findUnique({ where: { id } });
    if (!grn) throw new NotFoundException('GRN not found');
    return {
      kind: 'grn',
      id: grn.id,
      number: grn.number,
      qcStatus: grn.qcStatus,
      receivedAt: grn.receivedAt.toISOString(),
    };
  }

  private async invoiceCard(id: string): Promise<RefCard> {
    const inv = await this.prisma.client.invoice.findUnique({
      where: { id },
      include: { vendor: { select: { name: true } } },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    return {
      kind: 'invoice',
      id: inv.id,
      number: inv.number,
      status: inv.status,
      grossAmount: inv.grossAmount.toString(),
      vendorName: inv.vendor.name,
    };
  }

  /** Open POs owned by a vendor, for the vendor-portal submit wizard. */
  async vendorOpenPos(vendorId: string): Promise<VendorPoOption[]> {
    // A vendor may invoice any issued PO through to full invoicing — including
    // acknowledged and (fully/partially) received ones. Receiving is precisely
    // when the vendor bills, so RECEIVED must be invoiceable; only DRAFT/approval,
    // fully INVOICED, CLOSED, CANCELLED and ON_HOLD are excluded.
    const pos = await this.prisma.client.purchaseOrder.findMany({
      where: {
        vendorId,
        status: {
          in: [
            'ISSUED',
            'ACKNOWLEDGED',
            'PARTIALLY_RECEIVED',
            'RECEIVED',
            'PARTIALLY_INVOICED',
          ],
        },
      },
      include: { lines: { orderBy: { lineNo: 'asc' } }, vendor: true },
      orderBy: { createdAt: 'desc' },
    });
    // GST split is decided by delivery plant state vs vendor GSTIN state — the
    // same context VendorPoService.detail uses, so the invoice wizard quotes the
    // identical tax kind and total the supplier saw on the PO.
    const tenantId = pos[0]?.tenantId;
    const plant = tenantId
      ? await this.prisma.client.plant.findFirst(defaultPlantQuery(tenantId))
      : null;

    /*
     * How much of each line other live invoices have already claimed.
     *
     * Summed from invoice lines rather than read from
     * `PurchaseOrderLine.qtyInvoiced`, which is surfaced in three query
     * services and incremented by nothing — it is zero on every row in the
     * database. Mirrors MatchService exactly, REJECTED excluded and everything
     * else counted, so the quantity this form seeds is precisely the quantity
     * the matcher will accept. Any other basis and the form and the matcher
     * disagree about the same PO line.
     */
    const poLineIds = pos.flatMap((po) => po.lines.map((l) => l.id));
    const billedRows =
      poLineIds.length > 0
        ? await this.prisma.client.invoiceLine.groupBy({
            by: ['poLineId'],
            where: {
              poLineId: { in: poLineIds },
              invoice: { status: { notIn: ['REJECTED'] } },
            },
            _sum: { qty: true },
          })
        : [];
    const billed = new Map(
      billedRows.map((r) => [r.poLineId, new Decimal(r._sum.qty?.toString() ?? '0')]),
    );
    return (
      pos
        .map((po) => {
          const tax = computeDocTax(
            po.lines.map((l) => ({
              qty: l.qtyOrdered.toString(),
              unitPrice: l.unitPrice.toString(),
              discountPct: l.discountPct.toString(),
              taxRate: l.taxRate.toString(),
            })),
            { plantStateCode: plant?.stateCode ?? '17', vendorGstin: po.vendor.gstin },
          );
          return {
            id: po.id,
            number: po.number,
            currency: po.currency,
            /** Nothing left to bill on any line — see `exhausted` below. */
            fullyInvoiced: po.lines.every((l) =>
              new Decimal(
                billableQty(l.qtyOrdered, l.qtyReceived, billed.get(l.id)),
              ).lessThanOrEqualTo(0),
            ),
            lines: po.lines.map((l) => ({
              id: l.id,
              lineNo: l.lineNo,
              itemDesc: l.itemDesc,
              hsnCode: l.hsnCode,
              uom: l.uom,
              qtyOrdered: l.qtyOrdered.toString(),
              qtyReceived: l.qtyReceived.toString(),
              qtyInvoiced: (billed.get(l.id) ?? new Decimal(0)).toString(),
              qtyBillable: billableQty(l.qtyOrdered, l.qtyReceived, billed.get(l.id)),
              unitPrice: l.unitPrice.toString(),
              taxRate: l.taxRate.toString(),
            })),
            amounts: {
              subtotal: tax.subtotal,
              taxAmount: tax.taxAmount,
              taxKind: taxKindLabel(tax.taxKind),
              total: tax.total,
            },
          };
        })
        /*
         * A purchase order with nothing left to bill is not invoiceable.
         *
         * The status filter above already excludes INVOICED — the intent has always
         * been that a fully-billed order drops out — but nothing in the codebase
         * ever sets that status: `INVOICED` and `PARTIALLY_INVOICED` appear only in
         * read filters, never in an update. So an order stayed ISSUED forever and
         * kept accepting invoices, which is how PO-0498 came to carry 200 units
         * billed against 100 ordered.
         *
         * Filtering on remaining quantity enforces the intent without depending on
         * a status nothing maintains. A supplier who needs to bill more needs the
         * order amended — the PO is the authorisation, and billing past it is not
         * the supplier's call to make.
         */
        .filter((po) => !po.fullyInvoiced)
    );
  }
}

/**
 * What is still billable on a PO line.
 *
 * Basis is what was RECEIVED once anything has been, and what was ORDERED
 * before then — the same rule the match engine applies, so a supplier billing
 * the seeded figure clears QTY_VARIANCE rather than tripping it. Services and
 * advance billing legitimately precede any receipt, which is why nothing has
 * been received falls back to the order rather than to zero.
 *
 * Clamped at zero: a fully billed line offers nothing further.
 */
function billableQty(
  qtyOrdered: Prisma.Decimal,
  qtyReceived: Prisma.Decimal,
  alreadyBilled: Decimal | undefined,
): string {
  const received = new Decimal(qtyReceived.toString());
  const basis = received.greaterThan(0) ? received : new Decimal(qtyOrdered.toString());
  const remaining = basis.minus(alreadyBilled ?? new Decimal(0));
  return Decimal.max(remaining, new Decimal(0)).toString();
}
