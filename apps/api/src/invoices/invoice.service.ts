import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import type {
  InvoiceCreateInput,
  InvoiceDocumentKind,
  InvoiceLineInput,
  ResolveAndRouteResult,
  TaxInvoiceInput,
  VendorInvoiceSubmitInput,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import { AuditLogService } from '../audit/audit.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { ACTIVE_RUN_ITEM } from '../payment-runs/payment-posting.service';
import { PrismaService } from '../prisma/prisma.service';
import { MatchService } from './match.service';
import { MsmeService } from './domain/msme.service';
import { TdsService } from './domain/tds.service';
import type { OcrExtraction } from './ocr/ocr.provider';
import { OcrService } from './ocr/ocr.service';
import { defaultPlantQuery } from '../common/plants/default-plant';

interface Totals {
  subtotal: Decimal;
  taxAmount: Decimal;
  gross: Decimal;
  taxKind: 'IGST' | 'CGST_SGST';
}

/** The states the 3-way matcher leaves an invoice in; anything else has not
 *  been matched (or is already past approval). */
const MATCHED_STATUSES: string[] = ['OCR_DONE', 'MATCH_EXCEPTION'];

/**
 * Where a proforma cannot take its tax invoice yet, and what to do instead.
 * Anything not listed can: before approval, after it, part-paid, or paid in
 * full (a 100% advance still owes the buyer a tax invoice).
 */
const TAX_INVOICE_REFUSED: Record<string, string> = {
  OCR_PENDING:
    'The proforma is still being read. Wait for extraction to finish before replacing it.',
  AWAITING_APPROVAL:
    'The proforma is with its approver. Wait for the decision before replacing it.',
  SCHEDULED:
    'The proforma is in a payment run the bank has not confirmed yet. Wait for it to settle first.',
  HELD: 'This invoice is on hold. Release the hold first.',
  REJECTED: 'This proforma was rejected. Submit the tax invoice as a new invoice instead.',
};

/** ₹ a tax invoice may differ from its approved proforma by before it counts. */
const APPROVED_TOTAL_ROUNDING = new Decimal(1);

const inr = (v: Decimal): string =>
  `₹${v.toNumber().toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
    private readonly match: MatchService,
    private readonly ocr: OcrService,
    private readonly tds: TdsService,
    private readonly msme: MsmeService,
    private readonly routing: ApprovalRoutingService,
  ) {}

  /** Manual creation by AP. Skips OCR (Slice 1 decision); runs match immediately. */
  async create(
    tenantId: string,
    actorId: string,
    input: InvoiceCreateInput,
  ): Promise<string> {
    const vendor = await this.requireVendor(input.vendorId);
    const invoiceDate = new Date(input.invoiceDate);
    const totals = await this.computeTotals(tenantId, vendor.gstin, input.lines);
    const id = newId('invoice');
    await this.persistInvoice({
      id,
      tenantId,
      vendor,
      poId: input.poId ?? null,
      vendorInvoiceRef: input.vendorInvoiceRef,
      invoiceDate,
      source: 'MANUAL',
      status: 'RECEIVED',
      irn: input.irn ?? null,
      ewaybillNo: input.ewaybillNo ?? null,
      lines: input.lines,
      totals,
    });
    await this.auditCreated(id, actorId, 'MANUAL', input.vendorInvoiceRef);
    await this.match.runFor(id, actorId); // manual path: match now, no OCR
    return id;
  }

  /** Vendor-portal submission. Enforces PO ownership; enqueues OCR. */
  async createFromVendorPortal(
    tenantId: string,
    vendorId: string,
    input: VendorInvoiceSubmitInput,
  ): Promise<string> {
    const po = await this.prisma.client.purchaseOrder.findUnique({
      where: { id: input.poId },
    });
    if (!po || po.vendorId !== vendorId) {
      // Wrong-PO upload → generic 403 + potential-abuse event (Slice 1 decision).
      await this.events.emit(
        'VendorPoOwnershipDenied',
        { vendorId, poId: input.poId },
        tenantId,
      );
      throw new ForbiddenException('Purchase order not available');
    }
    const vendor = await this.requireVendor(vendorId);
    const invoiceDate = new Date(input.invoiceDate);
    const totals = await this.computeTotals(tenantId, vendor.gstin, input.lines);
    const id = newId('invoice');
    await this.persistInvoice({
      id,
      tenantId,
      vendor,
      poId: input.poId,
      vendorInvoiceRef: input.vendorInvoiceRef,
      invoiceDate,
      source: 'PORTAL',
      status: 'OCR_PENDING',
      irn: input.irn ?? null,
      ewaybillNo: input.ewaybillNo ?? null,
      lines: input.lines,
      totals,
      s3Key: input.s3Key,
      documentKind: input.documentKind,
    });
    await this.queueOcr(tenantId, id, input.s3Key);
    await this.auditCreated(id, vendorId, 'PORTAL', input.vendorInvoiceRef, input.documentKind);
    return id;
  }

  /** Buyer PDF upload → OCR_PENDING invoice with no lines yet. */
  async createFromUpload(
    tenantId: string,
    actorId: string,
    args: {
      vendorId: string;
      poId?: string | null;
      vendorInvoiceRef: string;
      s3Key: string;
      source?: 'MANUAL' | 'EMAIL' | 'PORTAL';
    },
  ): Promise<string> {
    const vendor = await this.requireVendor(args.vendorId);
    const id = newId('invoice');
    await this.persistInvoice({
      id,
      tenantId,
      vendor,
      poId: args.poId ?? null,
      vendorInvoiceRef: args.vendorInvoiceRef,
      // Stand-ins, not claims about the document: the date of receipt, and from
      // email intake the message subject. `headerAwaitingOcr` says so, and
      // `applyOcr` replaces both once the page has actually been read.
      invoiceDate: new Date(),
      headerAwaitingOcr: true,
      source: args.source ?? 'MANUAL',
      status: 'OCR_PENDING',
      irn: null,
      ewaybillNo: null,
      lines: [],
      totals: {
        subtotal: new Decimal(0),
        taxAmount: new Decimal(0),
        gross: new Decimal(0),
        taxKind: 'IGST',
      },
      s3Key: args.s3Key,
    });
    await this.queueOcr(tenantId, id, args.s3Key);
    await this.auditCreated(id, actorId, 'UPLOAD', args.vendorInvoiceRef);
    return id;
  }

  /**
   * Hand the document to the OCR queue without letting the queue break intake.
   *
   * The invoice row is already committed by the time this runs, so an outage or
   * an exhausted quota on Redis must not surface as a 500: that reports failure
   * for an invoice we did in fact accept, and the submitter re-sends a duplicate.
   *
   * A dead queue drops the invoice into `OCR_FAILED` — the same manual
   * data-entry fallback a permanently failing provider gets — rather than
   * leaving it in `OCR_PENDING`, where no worker will ever pick it up, the
   * 3-way match can never run, and `resolveAndRoute` refuses it forever.
   */
  private async queueOcr(
    tenantId: string,
    invoiceId: string,
    s3Key: string,
  ): Promise<void> {
    try {
      const jobId = await this.ocr.submit({ invoiceId, tenantId, s3Key });
      await this.prisma.client.invoice.update({
        where: { id: invoiceId },
        data: { ocrJobId: jobId },
      });
    } catch (err) {
      this.logger.error(
        `Could not queue OCR for ${invoiceId} — falling back to manual data entry: ${String(err)}`,
      );
      await this.markOcrFailed(
        tenantId,
        invoiceId,
        `OCR could not be queued: ${String(err)}`,
      );
    }
  }

  /**
   * Re-queue OCR for an invoice whose extraction never completed.
   *
   * Until now there was no way back from OCR_PENDING. The job is enqueued once,
   * at creation, by a private method — so an invoice whose job is lost sits in
   * that status permanently: the matcher never runs, `resolveAndRoute` refuses
   * it forever, and no screen offers an action. Losing a job is not exotic;
   * these invoices were stranded when the Redis instance was replaced and the
   * queued jobs did not come across with it.
   *
   * Accepted from OCR_PENDING (job lost or never picked up) and OCR_FAILED (the
   * provider gave up, and may now be configured differently — which is exactly
   * the case when the sandbox simulator is replaced by a real engine). Refused
   * from anywhere else: re-reading a document whose lines a person has since
   * corrected would be destructive, and past OCR the invoice has moved on.
   */
  async retryOcr(invoiceId: string, actorId: string): Promise<{ ok: true }> {
    const inv = await this.prisma.client.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, tenantId: true, status: true },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.status !== 'OCR_PENDING' && inv.status !== 'OCR_FAILED') {
      throw new ForbiddenException(
        `This invoice is ${inv.status}; OCR can only be retried while it is ` +
          'still awaiting extraction.',
      );
    }

    // The document itself, not the create-time argument: a retry can happen
    // long after, and the attachment is the only durable record of the key.
    const attachment = await this.prisma.client.invoiceAttachment.findFirst({
      where: { invoiceId, docType: 'INVOICE_PDF' },
      orderBy: { uploadedAt: 'desc' },
      select: { s3Key: true },
    });
    if (!attachment) {
      throw new ForbiddenException(
        'No document is attached to this invoice, so there is nothing to ' +
          'extract. Enter the lines manually instead.',
      );
    }

    // Back to OCR_PENDING first: retrying an OCR_FAILED invoice must not leave
    // it reading as failed while a job is in flight for it.
    await this.prisma.client.invoice.update({
      where: { id: invoiceId },
      data: { status: 'OCR_PENDING' },
    });
    await this.audit.record({
      action: 'invoice.ocr_retried',
      entityType: 'Invoice',
      entityId: invoiceId,
      actorId,
      before: { status: inv.status },
    });
    // queueOcr routes its own failure to OCR_FAILED, so a dead queue leaves the
    // invoice in a state AP can still act on rather than back where it started.
    await this.queueOcr(inv.tenantId, invoiceId, attachment.s3Key);
    return { ok: true };
  }

  /** OCR completion callback (from the worker). Runs in its own tenant context. */
  async applyOcr(
    tenantId: string,
    invoiceId: string,
    extraction: OcrExtraction,
  ): Promise<void> {
    await this.prisma.runInTenantContext(tenantId, async (tx) => {
      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
        include: { lines: true, vendor: true },
      });
      if (!invoice) return;

      // Populate lines from OCR only when the invoice was uploaded without them.
      if (invoice.lines.length === 0 && extraction.lines.length > 0) {
        const totals = await this.computeTotals(
          tenantId,
          invoice.vendor.gstin,
          extraction.lines,
        );
        await tx.invoiceLine.createMany({
          data: extraction.lines.map((l, i) => ({
            id: newId('invoiceLine'),
            tenantId,
            invoiceId,
            lineNo: i + 1,
            itemDesc: l.itemDesc,
            uom: l.uom,
            qty: new Prisma.Decimal(l.qty),
            unitPrice: new Prisma.Decimal(l.unitPrice),
            taxRate: new Prisma.Decimal(l.taxRate),
            lineTotal: new Prisma.Decimal(
              new Decimal(l.qty).times(l.unitPrice).toFixed(4),
            ),
          })),
        });
        await tx.invoice.update({
          where: { id: invoiceId },
          data: {
            grossAmount: new Prisma.Decimal(totals.gross.toFixed(4)),
            taxAmount: new Prisma.Decimal(totals.taxAmount.toFixed(4)),
            netAmount: new Prisma.Decimal(totals.gross.toFixed(4)),
          },
        });
      }

      // Confidence routing (Slice 10a): below the tenant's floor, park the invoice
      // in the manual-review queue rather than auto-matching against garbage data.
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { ocrConfidenceFloorPct: true, msmePaymentCapDays: true },
      });
      const floorPct = Number(tenant?.ocrConfidenceFloorPct?.toString() ?? '80');
      const belowFloor = extraction.confidence * 100 < floorPct;

      // What the document says about itself. Recorded whether or not it agrees
      // with this record — the matcher needs both to tell them apart.
      const printedDate = parseOcrDate(extraction.invoiceDate);
      const printedRef = extraction.vendorInvoiceRef?.trim() || null;

      /*
       * Adopt the printed values only over placeholders.
       *
       * `createFromUpload` stamps the date of receipt and, from email intake,
       * the message subject; neither is a claim about the document, and leaving
       * them in place is how the MSME clock came to run from receipt rather than
       * from the invoice date. Where a person typed those values instead, OCR
       * does not overwrite them — the matcher raises DOCUMENT_MISMATCH and a
       * human decides, because silently rewriting the date an MSME due date was
       * computed from is not a correction anyone asked for.
       */
      const adopt = invoice.headerAwaitingOcr;
      const nextDate = adopt ? printedDate : null;
      const nextRef = adopt ? printedRef : null;

      // The due date hangs off the invoice date, so moving one moves the other.
      // Left alone for non-MSME vendors, who have no statutory clock.
      const msmeDueDate =
        nextDate && invoice.vendor.isMsme
          ? this.msme.computeDueDate(nextDate, tenant?.msmePaymentCapDays ?? 45)
          : undefined;

      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          status: belowFloor ? 'OCR_LOW_CONFIDENCE' : 'OCR_DONE',
          ocrConfidence: new Prisma.Decimal(extraction.confidence.toFixed(4)),
          // Stored verbatim, never derived. Left null when the provider gave no
          // total, so the matcher can tell "the document says the same thing"
          // apart from "we never read what the document says".
          ...(extraction.declaredTotal
            ? { ocrDeclaredTotal: new Prisma.Decimal(extraction.declaredTotal) }
            : {}),
          ...(printedDate ? { ocrInvoiceDate: printedDate } : {}),
          ...(printedRef ? { ocrVendorInvoiceRef: printedRef } : {}),
          // Never adopted onto the invoice, only recorded: the vendor is fixed
          // by the PO, so a differing name on the page is a finding, not a
          // correction.
          ...(extraction.vendorName?.trim()
            ? { ocrVendorName: extraction.vendorName.trim() }
            : {}),
          ...(nextDate ? { invoiceDate: nextDate } : {}),
          ...(nextRef ? { vendorInvoiceRef: nextRef } : {}),
          ...(msmeDueDate ? { msmeDueDate } : {}),
          // Cleared once read, even if the provider returned nothing useful:
          // the document has had its chance, and a second pass would not find
          // more. What it could not supply stays as it is and is visible as such.
          ...(adopt ? { headerAwaitingOcr: false } : {}),
          ...(extraction.irn ? { irn: extraction.irn } : {}),
          ...(extraction.ewaybillNo ? { ewaybillNo: extraction.ewaybillNo } : {}),
        },
      });
      await this.audit.record({
        action: 'invoice.ocr_applied',
        entityType: 'Invoice',
        entityId: invoiceId,
        actorId: null,
        actorType: 'SYSTEM',
        after: { confidence: extraction.confidence, floorPct, belowFloor },
        tenantId,
      });
      if (belowFloor) {
        await this.events.emit(
          'InvoiceOcrLowConfidence',
          { invoiceId, confidence: extraction.confidence },
          tenantId,
        );
        return; // do NOT auto-match — awaits manual review
      }
      await this.match.runFor(invoiceId, 'system');
    });
  }

  /**
   * Permanent OCR failure (Slice 10a). Parks the invoice in OCR_FAILED for manual
   * data entry — the invoice is never lost or silently dropped, satisfying the
   * cross-cutting rule that no integration failure blocks core P2P flow.
   */
  async markOcrFailed(
    tenantId: string,
    invoiceId: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.runInTenantContext(tenantId, async (tx) => {
      const inv = await tx.invoice.findUnique({ where: { id: invoiceId } });
      if (!inv || inv.status !== 'OCR_PENDING') return;
      await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: 'OCR_FAILED' },
      });
      await this.audit.record({
        action: 'invoice.ocr_failed',
        entityType: 'Invoice',
        entityId: invoiceId,
        actorType: 'SYSTEM',
        after: { reason: reason.slice(0, 300) },
        tenantId,
      });
      await this.events.emit('InvoiceOcrFailed', { invoiceId, reason }, tenantId);
    });
  }

  /**
   * AP completes manual data entry for a low-confidence / failed OCR invoice, then
   * proceeds through the normal 3-way match path (Slice 10a manual fallback).
   */
  async completeManualEntry(
    invoiceId: string,
    input: {
      vendorInvoiceRef?: string | null;
      invoiceDate?: string | null;
      lines: Array<{
        itemDesc: string;
        uom: string;
        qty: string;
        unitPrice: string;
        taxRate: string;
      }>;
    },
    actorId: string,
  ): Promise<{ ok: true }> {
    const inv = await this.prisma.client.invoice.findUnique({
      where: { id: invoiceId },
      include: { vendor: true },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.status !== 'OCR_LOW_CONFIDENCE' && inv.status !== 'OCR_FAILED') {
      throw new ForbiddenException('Invoice is not awaiting manual data entry.');
    }
    const totals = await this.computeTotals(inv.tenantId, inv.vendor.gstin, input.lines);
    await this.prisma.client.invoiceLine.deleteMany({ where: { invoiceId } });
    await this.prisma.client.invoiceLine.createMany({
      data: input.lines.map((l, i) => ({
        id: newId('invoiceLine'),
        tenantId: inv.tenantId,
        invoiceId,
        lineNo: i + 1,
        itemDesc: l.itemDesc,
        uom: l.uom,
        qty: new Prisma.Decimal(l.qty),
        unitPrice: new Prisma.Decimal(l.unitPrice),
        taxRate: new Prisma.Decimal(l.taxRate),
        lineTotal: new Prisma.Decimal(new Decimal(l.qty).times(l.unitPrice).toFixed(4)),
      })),
    });
    // The due date hangs off the invoice date here exactly as it does in
    // `applyOcr`. Typing a corrected date and leaving the old due date behind
    // would silently misstate the statutory clock — and this path exists
    // precisely because OCR could not read the document, so a corrected date is
    // the expected case rather than the rare one.
    const typedDate = input.invoiceDate ? new Date(input.invoiceDate) : null;
    const msmeDueDate =
      typedDate && !Number.isNaN(typedDate.getTime()) && inv.vendor.isMsme
        ? this.msme.computeDueDate(
            typedDate,
            (
              await this.prisma.client.tenant.findUniqueOrThrow({
                where: { id: inv.tenantId },
                select: { msmePaymentCapDays: true },
              })
            ).msmePaymentCapDays,
          )
        : null;

    await this.prisma.client.invoice.update({
      where: { id: invoiceId },
      data: {
        status: 'OCR_DONE',
        grossAmount: new Prisma.Decimal(totals.gross.toFixed(4)),
        taxAmount: new Prisma.Decimal(totals.taxAmount.toFixed(4)),
        netAmount: new Prisma.Decimal(totals.gross.toFixed(4)),
        ...(input.vendorInvoiceRef ? { vendorInvoiceRef: input.vendorInvoiceRef } : {}),
        ...(typedDate && !Number.isNaN(typedDate.getTime())
          ? { invoiceDate: typedDate }
          : {}),
        ...(msmeDueDate ? { msmeDueDate } : {}),
        // A person has now asserted these values, so OCR must never overwrite
        // them if this invoice is ever re-read.
        headerAwaitingOcr: false,
      },
    });
    await this.audit.record({
      action: 'invoice.manual_entry_completed',
      entityType: 'Invoice',
      entityId: invoiceId,
      actorId,
      after: { lines: input.lines.length },
    });
    await this.match.runFor(invoiceId, actorId);
    return { ok: true };
  }

  async assign(invoiceId: string, assigneeId: string, actorId: string): Promise<void> {
    await this.transition(
      invoiceId,
      actorId,
      'invoice.assigned',
      { assignedToId: assigneeId },
      {
        assignedToId: assigneeId,
      },
    );
  }

  async hold(invoiceId: string, reason: string, actorId: string): Promise<void> {
    await this.transition(
      invoiceId,
      actorId,
      'invoice.held',
      { status: 'HELD', holdReason: reason },
      {
        reason,
      },
    );
  }

  async unhold(invoiceId: string, actorId: string): Promise<void> {
    await this.transition(invoiceId, actorId, 'invoice.unheld', {
      status: 'MATCH_EXCEPTION',
      holdReason: null,
    });
    await this.match.runFor(invoiceId, actorId);
  }

  async addComment(invoiceId: string, authorId: string, body: string): Promise<void> {
    await this.requireInvoice(invoiceId);
    await this.prisma.client.invoiceComment.create({
      data: {
        id: newId('invoiceComment'),
        tenantId: this.tenantId(),
        invoiceId,
        authorId,
        body,
      },
    });
    await this.audit.record({
      action: 'invoice.comment_added',
      entityType: 'Invoice',
      entityId: invoiceId,
      actorId: authorId,
    });
  }

  /**
   * Say whether the document on this record is a proforma or a tax invoice.
   *
   * For the cases the vendor did not flag at submission — and for proformas
   * that predate the flag, which were entered as ordinary invoices. Marking one
   * as a proforma blocks its balance once an advance is paid, so it is refused
   * once a tax invoice has already replaced the PI: the record then holds a real
   * tax invoice, and calling it a proforma again would block a legitimate
   * payment.
   */
  async setDocumentKind(
    invoiceId: string,
    kind: InvoiceDocumentKind,
    actorId: string,
  ): Promise<void> {
    const inv = await this.requireInvoice(invoiceId);
    if (inv.documentKind === kind) return;
    if (inv.proformaRef !== null) {
      throw new ForbiddenException(
        `The tax invoice has already replaced proforma ${inv.proformaRef} on this record.`,
      );
    }
    if (inv.status === 'REJECTED') {
      throw new ForbiddenException('This invoice was rejected.');
    }
    await this.prisma.client.invoice.update({
      where: { id: invoiceId },
      data: { documentKind: kind },
    });
    await this.audit.record({
      action: 'invoice.document_kind_changed',
      entityType: 'Invoice',
      entityId: invoiceId,
      actorId,
      before: { documentKind: inv.documentKind },
      after: { documentKind: kind },
    });
  }

  /**
   * Replace a proforma with the vendor's tax invoice, on the same record.
   *
   * Some suppliers will not ship until an advance is paid, and the advance is
   * paid against their PI. The tax invoice only comes afterwards. Entering it as
   * a new invoice would bill the PO a second time and lose the advance already
   * paid, so it lands here instead:
   *
   *  - the PI's PDF stays attached, re-typed PROFORMA_PDF — the advance was
   *    paid against it and that has to remain visible;
   *  - the header and lines are the ones asserted with the upload, and OCR is
   *    queued to read the page and check it against them;
   *  - every exception raised on the PI is superseded, open and overridden
   *    alike, so the tax invoice is matched from a clean slate;
   *  - the PI's reference and approved total are kept, which is what
   *    `resolveAndRoute` weighs the tax invoice against;
   *  - payments are untouched: paidAmount still says what the advance settled.
   */
  async attachTaxInvoice(
    invoiceId: string,
    input: TaxInvoiceInput,
    actor: { id: string; type: 'USER' | 'VENDOR' },
  ): Promise<void> {
    const inv = await this.prisma.client.invoice.findUnique({
      where: { id: invoiceId },
      include: { vendor: true },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.documentKind !== 'PROFORMA') {
      throw new ForbiddenException(
        inv.proformaRef
          ? 'The tax invoice has already been uploaded for this proforma.'
          : 'This invoice is not a proforma, so there is no tax invoice to replace it with.',
      );
    }
    const refusal = TAX_INVOICE_REFUSED[inv.status];
    if (refusal) throw new ForbiddenException(refusal);
    // A draft run holding the PI would go on to pay an amount composed for the
    // proforma; the bank-pending case is covered by SCHEDULED above.
    const inRun = await this.prisma.client.paymentRunItem.findFirst({
      where: { invoiceId, ...ACTIVE_RUN_ITEM },
      include: { paymentRun: { select: { number: true } } },
    });
    if (inRun) {
      throw new ForbiddenException(
        `This proforma is in payment run ${inRun.paymentRun.number}. Remove it ` +
          'from that run, or let the bank confirm it, before replacing the document.',
      );
    }

    const invoiceDate = new Date(input.invoiceDate);
    const totals = await this.computeTotals(inv.tenantId, inv.vendor.gstin, input.lines);
    const tenant = await this.prisma.client.tenant.findUniqueOrThrow({
      where: { id: inv.tenantId },
      select: { tdsRate: true, msmePaymentCapDays: true },
    });
    const tdsAmount = await this.tds.computeFor(
      inv.vendorId,
      totals.subtotal,
      invoiceDate,
      new Decimal(tenant.tdsRate.toString()),
    );
    const now = new Date();

    const db = this.prisma.client;
    await db.invoiceAttachment.updateMany({
      where: { invoiceId, docType: 'INVOICE_PDF' },
      data: { docType: 'PROFORMA_PDF' },
    });
    await db.invoiceAttachment.create({
      data: {
        id: newId('invoiceAttachment'),
        tenantId: inv.tenantId,
        invoiceId,
        s3Key: input.s3Key,
        mimeType: 'application/pdf',
        sizeBytes: 0,
      },
    });
    await db.invoiceException.updateMany({
      where: { invoiceId, supersededAt: null },
      data: { supersededAt: now },
    });
    await db.invoiceLine.deleteMany({ where: { invoiceId } });
    await db.invoiceLine.createMany({
      data: input.lines.map((l) => ({
        id: newId('invoiceLine'),
        tenantId: inv.tenantId,
        invoiceId,
        lineNo: l.lineNo,
        poLineId: l.poLineId ?? null,
        itemDesc: l.itemDesc,
        uom: l.uom,
        qty: new Prisma.Decimal(l.qty),
        unitPrice: new Prisma.Decimal(l.unitPrice),
        taxRate: new Prisma.Decimal(l.taxRate ?? '0'),
        lineTotal: new Prisma.Decimal(new Decimal(l.qty).times(l.unitPrice).toFixed(4)),
      })),
    });
    await db.invoice.update({
      where: { id: invoiceId },
      data: {
        documentKind: 'TAX_INVOICE',
        proformaRef: inv.vendorInvoiceRef,
        proformaGrossAmount: inv.grossAmount,
        taxInvoiceReceivedAt: now,
        vendorInvoiceRef: input.vendorInvoiceRef,
        invoiceDate,
        // The MSME clock runs from the tax invoice, not from the proforma.
        ...(inv.vendor.isMsme
          ? {
              msmeDueDate: this.msme.computeDueDate(
                invoiceDate,
                tenant.msmePaymentCapDays,
              ),
            }
          : {}),
        grossAmount: new Prisma.Decimal(totals.gross.toFixed(4)),
        taxAmount: new Prisma.Decimal(totals.taxAmount.toFixed(4)),
        tdsAmount,
        netAmount: new Prisma.Decimal(totals.gross.minus(tdsAmount.toString()).toFixed(4)),
        irn: input.irn ?? null,
        ewaybillNo: input.ewaybillNo ?? null,
        // Asserted by the uploader, so OCR checks them rather than adopting.
        headerAwaitingOcr: false,
        // Everything read off the PI is about the PI.
        ocrConfidence: null,
        ocrJobId: null,
        ocrDeclaredTotal: null,
        ocrInvoiceDate: null,
        ocrVendorInvoiceRef: null,
        ocrVendorName: null,
        gstr2bStatus: 'PENDING',
        gstr2bMatchedAt: null,
        status: 'OCR_PENDING',
      },
    });
    await this.audit.record({
      action: 'invoice.tax_invoice_attached',
      entityType: 'Invoice',
      entityId: invoiceId,
      actorId: actor.id,
      before: {
        status: inv.status,
        proformaRef: inv.vendorInvoiceRef,
        grossAmount: inv.grossAmount.toString(),
        paidAmount: inv.paidAmount.toString(),
      },
      after: {
        vendorInvoiceRef: input.vendorInvoiceRef,
        grossAmount: totals.gross.toFixed(4),
        uploadedBy: actor.type,
      },
    });
    await this.events.emit('InvoiceTaxInvoiceAttached', { invoiceId });
    await this.queueOcr(inv.tenantId, invoiceId, input.s3Key);
  }

  /**
   * Resolve gate, then hand off to the generic approval engine (Slice 2).
   *
   * A tax invoice that replaced an already-approved proforma does not go back
   * through approval by default — the approver has already agreed to pay this
   * supplier this much for this order, and re-approving every tax invoice that
   * simply repeats its PI is noise. It goes back only when it changed what was
   * agreed: see `materialChanges`.
   */
  async resolveAndRoute(
    invoiceId: string,
    actorId: string,
  ): Promise<ResolveAndRouteResult> {
    const invoice = await this.requireInvoice(invoiceId);
    // "No open exceptions" is only evidence of a clean match if a match has
    // actually run. Before it does — OCR pending, below the confidence floor,
    // provider failed, sender unrecognised — the count is zero because nothing
    // was ever checked, and routing on that would send an unmatched invoice,
    // possibly with no goods receipt behind it, straight into the approval
    // chain. OCR_DONE and MATCH_EXCEPTION are the only states the matcher
    // leaves behind (unhold re-runs it), so they are the only ones that route.
    if (!MATCHED_STATUSES.includes(invoice.status)) {
      throw new ForbiddenException(
        `This invoice has not been through the 3-way match yet (${invoice.status}). ` +
          'Complete OCR or run the match before routing it for approval.',
      );
    }
    const open = await this.prisma.client.invoiceException.count({
      where: { invoiceId, resolvedAt: null, supersededAt: null },
    });
    if (open > 0) {
      throw new ForbiddenException('Resolve all exceptions before routing');
    }

    if (invoice.proformaRef !== null && (await this.hasPriorApproval(invoiceId))) {
      const reasons = await this.materialChanges(invoice);
      if (reasons.length === 0) {
        await this.carryOverApproval(invoice, actorId);
        return { outcome: 'APPROVAL_CARRIED_OVER', reasons };
      }
      // The engine will not route a document that already has approval rows —
      // they are how it knows a document is in flight. The earlier decisions
      // stay in the audit log (DOCUMENT_ROUTED / APPROVAL_DECIDED).
      await this.prisma.client.approval.deleteMany({
        where: { documentType: 'INVOICE', documentId: invoiceId },
      });
      await this.audit.record({
        action: 'invoice.reapproval_required',
        entityType: 'Invoice',
        entityId: invoiceId,
        actorId,
        after: { reasons },
      });
      await this.routing.submit('INVOICE', invoiceId, actorId);
      return { outcome: 'ROUTED', reasons };
    }

    await this.routing.submit('INVOICE', invoiceId, actorId);
    return { outcome: 'ROUTED', reasons: [] };
  }

  /** Fully approved before: approvals exist, none pending, none refused. */
  private async hasPriorApproval(invoiceId: string): Promise<boolean> {
    const rows = await this.prisma.client.approval.findMany({
      where: { documentType: 'INVOICE', documentId: invoiceId },
      select: { decision: true },
    });
    return rows.length > 0 && rows.every((r) => r.decision === 'APPROVED');
  }

  /**
   * How the tax invoice departs from the proforma that was approved, in words
   * an approver can act on. Empty means the earlier approval still holds.
   *
   *  - It costs more than was approved, beyond rounding.
   *  - It costs less than has already been paid: the advance overshot and the
   *    difference has to be recovered, which is not AP's call alone.
   *  - It comes from a different supplier than the order. Even with the
   *    exception overridden, the approver agreed to pay somebody else.
   */
  private async materialChanges(inv: {
    id: string;
    grossAmount: Prisma.Decimal;
    paidAmount: Prisma.Decimal;
    proformaGrossAmount: Prisma.Decimal | null;
    ocrVendorName: string | null;
  }): Promise<string[]> {
    const reasons: string[] = [];
    const gross = new Decimal(inv.grossAmount.toString());
    const approved = new Decimal(inv.proformaGrossAmount?.toString() ?? '0');
    const paid = new Decimal(inv.paidAmount.toString());
    if (gross.minus(approved).greaterThan(APPROVED_TOTAL_ROUNDING)) {
      reasons.push(
        `The tax invoice total ${inr(gross)} is more than the ${inr(approved)} approved on the proforma.`,
      );
    }
    if (paid.minus(gross).greaterThan(APPROVED_TOTAL_ROUNDING)) {
      reasons.push(
        `The tax invoice total ${inr(gross)} is less than the ${inr(paid)} already paid; the difference has to be recovered.`,
      );
    }
    const otherSupplier = await this.prisma.client.invoiceException.count({
      where: { invoiceId: inv.id, supersededAt: null, exceptionType: 'VENDOR_MISMATCH' },
    });
    if (otherSupplier > 0) {
      reasons.push(
        `The tax invoice is issued by ${inv.ocrVendorName ? `"${inv.ocrVendorName}"` : 'a different supplier'}, not the supplier on the order.`,
      );
    }
    return reasons;
  }

  /**
   * Put a converted invoice back where its payments left it. The approval rows
   * already say APPROVED; what changes is the status, which the tax invoice's
   * trip through OCR and the match moved back into the pipeline.
   */
  private async carryOverApproval(
    inv: { id: string; status: string; grossAmount: Prisma.Decimal; paidAmount: Prisma.Decimal },
    actorId: string,
  ): Promise<void> {
    const paid = new Decimal(inv.paidAmount.toString());
    const settled = paid.greaterThan(0) && paid.greaterThanOrEqualTo(inv.grossAmount.toString());
    const status = settled ? 'PAID' : paid.greaterThan(0) ? 'PARTIALLY_PAID' : 'APPROVED';
    const lastPayment = settled
      ? await this.prisma.client.paymentRecord.findFirst({
          where: { invoiceId: inv.id },
          orderBy: { paidAt: 'desc' },
          select: { paidAt: true },
        })
      : null;
    await this.prisma.client.invoice.update({
      where: { id: inv.id },
      data: { status, ...(lastPayment ? { paidAt: lastPayment.paidAt } : {}) },
    });
    await this.audit.record({
      action: 'invoice.approval_carried_over',
      entityType: 'Invoice',
      entityId: inv.id,
      actorId,
      before: { status: inv.status },
      after: { status },
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async computeTotals(
    tenantId: string,
    vendorGstin: string | null,
    lines: Array<Pick<InvoiceLineInput, 'qty' | 'unitPrice' | 'taxRate'>>,
  ): Promise<Totals> {
    const plant = await this.prisma.client.plant.findFirst(defaultPlantQuery(tenantId));
    const tenantState = plant?.stateCode ?? null;
    const vendorState = vendorGstin ? vendorGstin.slice(0, 2) : null;
    const taxKind: Totals['taxKind'] =
      tenantState && vendorState && tenantState === vendorState ? 'CGST_SGST' : 'IGST';

    let subtotal = new Decimal(0);
    let taxAmount = new Decimal(0);
    for (const l of lines) {
      const lineBase = new Decimal(l.qty).times(l.unitPrice);
      subtotal = subtotal.plus(lineBase);
      taxAmount = taxAmount.plus(lineBase.times(l.taxRate ?? '0'));
    }
    return { subtotal, taxAmount, gross: subtotal.plus(taxAmount), taxKind };
  }

  private async persistInvoice(args: {
    id: string;
    tenantId: string;
    vendor: { id: string; isMsme: boolean; gstin: string | null };
    poId: string | null;
    vendorInvoiceRef: string;
    invoiceDate: Date;
    source: 'MANUAL' | 'PORTAL' | 'EMAIL';
    status: 'RECEIVED' | 'OCR_PENDING';
    irn: string | null;
    ewaybillNo: string | null;
    lines: InvoiceLineInput[];
    totals: Totals;
    s3Key?: string;
    /** True when invoiceDate/vendorInvoiceRef are defaults awaiting OCR. */
    headerAwaitingOcr?: boolean;
    documentKind?: InvoiceDocumentKind;
  }): Promise<void> {
    const tenant = await this.prisma.client.tenant.findUniqueOrThrow({
      where: { id: args.tenantId },
    });
    const tdsAmount = await this.tds.computeFor(
      args.vendor.id,
      args.totals.subtotal,
      args.invoiceDate,
      new Decimal(tenant.tdsRate.toString()),
    );
    const msmeDueDate = args.vendor.isMsme
      ? this.msme.computeDueDate(args.invoiceDate, tenant.msmePaymentCapDays)
      : null;
    const net = args.totals.gross.minus(tdsAmount.toString());

    await this.prisma.client.invoice.create({
      data: {
        id: args.id,
        tenantId: args.tenantId,
        number: genInvoiceNumber(args.id),
        vendorId: args.vendor.id,
        poId: args.poId,
        vendorInvoiceRef: args.vendorInvoiceRef,
        invoiceDate: args.invoiceDate,
        headerAwaitingOcr: args.headerAwaitingOcr ?? false,
        documentKind: args.documentKind ?? 'TAX_INVOICE',
        status: args.status,
        source: args.source,
        grossAmount: new Prisma.Decimal(args.totals.gross.toFixed(4)),
        taxAmount: new Prisma.Decimal(args.totals.taxAmount.toFixed(4)),
        tdsAmount,
        netAmount: new Prisma.Decimal(net.toFixed(4)),
        irn: args.irn,
        ewaybillNo: args.ewaybillNo,
        msmeDueDate,
        lines: {
          create: args.lines.map((l) => ({
            id: newId('invoiceLine'),
            tenantId: args.tenantId,
            lineNo: l.lineNo,
            poLineId: l.poLineId ?? null,
            itemDesc: l.itemDesc,
            uom: l.uom,
            qty: new Prisma.Decimal(l.qty),
            unitPrice: new Prisma.Decimal(l.unitPrice),
            taxRate: new Prisma.Decimal(l.taxRate ?? '0'),
            lineTotal: new Prisma.Decimal(
              new Decimal(l.qty).times(l.unitPrice).toFixed(4),
            ),
          })),
        },
        ...(args.s3Key
          ? {
              attachments: {
                create: {
                  id: newId('invoiceAttachment'),
                  tenantId: args.tenantId,
                  s3Key: args.s3Key,
                  mimeType: 'application/pdf',
                  sizeBytes: 0,
                },
              },
            }
          : {}),
      },
    });
  }

  private async transition(
    invoiceId: string,
    actorId: string,
    action: string,
    data: Prisma.InvoiceUpdateInput,
    auditAfter?: Record<string, unknown>,
  ): Promise<void> {
    const before = await this.requireInvoice(invoiceId);
    await this.prisma.client.invoice.update({ where: { id: invoiceId }, data });
    await this.audit.record({
      action,
      entityType: 'Invoice',
      entityId: invoiceId,
      actorId,
      before: { status: before.status },
      after: auditAfter ?? {},
    });
  }

  private async auditCreated(
    id: string,
    actorId: string,
    source: string,
    ref: string,
    documentKind: InvoiceDocumentKind = 'TAX_INVOICE',
  ): Promise<void> {
    await this.audit.record({
      action: 'invoice.created',
      entityType: 'Invoice',
      entityId: id,
      actorId,
      after: { source, vendorInvoiceRef: ref, documentKind },
    });
    await this.events.emit('InvoiceCreated', { invoiceId: id, source });
  }

  private async requireVendor(vendorId: string) {
    const vendor = await this.prisma.client.vendor.findUnique({
      where: { id: vendorId },
    });
    if (!vendor) throw new NotFoundException('Vendor not found');
    return vendor;
  }

  private async requireInvoice(invoiceId: string) {
    const invoice = await this.prisma.client.invoice.findUnique({
      where: { id: invoiceId },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return invoice;
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}

/** Human-friendly, tenant-unique invoice number derived from the ULID suffix. */
function genInvoiceNumber(id: string): string {
  const suffix = id.split('_')[1] ?? id;
  return `INV-${suffix.slice(-6).toUpperCase()}`;
}

/**
 * An OCR-read date, or null when the provider gave nothing usable.
 *
 * Deliberately strict about the year: a provider that returns a malformed or
 * absurd date must not be allowed to set one, because this value moves the MSME
 * due date. Null leaves the record's own date standing.
 */
function parseOcrDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  return year >= 2000 && year <= 2100 ? d : null;
}
