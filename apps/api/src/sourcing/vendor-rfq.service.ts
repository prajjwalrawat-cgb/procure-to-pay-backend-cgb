import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@procureflow/db';
import type {
  QuoteView,
  RfqDetailResponse,
  VendorRfqListResponse,
} from '@procureflow/shared';

import { PrismaService } from '../prisma/prisma.service';
import { RfqQueryService } from './rfq-query.service';
import { SourcingAuditService } from './sourcing-audit.service';
import { SourcingStateError } from './sourcing.errors';
import { VendorResolverService } from './vendor-resolver.service';

/**
 * Vendor-portal sourcing reads + invitation actions (Slice 6, vendor JWT
 * audience). A vendor only ever sees RFQs it was invited to and its own quotes —
 * never other vendors' participation (Master Context §3 rule #11).
 */
@Injectable()
export class VendorRfqService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vendors: VendorResolverService,
    private readonly rfqQuery: RfqQueryService,
    private readonly audit: SourcingAuditService,
  ) {}

  async listInvited(userId: string): Promise<VendorRfqListResponse> {
    const vendorId = await this.vendors.resolveVendorId(userId);
    const invitations = await this.prisma.client.rfqInvitation.findMany({
      where: { vendorId },
      include: { rfq: true, quotes: { select: { id: true, status: true } } },
      orderBy: { invitedAt: 'desc' },
    });
    return {
      items: invitations
        .filter((inv) => inv.rfq.status !== 'DRAFT')
        .map((inv) => ({
          id: inv.rfqId,
          number: inv.rfq.number,
          title: inv.rfq.title,
          category: inv.rfq.category,
          rfqType: inv.rfq.rfqType,
          status: inv.rfq.status,
          invitationId: inv.id,
          invitationStatus: inv.status,
          bidDeadline: inv.rfq.bidDeadline?.toISOString() ?? null,
          hasQuote: inv.quotes.some(
            (q) => q.status !== 'WITHDRAWN' && q.status !== 'REVISED_SUPERSEDED',
          ),
        })),
    };
  }

  /** Invited-RFQ detail — spec/terms/deadlines/public Q&A, no other vendors. */
  async detail(userId: string, rfqId: string): Promise<RfqDetailResponse> {
    await this.requireInvitation(userId, rfqId);
    const detail = await this.rfqQuery.detail(rfqId);
    // Strip the other invited vendors + procurement-only Q&A visibility.
    return {
      ...detail,
      invitations: [],
      invitedCount: 0,
      submittedCount: 0,
      questions: detail.questions.filter((q) => q.isPublic),
    };
  }

  async acknowledge(userId: string, rfqId: string): Promise<{ ok: true }> {
    const inv = await this.requireInvitation(userId, rfqId);
    if (inv.status === 'INVITED') {
      await this.prisma.client.rfqInvitation.update({
        where: { id: inv.id },
        data: { status: 'ACKNOWLEDGED', acknowledgedAt: new Date() },
      });
    }
    await this.audit.rfq('RFQ_INVITATION_ACKNOWLEDGED', rfqId, userId, {
      invitationId: inv.id,
    });
    return { ok: true };
  }

  async decline(userId: string, rfqId: string, reason: string): Promise<{ ok: true }> {
    const inv = await this.requireInvitation(userId, rfqId);
    if (inv.status === 'QUOTE_SUBMITTED') {
      throw new SourcingStateError('You have already submitted a quote.');
    }
    await this.prisma.client.rfqInvitation.update({
      where: { id: inv.id },
      data: { status: 'DECLINED', declineReason: reason },
    });
    await this.audit.rfq('RFQ_INVITATION_DECLINED', rfqId, userId, {
      invitationId: inv.id,
      reason,
    });
    return { ok: true };
  }

  async myQuotes(userId: string): Promise<QuoteView[]> {
    const vendorId = await this.vendors.resolveVendorId(userId);
    const quotes = await this.prisma.client.quote.findMany({
      where: { vendorId, status: { not: 'REVISED_SUPERSEDED' } },
      include: {
        lines: true,
        attachments: { orderBy: { uploadedAt: 'desc' } },
        vendor: { select: { name: true, isMsme: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return quotes.map((q) => this.toQuoteView(q, true));
  }

  async myQuote(userId: string, quoteId: string): Promise<QuoteView> {
    const vendorId = await this.vendors.resolveVendorId(userId);
    const quote = await this.prisma.client.quote.findUnique({
      where: { id: quoteId },
      include: {
        lines: true,
        attachments: { orderBy: { uploadedAt: 'desc' } },
        vendor: { select: { name: true, isMsme: true } },
      },
    });
    if (!quote) throw new NotFoundException('Quote not found');
    if (quote.vendorId !== vendorId) throw new ForbiddenException('Not your quote.');
    return this.toQuoteView(quote, true);
  }

  /** A vendor sees their OWN quote content in full; buyers are masked elsewhere. */
  private toQuoteView(
    q: Prisma.QuoteGetPayload<{
      include: {
        lines: true;
        attachments: true;
        vendor: { select: { name: true; isMsme: true } };
      };
    }>,
    ownView: boolean,
  ): QuoteView {
    return {
      id: q.id,
      rfqId: q.rfqId,
      vendorId: q.vendorId,
      vendorName: q.vendor.name,
      quoteNo: q.quoteNo,
      envelopeType: q.envelopeType,
      status: q.status,
      currency: q.currency,
      incoterm: q.incoterm,
      validityDays: q.validityDays,
      validityUntil: q.validityUntil?.toISOString() ?? null,
      paymentTermsOffered: q.paymentTermsOffered,
      totalCommercialValue: ownView ? (q.totalCommercialValue?.toString() ?? null) : null,
      submittedAt: q.submittedAt?.toISOString() ?? null,
      submissionHash: ownView ? q.submissionHash : null,
      revisionNo: q.revisionNo,
      deviationSummary: q.deviationSummary as Record<string, unknown> | null,
      isMsme: q.vendor.isMsme,
      attachments: q.attachments.map((a) => ({
        id: a.id,
        docType: a.docType,
        envelope: a.envelope,
        filename: a.filename,
        sizeBytes: a.sizeBytes,
        uploadedAt: a.uploadedAt.toISOString(),
      })),
      lines: q.lines.map((l) => ({
        id: l.id,
        rfqLineId: l.rfqLineId,
        qtyQuoted: l.qtyQuoted.toString(),
        unitPriceNative: ownView ? l.unitPriceNative.toString() : null,
        unitPriceInrLanded: l.unitPriceInrLanded?.toString() ?? null,
        discountPct: l.discountPct.toString(),
        taxRate: l.taxRate.toString(),
        lineTotalNative: ownView ? l.lineTotalNative.toString() : null,
        deliveryLeadDays: l.deliveryLeadDays,
        specCompliance: l.specCompliance,
        deviationNotes: l.deviationNotes,
      })),
    };
  }

  private async requireInvitation(
    userId: string,
    rfqId: string,
  ): Promise<Prisma.RfqInvitationGetPayload<Record<string, never>>> {
    const vendorId = await this.vendors.resolveVendorId(userId);
    const inv = await this.prisma.client.rfqInvitation.findUnique({
      where: { rfqId_vendorId: { rfqId, vendorId } },
    });
    if (!inv) throw new NotFoundException('You are not invited to this RFQ');
    return inv;
  }
}
