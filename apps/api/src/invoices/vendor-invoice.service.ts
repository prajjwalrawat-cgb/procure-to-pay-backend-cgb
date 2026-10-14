import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  canonicalRef,
  type InvoiceDocumentKind,
  type TaxInvoiceInput,
  type VendorInvoiceSubmitInput,
  type VendorPoOption,
} from '@procureflow/shared';

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
  documentKind: InvoiceDocumentKind;
  /** The PI this record started as, once its tax invoice has replaced it. */
  proformaRef: string | null;
  /** Why the buyer rejected it, so the vendor knows what to fix. */
  rejectionReason: string | null;
  /** The order it bills — after a rejection, the one to resubmit against. */
  po: { id: string; number: string } | null;
}

/** One invoice with its lines — what the tax-invoice form seeds itself from. */
export interface VendorInvoiceDetail extends VendorInvoiceSummary {
  lines: {
    lineNo: number;
    poLineId: string | null;
    itemDesc: string;
    uom: string;
    qty: string;
    unitPrice: string;
    taxRate: string;
  }[];
}

const SUMMARY_SELECT = {
  id: true,
  number: true,
  vendorInvoiceRef: true,
  status: true,
  grossAmount: true,
  invoiceDate: true,
  documentKind: true,
  proformaRef: true,
  rejectionReason: true,
  po: { select: { id: true, number: true } },
} as const;

function toSummary(r: {
  id: string;
  number: string;
  vendorInvoiceRef: string;
  status: string;
  grossAmount: { toString(): string };
  invoiceDate: Date;
  documentKind: InvoiceDocumentKind;
  proformaRef: string | null;
  rejectionReason: string | null;
  po: { id: string; number: string } | null;
}): VendorInvoiceSummary {
  return {
    id: r.id,
    number: r.number,
    vendorInvoiceRef: r.vendorInvoiceRef,
    status: r.status,
    grossAmount: r.grossAmount.toString(),
    invoiceDate: r.invoiceDate.toISOString(),
    documentKind: r.documentKind,
    proformaRef: r.proformaRef,
    rejectionReason: r.rejectionReason,
    po: r.po,
  };
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
    await this.assertRefNotUsed(vendorId, input.vendorInvoiceRef);
    const id = await this.invoices.createFromVendorPortal(tenantId, vendorId, input);
    return { id };
  }

  /**
   * The vendor replaces their own proforma with the tax invoice. Uploading
   * decides nothing: OCR, the match and — where the invoice changed — a fresh
   * approval all still run on the buyer's side.
   */
  async attachTaxInvoice(
    tenantId: string,
    userId: string,
    invoiceId: string,
    input: TaxInvoiceInput,
  ): Promise<void> {
    const vendorId = await this.resolveVendorId(userId);
    const own = await this.prisma.client.invoice.findFirst({
      where: { id: invoiceId, vendorId },
      select: { id: true },
    });
    if (!own) throw new NotFoundException('Invoice not found');
    await this.assertUploadedKey(tenantId, input.s3Key);
    await this.assertRefNotUsed(vendorId, input.vendorInvoiceRef, invoiceId);
    await this.invoices.attachTaxInvoice(invoiceId, input, { id: userId, type: 'VENDOR' });
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
   * Refuse an invoice number this vendor has already billed under.
   *
   * The matcher flags a repeated reference as DUPLICATE_INVOICE, but only after
   * the copy exists — by then it sits in the buyer's queue as a critical
   * exception somebody has to reject by hand. From the portal there is no
   * judgement to make: the vendor typed a number they have already used, so it
   * is refused here instead.
   *
   * References are compared canonically ("MAKV486/26-27" = "makv 486-26-27"),
   * against what the vendor entered, what OCR read off the page, and the PI
   * number a tax invoice replaced. REJECTED invoices free their number so a
   * corrected invoice can be resubmitted under it. `exceptInvoiceId` is the
   * proforma being replaced, which may carry its own number forward.
   */
  private async assertRefNotUsed(
    vendorId: string,
    ref: string,
    exceptInvoiceId?: string,
  ): Promise<void> {
    const wanted = canonicalRef(ref);
    if (!wanted) return;
    const live = await this.prisma.client.invoice.findMany({
      where: {
        vendorId,
        status: { not: 'REJECTED' },
        ...(exceptInvoiceId ? { id: { not: exceptInvoiceId } } : {}),
      },
      select: {
        vendorInvoiceRef: true,
        ocrVendorInvoiceRef: true,
        proformaRef: true,
      },
    });
    const clash = live.find((inv) =>
      [inv.vendorInvoiceRef, inv.ocrVendorInvoiceRef, inv.proformaRef].some(
        (r) => canonicalRef(r) === wanted,
      ),
    );
    if (clash) {
      throw new ConflictException(
        `Invoice ${ref.trim()} has already been submitted. Check its status under ` +
          'Invoices instead of uploading it again — if it was raised in error, ask ' +
          'your buyer to reject it first.',
      );
    }
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
      select: SUMMARY_SELECT,
    });
    return rows.map(toSummary);
  }

  /** A vendor may only see their own invoices; anything else is 404 (no leak). */
  async getOwn(userId: string, invoiceId: string): Promise<VendorInvoiceDetail> {
    const vendorId = await this.resolveVendorId(userId);
    const inv = await this.prisma.client.invoice.findFirst({
      where: { id: invoiceId, vendorId },
      select: { ...SUMMARY_SELECT, lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    return {
      ...toSummary(inv),
      lines: inv.lines.map((l) => ({
        lineNo: l.lineNo,
        poLineId: l.poLineId,
        itemDesc: l.itemDesc,
        uom: l.uom,
        qty: l.qty.toString(),
        unitPrice: l.unitPrice.toString(),
        taxRate: l.taxRate.toString(),
      })),
    };
  }
}
