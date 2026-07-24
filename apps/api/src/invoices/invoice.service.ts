import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import type {
  InvoiceCreateInput,
  InvoiceLineInput,
  VendorInvoiceSubmitInput,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import { AuditLogService } from '../audit/audit.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { MatchService } from './match.service';
import { MsmeService } from './domain/msme.service';
import { TdsService } from './domain/tds.service';
import type { OcrExtraction } from './ocr/ocr.provider';
import { OcrService } from './ocr/ocr.service';

interface Totals {
  subtotal: Decimal;
  taxAmount: Decimal;
  gross: Decimal;
  taxKind: 'IGST' | 'CGST_SGST';
}

@Injectable()
export class InvoiceService {
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
    });
    const jobId = await this.ocr.submit({ invoiceId: id, tenantId, s3Key: input.s3Key });
    await this.prisma.client.invoice.update({ where: { id }, data: { ocrJobId: jobId } });
    await this.auditCreated(id, vendorId, 'PORTAL', input.vendorInvoiceRef);
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
      invoiceDate: new Date(),
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
    const jobId = await this.ocr.submit({ invoiceId: id, tenantId, s3Key: args.s3Key });
    await this.prisma.client.invoice.update({ where: { id }, data: { ocrJobId: jobId } });
    await this.auditCreated(id, actorId, 'UPLOAD', args.vendorInvoiceRef);
    return id;
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
        select: { ocrConfidenceFloorPct: true },
      });
      const floorPct = Number(tenant?.ocrConfidenceFloorPct?.toString() ?? '80');
      const belowFloor = extraction.confidence * 100 < floorPct;

      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          status: belowFloor ? 'OCR_LOW_CONFIDENCE' : 'OCR_DONE',
          ocrConfidence: new Prisma.Decimal(extraction.confidence.toFixed(4)),
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
    await this.prisma.client.invoice.update({
      where: { id: invoiceId },
      data: {
        status: 'OCR_DONE',
        grossAmount: new Prisma.Decimal(totals.gross.toFixed(4)),
        taxAmount: new Prisma.Decimal(totals.taxAmount.toFixed(4)),
        netAmount: new Prisma.Decimal(totals.gross.toFixed(4)),
        ...(input.vendorInvoiceRef ? { vendorInvoiceRef: input.vendorInvoiceRef } : {}),
        ...(input.invoiceDate ? { invoiceDate: new Date(input.invoiceDate) } : {}),
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

  /** Resolve gate, then hand off to the generic approval engine (Slice 2). */
  async resolveAndRoute(invoiceId: string, actorId: string): Promise<void> {
    await this.requireInvoice(invoiceId);
    const open = await this.prisma.client.invoiceException.count({
      where: { invoiceId, resolvedAt: null },
    });
    if (open > 0) {
      throw new ForbiddenException('Resolve all exceptions before routing');
    }
    await this.routing.submit('INVOICE', invoiceId, actorId);
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async computeTotals(
    tenantId: string,
    vendorGstin: string | null,
    lines: Array<Pick<InvoiceLineInput, 'qty' | 'unitPrice' | 'taxRate'>>,
  ): Promise<Totals> {
    const plant = await this.prisma.client.plant.findFirst({ where: { tenantId } });
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
  ): Promise<void> {
    await this.audit.record({
      action: 'invoice.created',
      entityType: 'Invoice',
      entityId: id,
      actorId,
      after: { source, vendorInvoiceRef: ref },
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
