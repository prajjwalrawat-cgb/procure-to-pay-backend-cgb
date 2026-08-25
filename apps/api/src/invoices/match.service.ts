import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import Decimal from 'decimal.js';
import {
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
        po: { include: { lines: true, grns: { include: { lines: true } } } },
        exceptions: true,
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

    const grnLines = invoice.po?.grns.flatMap((g) => g.lines) ?? [];
    const input: MatchInput = {
      tolerances,
      isDuplicate: duplicates > 0,
      po: invoice.po
        ? {
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
              qtyAlreadyInvoiced: (invoicedByPoLine.get(l.id) ?? new Decimal(0)).toString(),
            })),
          }
        : null,
      grn:
        invoice.po && grnLines.length > 0
          ? {
              lines: grnLines.map((l) => ({
                poLineId: l.poLineId,
                qtyAccepted: l.qtyAccepted.toString(),
                qtyRejected: l.qtyRejected.toString(),
              })),
            }
          : null,
      invoice: {
        lines: invoice.lines.map((l) => ({
          id: l.id,
          lineNo: l.lineNo,
          itemDesc: l.itemDesc,
          uom: l.uom,
          qty: l.qty.toString(),
          unitPrice: l.unitPrice.toString(),
          taxRate: l.taxRate.toString(),
          poLineId: l.poLineId,
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

function exceptionKey(
  type: string,
  invoiceLineId: string | null,
  poLineId: string | null,
): string {
  return `${type}:${invoiceLineId ?? ''}:${poLineId ?? ''}`;
}
