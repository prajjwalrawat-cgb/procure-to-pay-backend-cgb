import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import {
  SOURCING_EVENTS,
  computeSubmissionHash,
  shortHash,
  type QuoteAttachmentInput,
  type QuoteCreateInput,
  type QuoteUpdateInput,
  type QuoteSealLineInput,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { NotificationService } from '../approvals/notification.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { SourcingAuditService } from './sourcing-audit.service';
import {
  EnvelopeError,
  SourcingStateError,
  SourcingValidationError,
} from './sourcing.errors';
import { VendorResolverService } from './vendor-resolver.service';

/**
 * QuoteService (Slice 6 §4). Vendor-facing (vendor JWT audience). Builds a
 * sealed quote: lines auto-total, attachments are envelope-segregated for
 * two-envelope RFQs, and submit computes a tamper-evident submission hash the
 * buyer cannot read until the formal open ceremony.
 */
@Injectable()
export class QuoteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: SourcingAuditService,
    private readonly events: DomainEventService,
    private readonly notifications: NotificationService,
    private readonly vendors: VendorResolverService,
  ) {}

  async createDraft(input: QuoteCreateInput, actorId: string): Promise<{ id: string }> {
    const vendorId = await this.vendors.resolveVendorId(actorId);
    // Resolve the vendor's own invitation from the JWT when not supplied.
    const invitation = input.invitationId
      ? await this.prisma.client.rfqInvitation.findUnique({
          where: { id: input.invitationId },
          include: { rfq: true },
        })
      : await this.prisma.client.rfqInvitation.findUnique({
          where: { rfqId_vendorId: { rfqId: input.rfqId, vendorId } },
          include: { rfq: true },
        });
    if (!invitation || invitation.rfqId !== input.rfqId) {
      throw new NotFoundException('Invitation not found for this RFQ');
    }
    if (invitation.vendorId !== vendorId) {
      throw new ForbiddenException('This invitation is not yours.');
    }
    if (invitation.status === 'DECLINED') {
      throw new SourcingStateError('You declined this RFQ.');
    }
    const rfq = invitation.rfq;
    if (!['BIDDING_OPEN', 'Q_AND_A_OPEN'].includes(rfq.status)) {
      throw new SourcingStateError('Bidding is not open for this RFQ.', {
        status: rfq.status,
      });
    }
    if (rfq.bidDeadline && rfq.bidDeadline.getTime() < Date.now()) {
      throw new SourcingStateError('The bid deadline has passed.');
    }
    const existing = await this.prisma.client.quote.findFirst({
      where: {
        invitationId: invitation.id,
        status: { notIn: ['WITHDRAWN', 'REVISED_SUPERSEDED'] },
      },
    });
    if (existing) return { id: existing.id };

    const id = newId('quote');
    await this.prisma.client.quote.create({
      data: {
        id,
        tenantId: rfq.tenantId,
        rfqId: rfq.id,
        invitationId: invitation.id,
        vendorId,
        quoteNo: input.quoteNo ?? null,
        envelopeType: input.envelopeType,
        status: 'DRAFT',
        currency: rfq.currency,
        incoterm: rfq.incotermDefault,
        attachmentManifest: [] as unknown as Prisma.InputJsonValue,
      },
    });
    await this.audit.quote('QUOTE_DRAFTED', id, actorId, { rfqId: rfq.id });
    return { id };
  }

  async updateDraft(
    quoteId: string,
    input: QuoteUpdateInput,
    actorId: string,
  ): Promise<{ ok: true }> {
    const quote = await this.requireOwnDraft(quoteId, actorId);
    const rfqLines = await this.prisma.client.rfqLine.findMany({
      where: { rfqId: quote.rfqId },
      select: { id: true },
    });
    const validLineIds = new Set(rfqLines.map((l) => l.id));

    await this.prisma.client.quoteLine.deleteMany({ where: { quoteId } });
    const lines = input.lines.map((line) => {
      if (!validLineIds.has(line.rfqLineId)) {
        throw new SourcingValidationError('Quote line references an unknown RFQ line.', {
          rfqLineId: line.rfqLineId,
        });
      }
      const lineTotal = new Decimal(line.qtyQuoted)
        .times(line.unitPriceNative)
        .times(new Decimal(1).minus(line.discountPct))
        .times(new Decimal(1).plus(line.taxRate));
      return {
        id: newId('quoteLine'),
        tenantId: quote.tenantId,
        quoteId,
        rfqLineId: line.rfqLineId,
        qtyQuoted: new Prisma.Decimal(line.qtyQuoted),
        unitPriceNative: new Prisma.Decimal(line.unitPriceNative),
        discountPct: new Prisma.Decimal(line.discountPct),
        taxRate: new Prisma.Decimal(line.taxRate),
        lineFreightNative: line.lineFreightNative
          ? new Prisma.Decimal(line.lineFreightNative)
          : null,
        lineCustomsNative: line.lineCustomsNative
          ? new Prisma.Decimal(line.lineCustomsNative)
          : null,
        lineTotalNative: new Prisma.Decimal(lineTotal.toFixed(4)),
        deliveryLeadDays: line.deliveryLeadDays,
        specCompliance: line.specCompliance,
        deviationNotes: line.deviationNotes ?? null,
        noQuoteReason: line.noQuoteReason ?? null,
      };
    });
    await this.prisma.client.quoteLine.createMany({ data: lines });

    await this.prisma.client.quote.update({
      where: { id: quoteId },
      data: {
        currency: input.currency ?? quote.currency,
        incoterm: input.incoterm ?? quote.incoterm,
        deliveryLocationOffered: input.deliveryLocationOffered ?? null,
        validityDays: input.validityDays ?? null,
        paymentTermsOffered: input.paymentTermsOffered ?? null,
      },
    });
    return { ok: true };
  }

  async attachFile(
    quoteId: string,
    input: QuoteAttachmentInput,
    actorId: string,
  ): Promise<{ id: string }> {
    const quote = await this.requireOwnDraft(quoteId, actorId);
    // Two-envelope: enforce envelope segregation by doc type.
    if (input.envelope === 'TECHNICAL' && input.docType === 'COMMERCIAL_BID') {
      throw new EnvelopeError('A commercial bid cannot go in the technical envelope.');
    }
    if (input.envelope === 'COMMERCIAL' && input.docType === 'TECH_SPEC') {
      throw new EnvelopeError('A technical spec cannot go in the commercial envelope.');
    }
    const id = newId('quoteAttachment');
    await this.prisma.client.quoteAttachment.create({
      data: {
        id,
        tenantId: quote.tenantId,
        quoteId,
        docType: input.docType,
        s3Key: input.s3Key,
        filename: input.filename,
        sizeBytes: input.sizeBytes,
        mimeType: input.mimeType,
        fileHash: input.fileHash,
        envelope: input.envelope,
        watermarkApplied: false,
      },
    });
    return { id };
  }

  async submit(
    quoteId: string,
    actorId: string,
  ): Promise<{ submissionHash: string; short: string }> {
    const quote = await this.prisma.client.quote.findUnique({
      where: { id: quoteId },
      include: { lines: true, attachments: true, rfq: true, invitation: true },
    });
    if (!quote) throw new NotFoundException('Quote not found');
    const vendorId = await this.vendors.resolveVendorId(actorId);
    if (quote.vendorId !== vendorId) throw new ForbiddenException('Not your quote.');
    if (quote.status !== 'DRAFT' && quote.status !== 'RESUBMISSION_REQUIRED') {
      throw new SourcingStateError('Only a draft quote can be submitted.', {
        status: quote.status,
      });
    }
    if (quote.rfq.bidDeadline && quote.rfq.bidDeadline.getTime() < Date.now()) {
      throw new SourcingStateError('The bid deadline has passed.');
    }
    const rfqLines = await this.prisma.client.rfqLine.findMany({
      where: { rfqId: quote.rfqId },
    });
    const quotedLineIds = new Set(quote.lines.map((l) => l.rfqLineId));
    for (const rl of rfqLines) {
      const ql = quote.lines.find((l) => l.rfqLineId === rl.id);
      if (!ql) {
        throw new SourcingValidationError('Every RFQ line must be quoted or declined.', {
          rfqLineId: rl.id,
        });
      }
      if (
        !ql.noQuoteReason &&
        new Decimal(ql.unitPriceNative.toString()).lessThanOrEqualTo(0)
      ) {
        throw new SourcingValidationError('Quote a price or give a no-quote reason.', {
          rfqLineId: rl.id,
        });
      }
    }
    // Mandatory documents check.
    const required = quote.rfq.requiredDocuments as Record<string, boolean>;
    if (
      required &&
      Object.values(required).some(Boolean) &&
      quote.attachments.length === 0
    ) {
      throw new SourcingValidationError('Mandatory documents are missing.');
    }

    const quoteNo = quote.quoteNo ?? `Q-${quote.id.slice(-8).toUpperCase()}`;
    const sealLines: QuoteSealLineInput[] = quote.lines.map((l) => ({
      rfqLineId: l.rfqLineId,
      qtyQuoted: l.qtyQuoted.toString(),
      unitPriceNative: l.unitPriceNative.toString(),
      discountPct: l.discountPct.toString(),
      taxRate: l.taxRate.toString(),
      lineTotalNative: l.lineTotalNative.toString(),
      deliveryLeadDays: l.deliveryLeadDays,
      specCompliance: l.specCompliance,
      deviationNotes: l.deviationNotes,
    }));
    const submissionHash = computeSubmissionHash({
      rfqId: quote.rfqId,
      invitationId: quote.invitationId,
      vendorId: quote.vendorId,
      quoteNo,
      envelopeType: quote.envelopeType,
      currency: quote.currency,
      incoterm: quote.incoterm,
      validityDays: quote.validityDays ?? 0,
      paymentTermsOffered: quote.paymentTermsOffered ?? '',
      revisionNo: quote.revisionNo,
      lines: sealLines,
      attachmentHashes: quote.attachments.map((a) => a.fileHash),
    });

    const validityUntil = quote.validityDays
      ? new Date(Date.now() + quote.validityDays * 24 * 60 * 60 * 1000)
      : null;
    const deviations = quote.lines
      .filter((l) => l.specCompliance !== 'FULL')
      .map((l) => ({
        rfqLineId: l.rfqLineId,
        compliance: l.specCompliance,
        notes: l.deviationNotes,
      }));

    await this.prisma.client.quote.update({
      where: { id: quoteId },
      data: {
        status: 'SUBMITTED',
        quoteNo,
        submittedAt: new Date(),
        submissionHash,
        validityUntil,
        deviationSummary: deviations as unknown as Prisma.InputJsonValue,
        attachmentManifest: quote.attachments.map((a) => ({
          filename: a.filename,
          hash: a.fileHash,
          envelope: a.envelope,
        })) as unknown as Prisma.InputJsonValue,
      },
    });
    await this.prisma.client.rfqInvitation.update({
      where: { id: quote.invitationId },
      data: { status: 'QUOTE_SUBMITTED' },
    });
    await this.audit.quote('QUOTE_SUBMITTED', quoteId, actorId, {
      rfqId: quote.rfqId,
      submissionHash,
      lineCount: quotedLineIds.size,
    });
    await this.events.emit(SOURCING_EVENTS.QUOTE_SUBMITTED, {
      quoteId,
      rfqId: quote.rfqId,
      vendorId: quote.vendorId,
      submissionHash,
    });
    // Buyer gets only the aggregate count — never the vendor or values.
    const [submitted, invited] = await Promise.all([
      this.prisma.client.rfqInvitation.count({
        where: { rfqId: quote.rfqId, status: 'QUOTE_SUBMITTED' },
      }),
      this.prisma.client.rfqInvitation.count({ where: { rfqId: quote.rfqId } }),
    ]);
    await this.notifications.notify({
      userId: quote.rfq.createdBy,
      type: 'RFQ_QUOTE_SUBMITTED',
      title: `${submitted} of ${invited} vendors have submitted on ${quote.rfq.number}`,
      entityType: 'Rfq',
      entityId: quote.rfqId,
      href: `/sourcing/${quote.rfqId}`,
    });
    return { submissionHash, short: shortHash(submissionHash) };
  }

  async withdraw(
    quoteId: string,
    reason: string,
    actorId: string,
  ): Promise<{ ok: true }> {
    const quote = await this.prisma.client.quote.findUnique({
      where: { id: quoteId },
      include: { rfq: true },
    });
    if (!quote) throw new NotFoundException('Quote not found');
    const vendorId = await this.vendors.resolveVendorId(actorId);
    if (quote.vendorId !== vendorId) throw new ForbiddenException('Not your quote.');
    const afterDeadline =
      !!quote.rfq.bidDeadline && quote.rfq.bidDeadline.getTime() < Date.now();
    if (afterDeadline) {
      throw new SourcingStateError(
        'Post-deadline withdrawal requires procurement approval (and a scorecard black mark).',
      );
    }
    await this.prisma.client.quote.update({
      where: { id: quoteId },
      data: { status: 'WITHDRAWN', withdrawnAt: new Date(), withdrawalReason: reason },
    });
    await this.prisma.client.rfqInvitation.update({
      where: { id: quote.invitationId },
      data: { status: 'ACKNOWLEDGED' },
    });
    await this.audit.quote('QUOTE_WITHDRAWN', quoteId, actorId, { reason });
    return { ok: true };
  }

  async revise(quoteId: string, actorId: string): Promise<{ id: string }> {
    const quote = await this.prisma.client.quote.findUnique({
      where: { id: quoteId },
      include: { rfq: true, lines: true },
    });
    if (!quote) throw new NotFoundException('Quote not found');
    const vendorId = await this.vendors.resolveVendorId(actorId);
    if (quote.vendorId !== vendorId) throw new ForbiddenException('Not your quote.');
    if (!quote.rfq.allowBidRevision) {
      throw new SourcingStateError('This RFQ does not allow revisions.');
    }
    if (quote.revisionNo >= quote.rfq.revisionCountMax) {
      throw new SourcingStateError('Maximum revisions reached.');
    }
    await this.prisma.client.quote.update({
      where: { id: quoteId },
      data: { status: 'REVISED_SUPERSEDED' },
    });
    const id = newId('quote');
    await this.prisma.client.quote.create({
      data: {
        id,
        tenantId: quote.tenantId,
        rfqId: quote.rfqId,
        invitationId: quote.invitationId,
        vendorId,
        quoteNo: quote.quoteNo,
        envelopeType: quote.envelopeType,
        status: 'DRAFT',
        currency: quote.currency,
        incoterm: quote.incoterm,
        revisionNo: quote.revisionNo + 1,
        attachmentManifest: [] as unknown as Prisma.InputJsonValue,
      },
    });
    await this.audit.quote('QUOTE_REVISED', id, actorId, {
      supersedes: quoteId,
      revisionNo: quote.revisionNo + 1,
    });
    return { id };
  }

  private async requireOwnDraft(
    quoteId: string,
    actorId: string,
  ): Promise<Prisma.QuoteGetPayload<Record<string, never>>> {
    const quote = await this.prisma.client.quote.findUnique({ where: { id: quoteId } });
    if (!quote) throw new NotFoundException('Quote not found');
    const vendorId = await this.vendors.resolveVendorId(actorId);
    if (quote.vendorId !== vendorId) throw new ForbiddenException('Not your quote.');
    if (quote.status !== 'DRAFT' && quote.status !== 'RESUBMISSION_REQUIRED') {
      throw new SourcingStateError('This quote can no longer be edited.', {
        status: quote.status,
      });
    }
    return quote;
  }
}
