import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { newId, type PoStatus } from '@procureflow/db';
import {
  computeDocTax,
  taxKindLabel,
  type DeliveryAddress,
  type PaymentTerms,
  type VendorPoDetailResponse,
  type VendorPoListResponse,
} from '@procureflow/shared';

import { NotificationService } from '../approvals/notification.service';
import { AuditLogService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { PoTermsService } from './po-terms.service';

/** Statuses a vendor is allowed to see (issued and beyond). */
const VENDOR_VISIBLE: PoStatus[] = [
  'ISSUED',
  'ACKNOWLEDGED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'PARTIALLY_INVOICED',
  'INVOICED',
  'CLOSED',
  'CANCELLED',
];

/**
 * Vendor-portal PO operations (Slice 4, vendor JWT audience). The vendor is
 * resolved from the logged-in user's contact record — never trusted from input
 * — and only issued POs for that vendor are visible (sanitised: no internal
 * notes, no approval trail).
 */
@Injectable()
export class VendorPoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
    private readonly terms: PoTermsService,
  ) {}

  async resolveVendorId(userId: string): Promise<string> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) throw new ForbiddenException('Not a vendor account');
    const contact = await this.prisma.client.vendorContact.findFirst({
      where: { email: user.email },
      select: { vendorId: true },
    });
    if (!contact) throw new ForbiddenException('No vendor linked to this account');
    return contact.vendorId;
  }

  async list(userId: string): Promise<VendorPoListResponse> {
    const vendorId = await this.resolveVendorId(userId);
    const rows = await this.prisma.client.purchaseOrder.findMany({
      where: { vendorId, status: { in: VENDOR_VISIBLE } },
      orderBy: { issuedAt: 'desc' },
      include: { lines: true },
      take: 100,
    });
    return {
      items: rows.map((po) => ({
        id: po.id,
        number: po.number,
        description: po.lines[0]?.itemDesc ?? '—',
        orderedDate: po.issuedAt?.toISOString() ?? null,
        expectedDeliveryDate: po.expectedDeliveryDate?.toISOString() ?? null,
        fulfilmentPct: 0,
        totalAmount: po.totalAmount.toString(),
        currency: po.currency,
        status: po.status,
        acknowledged: !!po.acknowledgedAt,
      })),
      nextCursor: null,
      totalEstimate: rows.length,
    };
  }

  async detail(userId: string, poId: string): Promise<VendorPoDetailResponse> {
    const vendorId = await this.resolveVendorId(userId);
    const po = await this.requireVendorPo(poId, vendorId);
    const plant = await this.prisma.client.plant.findFirst({
      where: { tenantId: po.tenantId },
    });
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
      status: po.status,
      orderedDate: po.issuedAt?.toISOString() ?? null,
      expectedDeliveryDate: po.expectedDeliveryDate?.toISOString() ?? null,
      deliveryAddress: (po.deliveryAddress as unknown as DeliveryAddress | null) ?? null,
      deliveryTerms: po.deliveryTerms,
      paymentTerms: (po.paymentTermsSnapshot as unknown as PaymentTerms | null) ?? null,
      lines: po.lines.map((l) => ({
        lineNo: l.lineNo,
        itemDesc: l.itemDesc,
        hsnCode: l.hsnCode,
        uom: l.uom,
        qtyOrdered: l.qtyOrdered.toString(),
        unitPrice: l.unitPrice.toString(),
        taxRate: l.taxRate.toString(),
        lineTotal: l.lineTotal.toString(),
      })),
      amounts: {
        subtotal: tax.subtotal,
        taxAmount: tax.taxAmount,
        taxKind: taxKindLabel(tax.taxKind),
        total: tax.total,
        currency: po.currency,
      },
      acknowledgedAt: po.acknowledgedAt?.toISOString() ?? null,
      pdfAvailable: !!po.pdfS3Key,
      // The conditions the vendor is acknowledging against — same rows the PDF
      // prints. Supporting documents are NOT exposed here.
      terms: await this.terms.list(poId),
      queries: po.comments
        .filter((c) => c.isQuery)
        .map((c) => ({
          id: c.id,
          body: c.body,
          source: c.source,
          createdAt: c.createdAt.toISOString(),
        })),
    };
  }

  async acknowledge(userId: string, poId: string): Promise<{ acknowledgedAt: string }> {
    const vendorId = await this.resolveVendorId(userId);
    const po = await this.requireVendorPo(poId, vendorId);
    if (po.acknowledgedAt) {
      // Idempotent-style: report the existing timestamp with a 409.
      throw new ConflictException({
        message: 'Purchase order already acknowledged.',
        acknowledgedAt: po.acknowledgedAt.toISOString(),
      });
    }
    const now = new Date();
    await this.prisma.client.purchaseOrder.update({
      where: { id: poId },
      data: { status: 'ACKNOWLEDGED', acknowledgedAt: now, acknowledgedBy: userId },
    });
    await this.audit.record({
      action: 'PO_ACKNOWLEDGED',
      entityType: 'PurchaseOrder',
      entityId: poId,
      actorId: userId,
      after: { acknowledgedAt: now.toISOString() },
    });
    return { acknowledgedAt: now.toISOString() };
  }

  async raiseQuery(userId: string, poId: string, body: string): Promise<{ id: string }> {
    const vendorId = await this.resolveVendorId(userId);
    const po = await this.requireVendorPo(poId, vendorId);
    const id = newId('purchaseOrderComment');
    await this.prisma.client.purchaseOrderComment.create({
      data: {
        id,
        tenantId: po.tenantId,
        poId,
        authorId: userId,
        source: 'VENDOR',
        isQuery: true,
        body,
      },
    });
    await this.audit.record({
      action: 'PO_VENDOR_QUERY',
      entityType: 'PurchaseOrder',
      entityId: poId,
      actorId: userId,
      after: { commentId: id },
    });
    // Notify the buyer who created the PO so they can respond within SLA.
    if (po.createdBy) {
      await this.notifications.notify({
        userId: po.createdBy,
        tenantId: po.tenantId,
        type: 'PO_VENDOR_QUERY',
        title: `Vendor query on ${po.number}`,
        entityType: 'PurchaseOrder',
        entityId: poId,
        href: `/purchase-orders/${poId}`,
      });
    }
    return { id };
  }

  async pdfKey(userId: string, poId: string): Promise<string> {
    const vendorId = await this.resolveVendorId(userId);
    const po = await this.requireVendorPo(poId, vendorId);
    if (!po.pdfS3Key) throw new NotFoundException('No PDF available for this PO.');
    return po.pdfS3Key;
  }

  private async requireVendorPo(poId: string, vendorId: string) {
    const po = await this.prisma.client.purchaseOrder.findUnique({
      where: { id: poId },
      include: { lines: { orderBy: { lineNo: 'asc' } }, vendor: true, comments: true },
    });
    // Return 404 (not 403) for another vendor's PO — no existence disclosure.
    if (!po || po.vendorId !== vendorId || !VENDOR_VISIBLE.includes(po.status)) {
      throw new NotFoundException('Purchase order not found');
    }
    return po;
  }
}
