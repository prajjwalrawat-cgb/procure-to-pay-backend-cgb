import { Injectable, NotFoundException } from '@nestjs/common';
import type { VendorPoOption } from '@procureflow/shared';

import { PrismaService } from '../prisma/prisma.service';
import { TdsService } from './domain/tds.service';

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
      include: { lines: { orderBy: { lineNo: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
    return pos.map((po) => ({
      id: po.id,
      number: po.number,
      lines: po.lines.map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        itemDesc: l.itemDesc,
        uom: l.uom,
        qtyOrdered: l.qtyOrdered.toString(),
        unitPrice: l.unitPrice.toString(),
        taxRate: l.taxRate.toString(),
      })),
    }));
  }
}
