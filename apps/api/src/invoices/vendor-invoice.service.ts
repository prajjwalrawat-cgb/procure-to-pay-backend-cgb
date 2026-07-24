import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { VendorInvoiceSubmitInput, VendorPoOption } from '@procureflow/shared';

import { PrismaService } from '../prisma/prisma.service';
import { InvoiceService } from './invoice.service';
import { RefsService } from './refs.service';

export interface VendorInvoiceSummary {
  id: string;
  number: string;
  vendorInvoiceRef: string;
  status: string;
  grossAmount: string;
  invoiceDate: string;
}

/**
 * Vendor-portal invoice operations. The vendor is resolved from the logged-in
 * user's primary contact record within the tenant (never trusted from input).
 */
@Injectable()
export class VendorInvoiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoiceService,
    private readonly refs: RefsService,
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

  async openPos(userId: string): Promise<VendorPoOption[]> {
    const vendorId = await this.resolveVendorId(userId);
    return this.refs.vendorOpenPos(vendorId);
  }

  async submit(
    tenantId: string,
    userId: string,
    input: VendorInvoiceSubmitInput,
  ): Promise<{ id: string }> {
    const vendorId = await this.resolveVendorId(userId);
    const id = await this.invoices.createFromVendorPortal(tenantId, vendorId, input);
    return { id };
  }

  async listOwn(userId: string): Promise<VendorInvoiceSummary[]> {
    const vendorId = await this.resolveVendorId(userId);
    const rows = await this.prisma.client.invoice.findMany({
      where: { vendorId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        number: true,
        vendorInvoiceRef: true,
        status: true,
        grossAmount: true,
        invoiceDate: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      vendorInvoiceRef: r.vendorInvoiceRef,
      status: r.status,
      grossAmount: r.grossAmount.toString(),
      invoiceDate: r.invoiceDate.toISOString(),
    }));
  }

  /** A vendor may only see their own invoices; anything else is 404 (no leak). */
  async getOwn(userId: string, invoiceId: string): Promise<VendorInvoiceSummary> {
    const vendorId = await this.resolveVendorId(userId);
    const inv = await this.prisma.client.invoice.findFirst({
      where: { id: invoiceId, vendorId },
      select: {
        id: true,
        number: true,
        vendorInvoiceRef: true,
        status: true,
        grossAmount: true,
        invoiceDate: true,
      },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    return {
      id: inv.id,
      number: inv.number,
      vendorInvoiceRef: inv.vendorInvoiceRef,
      status: inv.status,
      grossAmount: inv.grossAmount.toString(),
      invoiceDate: inv.invoiceDate.toISOString(),
    };
  }
}
