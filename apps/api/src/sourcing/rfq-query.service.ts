import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@procureflow/db';
import type {
  AwardView,
  RfqDetailResponse,
  RfqListItem,
  RfqListQuery,
  RfqListResponse,
} from '@procureflow/shared';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import { PrismaService } from '../prisma/prisma.service';

const TAB_STATUS: Record<string, Prisma.RfqWhereInput> = {
  active: { status: { in: ['PUBLISHED', 'Q_AND_A_OPEN', 'BIDDING_OPEN', 'BID_CLOSED'] } },
  draft: { status: 'DRAFT' },
  my_action: { status: { in: ['TECH_OPEN', 'COMMERCIAL_OPEN', 'AWARD_PENDING'] } },
  evaluation: { status: { in: ['EVALUATION', 'COMMERCIAL_OPEN', 'TECH_OPEN'] } },
  awarded: { status: 'AWARDED' },
  cancelled: { status: 'CANCELLED' },
};

/**
 * Buyer-side sourcing reads (Slice 6). The list masks per-vendor submission
 * detail (only the aggregate submitted count is exposed) and the detail view
 * never leaks quote content before the open ceremony.
 */
@Injectable()
export class RfqQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: ApprovalRoutingService,
  ) {}

  async list(query: RfqListQuery): Promise<RfqListResponse> {
    const where: Prisma.RfqWhereInput = { ...(TAB_STATUS[query.tab] ?? {}) };
    if (query.category) where.category = query.category;
    if (query.type) where.rfqType = query.type;

    const rows = await this.prisma.client.rfq.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: {
        _count: { select: { invitations: true } },
        invitations: { where: { status: 'QUOTE_SUBMITTED' }, select: { id: true } },
      },
    });
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const items: RfqListItem[] = page.map((r) => ({
      id: r.id,
      number: r.number,
      title: r.title,
      category: r.category,
      rfqType: r.rfqType,
      status: r.status,
      estimatedValue: r.estimatedValue.toString(),
      currency: r.currency,
      invitedCount: r._count.invitations,
      submittedCount: r.invitations.length,
      bidDeadline: r.bidDeadline?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
    return {
      items,
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
      totalEstimate: items.length,
    };
  }

  async detail(id: string): Promise<RfqDetailResponse> {
    const rfq = await this.prisma.client.rfq.findUnique({
      where: { id },
      include: {
        lines: { orderBy: { lineNo: 'asc' } },
        documents: true,
        corrigenda: { orderBy: { number: 'asc' } },
        invitations: { include: { vendor: true }, orderBy: { invitedAt: 'asc' } },
        questions: {
          include: { invitation: { include: { vendor: { select: { name: true } } } } },
          orderBy: { askedAt: 'asc' },
        },
      },
    });
    if (!rfq) throw new NotFoundException('RFQ not found');

    const submittedCount = rfq.invitations.filter(
      (i) => i.status === 'QUOTE_SUBMITTED',
    ).length;
    const requisition = rfq.requisitionId
      ? await this.prisma.client.requisition.findUnique({
          where: { id: rfq.requisitionId },
          select: { number: true },
        })
      : null;

    return {
      id: rfq.id,
      number: rfq.number,
      title: rfq.title,
      category: rfq.category,
      subcategory: rfq.subcategory,
      rfqType: rfq.rfqType,
      status: rfq.status,
      currency: rfq.currency,
      incotermDefault: rfq.incotermDefault,
      paymentTermsDefault: rfq.paymentTermsDefault,
      estimatedValue: rfq.estimatedValue.toString(),
      requisitionId: rfq.requisitionId,
      requisitionNumber: requisition?.number ?? null,
      allowSplitAward: rfq.allowSplitAward,
      allowPartialAward: rfq.allowPartialAward,
      maxAwardVendors: rfq.maxAwardVendors,
      blindEvaluation: rfq.blindEvaluation,
      isReverseAuction: rfq.isReverseAuction,
      evaluationCriteria:
        rfq.evaluationCriteria as RfqDetailResponse['evaluationCriteria'],
      requiredDocuments: rfq.requiredDocuments as Record<string, boolean>,
      publishBy: rfq.publishBy?.toISOString() ?? null,
      qaDeadline: rfq.qaDeadline?.toISOString() ?? null,
      bidDeadline: rfq.bidDeadline?.toISOString() ?? null,
      techOpenAt: rfq.techOpenAt?.toISOString() ?? null,
      commercialOpenAt: rfq.commercialOpenAt?.toISOString() ?? null,
      awardDeadline: rfq.awardDeadline?.toISOString() ?? null,
      publishedAt: rfq.publishedAt?.toISOString() ?? null,
      corrigendaCount: rfq.corrigendaCount,
      lines: rfq.lines.map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        itemId: l.itemId,
        itemDesc: l.itemDesc,
        uom: l.uom,
        qtyRequired: l.qtyRequired.toString(),
        qtyMinSplit: l.qtyMinSplit.toString(),
        hsnCode: l.hsnCode,
        taxRate: l.taxRate.toString(),
        specDetails: l.specDetails as Record<string, unknown> | null,
        deliveryDateRequired: l.deliveryDateRequired?.toISOString() ?? null,
        unitCostEstimate: l.unitCostEstimate?.toString() ?? null,
        unitWeightKg: l.unitWeightKg?.toString() ?? null,
      })),
      invitations: rfq.invitations.map((i) => ({
        id: i.id,
        vendorId: i.vendorId,
        vendorName: i.vendor.name,
        source: i.invitationSource,
        status: i.status,
        isMsme: i.vendor.isMsme,
        historicalOtif: i.vendor.historicalOtif?.toString() ?? null,
        historicalQuality: i.vendor.historicalQuality?.toString() ?? null,
        acknowledgedAt: i.acknowledgedAt?.toISOString() ?? null,
        declineReason: i.declineReason,
        // Never show a submitted-at against a vendor name pre-open (masked).
        submittedAt: null,
      })),
      questions: rfq.questions.map((q) => ({
        id: q.id,
        invitationId: q.invitationId,
        vendorName: q.invitation.vendor.name,
        questionText: q.questionText,
        isPublic: q.isPublic,
        askedAt: q.askedAt.toISOString(),
        answerText: q.answerText,
        answeredAt: q.answeredAt?.toISOString() ?? null,
        corrigendumId: q.corrigendumIssued,
      })),
      corrigenda: rfq.corrigenda.map((c) => ({
        id: c.id,
        number: c.number,
        title: c.title,
        description: c.description,
        impact: c.impact,
        issuedAt: c.issuedAt.toISOString(),
        newBidDeadline: c.newBidDeadline?.toISOString() ?? null,
      })),
      documents: rfq.documents.map((d) => ({
        id: d.id,
        docType: d.docType,
        filename: d.filename,
        sizeBytes: d.sizeBytes,
        uploadedAt: d.uploadedAt.toISOString(),
      })),
      submittedCount,
      invitedCount: rfq.invitations.length,
    };
  }

  async getAward(awardId: string): Promise<AwardView> {
    const award = await this.prisma.client.award.findUnique({
      where: { id: awardId },
      include: {
        allocations: { include: { vendor: { select: { name: true } } } },
      },
    });
    if (!award) throw new NotFoundException('Award not found');
    const chain = await this.routing.getLiveChain('RFQ_AWARD', awardId);
    return {
      id: award.id,
      rfqId: award.rfqId,
      status: award.status,
      recommendationBy: award.recommendationBy,
      recommendationAt: award.recommendationAt.toISOString(),
      recommendationNotes: award.recommendationNotes,
      varianceFromL1Reason: award.varianceFromL1Reason,
      approvedAt: award.approvedAt?.toISOString() ?? null,
      approvedBy: award.approvedBy,
      totalValue: award.totalValue.toString(),
      approvalChain: chain,
      allocations: award.allocations.map((a) => ({
        quoteId: a.quoteId,
        vendorId: a.vendorId,
        vendorName: a.vendor.name,
        rfqLineId: a.rfqLineId,
        qtyAllocated: a.qtyAllocated.toString(),
        unitPrice: a.unitPrice.toString(),
        totalValue: a.totalValue.toString(),
        poId: a.poId,
      })),
    };
  }

  async awardForRfq(rfqId: string): Promise<AwardView | null> {
    const award = await this.prisma.client.award.findFirst({
      where: { rfqId, status: { not: 'REJECTED' } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return award ? this.getAward(award.id) : null;
  }
}
