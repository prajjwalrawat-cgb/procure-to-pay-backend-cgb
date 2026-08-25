import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { VendorInvoiceSubmitInput, VendorPoOption } from '@procureflow/shared';

import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { InvoiceService } from './invoice.service';
import { RefsService } from './refs.service';

/**
 * Object-key prefix for vendor-uploaded invoice documents. Minted by
 * `VendorInvoicesController.upload` and re-checked on submit, so the format
 * lives in exactly one place.
 */
export function vendorUploadPrefix(tenantId: string): string {
  return `invoices/${tenantId}/vendor/`;
}

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
    private readonly storage: StorageService,
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
    await this.assertUploadedKey(tenantId, input.s3Key);
    await this.assertPoStillBillable(vendorId, input.poId);
    const id = await this.invoices.createFromVendorPortal(tenantId, vendorId, input);
    return { id };
  }

  /**
   * Refuse an invoice against a purchase order with nothing left to bill.
   *
   * Hiding exhausted orders from the picker is presentation; this is the
   * control. The portal posts a poId, so a stale tab, a resubmitted request or
   * a hand-rolled call can still name an order the supplier can no longer bill
   * against, and the PO is the authorisation — every line of such an invoice
   * would exceed it.
   *
   * Whole-order only, deliberately. A partly-exhausted order stays submittable
   * and per-line excess is warned about in the form and raised as
   * QTY_VARIANCE for the buyer to weigh: over-delivery does happen and
   * accepting it is the buyer's call. An order with nothing billable anywhere
   * carries no such judgement — there is no quantity that clears — so it is
   * refused here rather than turned into an exception somebody has to process.
   */
  private async assertPoStillBillable(
    vendorId: string,
    poId: string | null | undefined,
  ): Promise<void> {
    if (!poId) return;
    const open = await this.refs.vendorOpenPos(vendorId);
    if (open.some((po) => po.id === poId)) return;

    const po = await this.prisma.client.purchaseOrder.findFirst({
      where: { id: poId, vendorId },
      select: { number: true },
    });
    throw new BadRequestException(
      po
        ? `Everything on ${po.number} has already been invoiced. Ask your buyer ` +
            'to amend the purchase order if more needs to be billed against it.'
        : 'That purchase order is not open for invoicing.',
    );
  }

  /**
   * `s3Key` arrives from the browser, so it is a claim rather than a fact.
   *
   * The portal used to skip the upload entirely — it synthesised the key from
   * the chosen filename and posted that — so every vendor invoice pointed at an
   * object nobody had written, and the buyer's "Attachment (PDF)" link presigned
   * a URL that returned NoSuchKey. Demanding the key sit under this tenant's
   * vendor prefix *and* resolve to a real object fixes that, and stops a
   * hand-rolled key from addressing somebody else's document.
   */
  private async assertUploadedKey(tenantId: string, s3Key: string): Promise<void> {
    if (!s3Key.startsWith(vendorUploadPrefix(tenantId))) {
      throw new ForbiddenException(
        'Attach the tax invoice through the upload step before submitting.',
      );
    }
    if (!(await this.storage.exists(s3Key))) {
      throw new BadRequestException(
        'The uploaded tax invoice could not be found in storage — attach it again.',
      );
    }
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
