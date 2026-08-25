import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import Decimal from 'decimal.js';
import {
  hasConversion,
  convertQty,
  runMatch,
  type ExceptionResolutionAction,
  type MatchInput,
} from '@procureflow/shared';

import { AuditLogService } from '../audit/audit.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_TOLERANCES: MatchInput['tolerances'] = {
  priceVariancePct: '0.005',
  qtyVariancePct: '0.02',
  qtyVarianceAbs: '1',
  taxExact: true,
  amountRoundingAbs: '1',
  dateGraceDays: '1',
};

/** Orchestrates the pure match engine against persisted PO/GRN/invoice data. */
@Injectable()
export class MatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
  ) {}

  async runFor(invoiceId: string, actorId = 'system'): Promise<void> {
    const invoice = await this.prisma.client.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        lines: true,
        po: {
          include: {
            lines: { include: { item: { include: { uomConversions: true } } } },
            grns: { include: { lines: true } },
          },
        },
        exceptions: true,
        vendor: { select: { lifecycleStatus: true } },
      },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');

    const config = await this.prisma.client.tenantMatchConfig.findUnique({
      where: { tenantId: invoice.tenantId },
    });
    const tolerances: MatchInput['tolerances'] = config
      ? {
          priceVariancePct: config.priceVariancePct.toString(),
          qtyVariancePct: config.qtyVariancePct.toString(),
          qtyVarianceAbs: config.qtyVarianceAbs.toString(),
          taxExact: config.taxExact,
          // Not yet tenant-configurable; the engine defaults apply.
          amountRoundingAbs: DEFAULT_TOLERANCES.amountRoundingAbs,
          dateGraceDays: DEFAULT_TOLERANCES.dateGraceDays,
        }
      : DEFAULT_TOLERANCES;

    const duplicates = await this.prisma.client.invoice.count({
      where: {
        vendorId: invoice.vendorId,
        vendorInvoiceRef: invoice.vendorInvoiceRef,
        id: { not: invoice.id },
      },
    });

    /**
     * How much each PO line has already been billed by OTHER invoices.
     *
     * REJECTED invoices are excluded — a rejected claim frees its quantity back
     * up. Everything else counts, including invoices still awaiting approval:
     * quantity is committed the moment a claim is live, or two invoices racing
     * through the matcher would each see the other as absent and both pass.
     */
    const priorLines = invoice.poId
      ? await this.prisma.client.invoiceLine.findMany({
          where: {
            poLine: { poId: invoice.poId },
            invoiceId: { not: invoice.id },
            invoice: { status: { notIn: ['REJECTED'] } },
          },
          select: { poLineId: true, qty: true },
        })
      : [];
    const invoicedByPoLine = new Map<string, Decimal>();
    for (const l of priorLines) {
      if (!l.poLineId) continue;
      invoicedByPoLine.set(
        l.poLineId,
        (invoicedByPoLine.get(l.poLineId) ?? new Decimal(0)).plus(l.qty.toString()),
      );
    }

    const poLineById = new Map((invoice.po?.lines ?? []).map((l) => [l.id, l]));

    const grnLines = invoice.po?.grns.flatMap((g) => g.lines) ?? [];
    // Earliest receipt on the order, not the latest: on a part-delivered PO an
    // invoice legitimately predates later receipts, so only predating the first
    // one means nothing had arrived when it was raised.
    const firstReceivedAt = (invoice.po?.grns ?? [])
      .map((g) => g.receivedAt)
      .reduce<Date | null>((min, d) => (min === null || d < min ? d : min), null);

    const input: MatchInput = {
      tolerances,
      isDuplicate: duplicates > 0,
      vendor: { lifecycleStatus: invoice.vendor.lifecycleStatus },
      po: invoice.po
        ? {
            status: invoice.po.status,
            issuedAt: invoice.po.issuedAt?.toISOString() ?? null,
            allowFreightLines:
              (invoice.po.termsSnapshot as { allow_freight_lines?: boolean } | null)
                ?.allow_freight_lines === true,
            lines: invoice.po.lines.map((l) => ({
              id: l.id,
              lineNo: l.lineNo,
              itemDesc: l.itemDesc,
              uom: l.uom,
              qtyOrdered: l.qtyOrdered.toString(),
              unitPrice: l.unitPrice.toString(),
              taxRate: l.taxRate.toString(),
              qtyAlreadyInvoiced: (
                invoicedByPoLine.get(l.id) ?? new Decimal(0)
              ).toString(),
            })),
          }
        : null,
      grn:
        invoice.po && grnLines.length > 0
          ? {
              firstReceivedAt: firstReceivedAt?.toISOString() ?? null,
              lines: grnLines.map((l) => ({
                poLineId: l.poLineId,
                qtyAccepted: l.qtyAccepted.toString(),
                qtyRejected: l.qtyRejected.toString(),
              })),
            }
          : null,
      invoice: {
        invoiceDate: invoice.invoiceDate.toISOString(),
        // The total printed on the document, captured by OCR — NOT the stored
        // grossAmount, which is computed from these same lines and so agrees
        // with them whatever they say. Null when the provider gave no total.
        declaredTotal: invoice.ocrDeclaredTotal?.toString() ?? null,
        lines: invoice.lines.map((l) => ({
          id: l.id,
          lineNo: l.lineNo,
          itemDesc: l.itemDesc,
          uom: l.uom,
          qty: l.qty.toString(),
          unitPrice: l.unitPrice.toString(),
          taxRate: l.taxRate.toString(),
          poLineId: l.poLineId,
          qtyInPoUom: qtyInPoUom(l, poLineById.get(l.poLineId ?? '')),
        })),
      },
    };

    const result = runMatch(input);

    // Preserve resolved exceptions and suppress re-raising them; refresh open ones.
    const resolvedKeys = new Set(
      invoice.exceptions
        .filter((e) => e.resolvedAt !== null)
        .map((e) => exceptionKey(e.exceptionType, e.invoiceLineId, e.poLineId)),
    );

    // Reconcile in place so still-open exceptions keep their ids across re-runs
    // (resolving one exception must not renumber the others).
    const openExisting = invoice.exceptions.filter((e) => e.resolvedAt === null);
    const openByKey = new Map(
      openExisting.map((e) => [
        exceptionKey(e.exceptionType, e.invoiceLineId, e.poLineId),
        e,
      ]),
    );
    const openCandidates = result.exceptions.filter(
      (e) =>
        !resolvedKeys.has(
          exceptionKey(e.type, e.invoiceLineId ?? null, e.poLineId ?? null),
        ),
    );
    const candidateKeys = new Set<string>();

    for (const ex of openCandidates) {
      const key = exceptionKey(ex.type, ex.invoiceLineId ?? null, ex.poLineId ?? null);
      candidateKeys.add(key);
      const details = {
        expected: ex.expected ?? null,
        actual: ex.actual ?? null,
        variancePct: ex.variancePct ?? null,
        impactWithTax: ex.impactWithTax,
        message: ex.details,
      } as Prisma.InputJsonValue;
      const existing = openByKey.get(key);
      if (existing) {
        await this.prisma.client.invoiceException.update({
          where: { id: existing.id },
          data: { severity: ex.severity, details },
        });
      } else {
        await this.prisma.client.invoiceException.create({
          data: {
            id: newId('invoiceException'),
            tenantId: invoice.tenantId,
            invoiceId,
            exceptionType: ex.type,
            severity: ex.severity,
            poLineId: ex.poLineId ?? null,
            invoiceLineId: ex.invoiceLineId ?? null,
            details,
            raisedBy: 'system',
          },
        });
      }
    }

    // Remove open exceptions that are no longer raised.
    const stale = openExisting.filter(
      (e) =>
        !candidateKeys.has(exceptionKey(e.exceptionType, e.invoiceLineId, e.poLineId)),
    );
    if (stale.length > 0) {
      await this.prisma.client.invoiceException.deleteMany({
        where: { id: { in: stale.map((e) => e.id) } },
      });
    }

    const nextStatus = openCandidates.length > 0 ? 'MATCH_EXCEPTION' : 'OCR_DONE';
    // Only move within the pre-approval pipeline; never override a routed/posted state.
    const pipeline = ['RECEIVED', 'OCR_PENDING', 'OCR_DONE', 'MATCH_EXCEPTION'];
    if (pipeline.includes(invoice.status)) {
      await this.prisma.client.invoice.update({
        where: { id: invoiceId },
        data: { status: nextStatus },
      });
    }

    await this.audit.record({
      action: 'invoice.match_run',
      entityType: 'Invoice',
      entityId: invoiceId,
      actorId,
      after: { exceptions: openCandidates.length, varianceTotal: result.varianceTotal },
    });
    await this.events.emit('InvoiceMatched', {
      invoiceId,
      exceptions: openCandidates.length,
    });
  }

  async resolveException(
    invoiceId: string,
    exceptionId: string,
    action: ExceptionResolutionAction,
    notes: string | null,
    actorId: string,
  ): Promise<void> {
    const exception = await this.prisma.client.invoiceException.findFirst({
      where: { id: exceptionId, invoiceId },
    });
    if (!exception) throw new NotFoundException('Exception not found');

    const before = { resolved: exception.resolvedAt !== null };
    await this.prisma.client.invoiceException.update({
      where: { id: exceptionId },
      data: {
        resolvedAt: new Date(),
        resolvedBy: actorId,
        resolutionAction: action,
        resolutionNotes: notes,
      },
    });
    await this.audit.record({
      action: 'invoice.exception_resolved',
      entityType: 'InvoiceException',
      entityId: exceptionId,
      actorId,
      before,
      after: { action, notes },
    });

    // Re-run match; the resolved exception is now suppressed.
    await this.runFor(invoiceId, actorId);
  }
}

type PoLineWithItem = {
  uom: string;
  item: {
    uomConversions: { fromUom: string; toUom: string; factor: Prisma.Decimal }[];
  } | null;
};

/**
 * The invoice quantity restated in the PO line's unit, or null when the units
 * already agree or nothing can bridge them.
 *
 * Mirrors what GRN does for a receipt booked in a different unit
 * (`GrnLine.uomConversionFactor`): the item's own conversion edges decide, and
 * the engine is handed the converted number rather than doing lookups itself.
 * Null is not "no problem" — the engine reads it as "these quantities are not
 * comparable" and raises UOM_MISMATCH.
 *
 * Only lines with an explicit `poLineId` can be converted. A line the engine
 * matches by item description is unknown here, so one billed in a different
 * unit is reported rather than converted. That fails closed — a human looks at
 * it — which is the right direction for a line we could not identify anyway.
 */
function qtyInPoUom(
  line: { uom: string; qty: Prisma.Decimal },
  poLine: PoLineWithItem | undefined,
): string | null {
  if (!poLine) return null;
  const conversions = (poLine.item?.uomConversions ?? []).map((c) => ({
    fromUom: c.fromUom,
    toUom: c.toUom,
    factor: c.factor.toString(),
  }));
  if (!hasConversion(line.uom, poLine.uom, conversions)) return null;
  try {
    return convertQty(line.qty.toString(), line.uom, poLine.uom, conversions);
  } catch {
    // hasConversion already cleared the path; treat any residual failure as
    // "cannot reconcile" rather than letting it abort the whole match run.
    return null;
  }
}

function exceptionKey(
  type: string,
  invoiceLineId: string | null,
  poLineId: string | null,
): string {
  return `${type}:${invoiceLineId ?? ''}:${poLineId ?? ''}`;
}
