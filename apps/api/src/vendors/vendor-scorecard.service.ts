import { Injectable } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import {
  VENDOR_EVENTS,
  computeComposite,
  computeRiskScore,
  isVendorFaultRejection,
  type ScorecardMetrics,
  type ScorecardPeriod,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { DomainEventService } from '../common/events/domain-event.service';
import { PrismaService } from '../prisma/prisma.service';

const PERIOD_DAYS: Record<ScorecardPeriod, number | null> = {
  ROLLING_90D: 90,
  ROLLING_365D: 365,
  ALL_TIME: null,
};

/**
 * VendorScorecardService (Slice 7 §6, ADR-022). Reads Slice 5 GRN, Slice 1
 * invoice, Slice 4 PO and Slice 6 RFQ data to compute a performance scorecard
 * and a separate risk-of-doing-business score; the pure math lives in
 * @procureflow/shared. Cold-start (<3 transactions) → N/A grade.
 */
@Injectable()
export class VendorScorecardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEventService,
  ) {}

  async computeScorecard(
    vendorId: string,
    categoryKey: string | null,
    period: ScorecardPeriod,
    actorId: string | null,
  ): Promise<{ id: string; score: number | null; grade: string }> {
    const vendor = await this.prisma.client.vendor.findUniqueOrThrow({
      where: { id: vendorId },
    });
    const days = PERIOD_DAYS[period];
    const since = days ? new Date(Date.now() - days * 86_400_000) : null;

    const grns = await this.prisma.client.goodsReceiptNote.findMany({
      where: {
        po: { vendorId },
        status: 'POSTED',
        ...(since ? { postedAt: { gte: since } } : {}),
      },
      include: { lines: { include: { poLine: true } }, po: true },
    });

    let onTime = 0;
    let grnCount = 0;
    let accepted = new Decimal(0);
    let received = new Decimal(0);
    let spend = new Decimal(0);
    for (const grn of grns) {
      grnCount += 1;
      const expected = grn.po.expectedDeliveryDate;
      const inFull = grn.lines.every((l) =>
        new Decimal(l.qtyAccepted.toString()).greaterThanOrEqualTo(
          l.poLine.qtyOrdered.toString(),
        ),
      );
      if (expected && grn.receivedAt.getTime() <= expected.getTime() && inFull)
        onTime += 1;
      for (const l of grn.lines) {
        const acceptedQty = new Decimal(l.qtyAccepted.toString());
        accepted = accepted.plus(acceptedQty);
        // Only vendor-fault rejections dent quality; buyer-fault ones (over-supply
        // — buyer over-ordered, returning excess) are excluded entirely (I9).
        const rejectedQty = isVendorFaultRejection(l.rejectionReason)
          ? new Decimal(l.qtyRejected.toString())
          : new Decimal(0);
        received = received.plus(acceptedQty.plus(rejectedQty));
        spend = spend.plus(acceptedQty.times(l.unitLandedCost.toString()));
      }
    }

    const invoices = await this.prisma.client.invoice.findMany({
      where: { vendorId, ...(since ? { createdAt: { gte: since } } : {}) },
      include: {
        exceptions: { where: { resolvedAt: null, supersededAt: null }, select: { id: true } },
      },
    });
    const disputed = invoices.filter((i) => i.exceptions.length > 0).length;

    const invitations = await this.prisma.client.rfqInvitation.findMany({
      where: { vendorId, ...(since ? { invitedAt: { gte: since } } : {}) },
    });
    const acknowledged = invitations.filter(
      (i) => i.status !== 'INVITED' && i.status !== 'DECLINED',
    ).length;

    const quotes = await this.prisma.client.quote.findMany({
      where: { vendorId, ...(since ? { createdAt: { gte: since } } : {}) },
      include: { awardAllocations: { select: { id: true }, take: 1 }, invitation: true },
    });
    const submitted = quotes.filter((q) => q.submittedAt !== null);
    const won = submitted.filter((q) => q.awardAllocations.length > 0).length;
    let responseHrsSum = 0;
    let responseCount = 0;
    for (const q of submitted) {
      if (q.submittedAt && q.invitation) {
        responseHrsSum +=
          (q.submittedAt.getTime() - q.invitation.invitedAt.getTime()) / 3_600_000;
        responseCount += 1;
      }
    }

    const metrics: ScorecardMetrics = {
      otifPct: grnCount > 0 ? round((onTime / grnCount) * 100) : null,
      qualityPct: received.greaterThan(0)
        ? round(accepted.dividedBy(received).times(100).toNumber())
        : null,
      responseTimeAvgHrs:
        responseCount > 0 ? round(responseHrsSum / responseCount) : null,
      disputeRatePct:
        invoices.length > 0 ? round((disputed / invoices.length) * 100) : null,
      paymentCycleDays: null,
      rfqParticipationPct:
        invitations.length > 0 ? round((acknowledged / invitations.length) * 100) : null,
      winRatePct: submitted.length > 0 ? round((won / submitted.length) * 100) : null,
    };

    const composite = computeComposite(metrics, grnCount);
    const id = newId('vendorScorecard');
    await this.prisma.client.vendorScorecard.upsert({
      where: {
        vendorId_categoryKey_period: { vendorId, categoryKey: categoryKey ?? '', period },
      },
      create: {
        id,
        tenantId: vendor.tenantId,
        vendorId,
        categoryKey,
        period,
        metrics: metrics as unknown as Prisma.InputJsonValue,
        score: composite.score !== null ? new Prisma.Decimal(composite.score) : null,
        grade: composite.grade,
        transactionCount: grnCount,
        spendAmount: new Prisma.Decimal(spend.toFixed(4)),
        computedBy: actorId,
      },
      update: {
        metrics: metrics as unknown as Prisma.InputJsonValue,
        score: composite.score !== null ? new Prisma.Decimal(composite.score) : null,
        grade: composite.grade,
        transactionCount: grnCount,
        spendAmount: new Prisma.Decimal(spend.toFixed(4)),
        computedAt: new Date(),
        computedBy: actorId,
      },
    });
    await this.events.emit(VENDOR_EVENTS.VENDOR_SCORECARD_COMPUTED, {
      vendorId,
      categoryKey: categoryKey ?? '',
      score: composite.score,
      grade: composite.grade,
    });
    // Also refresh the risk score.
    await this.computeRiskScore(vendorId);
    return { id, score: composite.score, grade: composite.grade };
  }

  async computeRiskScore(vendorId: string): Promise<{ score: number; grade: string }> {
    const vendor = await this.prisma.client.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      include: {
        screenings: true,
        documents: true,
        suspensions: { where: { suspensionType: 'BLACKLIST' } },
      },
    });
    const now = Date.now();
    const expiringSoon = vendor.documents.filter(
      (d) =>
        d.validTo &&
        d.validTo.getTime() > now &&
        d.validTo.getTime() < now + 30 * 86_400_000,
    ).length;
    const expired = vendor.documents.filter(
      (d) =>
        d.verificationStatus === 'EXPIRED' || (d.validTo && d.validTo.getTime() < now),
    ).length;
    const sanctionsFlagged = vendor.screenings.some(
      (s) => s.screeningType.startsWith('SANCTIONS') && s.status === 'FLAGGED',
    );
    const adverseMediaFlagged = vendor.screenings.some(
      (s) => s.screeningType === 'ADVERSE_MEDIA' && s.status === 'FLAGGED',
    );
    const risk = computeRiskScore({
      sanctionsFlagged,
      adverseMediaFlagged,
      creditRating: 85,
      documentsExpiringSoon: expiringSoon,
      documentsExpired: expired,
      disputeRatePct: null,
      blacklistHistory: vendor.suspensions.length > 0,
    });
    await this.prisma.client.vendor.update({
      where: { id: vendorId },
      data: {
        riskScore: new Prisma.Decimal(risk.score),
        riskGrade: risk.grade,
        riskLastComputedAt: new Date(),
      },
    });
    return risk;
  }

  /** Nightly job: recompute for all active vendors in a tenant. */
  async refreshAll(tenantId: string): Promise<{ updated: number }> {
    const vendors = await this.prisma.client.vendor.findMany({
      where: { tenantId, lifecycleStatus: 'ACTIVE' },
      select: { id: true },
    });
    for (const v of vendors) await this.computeScorecard(v.id, null, 'ROLLING_90D', null);
    return { updated: vendors.length };
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
