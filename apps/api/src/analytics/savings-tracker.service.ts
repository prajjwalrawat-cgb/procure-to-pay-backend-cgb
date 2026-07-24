import { Injectable, type OnModuleInit } from '@nestjs/common';
import { newId } from '@procureflow/db';
import {
  monthKey,
  resolvePeriod,
  SAVINGS_METHODOLOGY,
  SAVINGS_INITIATIVE_TYPES,
  type AnalyticsPeriodQuery,
  type AvoidedCostInput,
  type BuyerLeaderboardResponse,
  type SavingsInitiativeType,
  type SavingsSummaryResponse,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import { AuditLogService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * SavingsTrackerService (Slice 8, ADR-027). Four documented savings categories,
 * kept visually distinct (never one "trust us" number):
 *  - HARD_RFQ: baseline = highest qualified quote for the awarded line vs awarded
 *    price. Auto-computed on RFQ award approval (event hook). Handles split awards.
 *  - PRICE_IMPROVEMENT / SOFT_PAYMENT_TERM: methodology defined; auto-capture is
 *    deferred (no PO-issue event hook exists without modifying Slice 4).
 *  - AVOIDED_COST: self-reported via the manual endpoint, flagged in the UI.
 */
@Injectable()
export class SavingsTrackerService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: ApprovalRoutingService,
    private readonly audit: AuditLogService,
  ) {}

  onModuleInit(): void {
    // Auto-compute hard savings when an RFQ award is fully approved.
    this.routing.onApproved('RFQ_AWARD', (awardId, actorId) =>
      this.recordRfqSavings(awardId, actorId),
    );
  }

  /**
   * Hard savings from an approved award: for each allocation, baseline =
   * highest qualified-quote landed unit price for that line; savings =
   * (baseline − awarded) × qty, floored at 0. Aggregated across a split award
   * into one ledger entry per award. Idempotent.
   */
  async recordRfqSavings(awardId: string, actorId: string): Promise<void> {
    const award = await this.prisma.client.award.findUnique({
      where: { id: awardId },
      include: { allocations: true, rfq: { select: { category: true } } },
    });
    if (!award || award.allocations.length === 0) return;

    const quotes = await this.prisma.client.quote.findMany({
      where: { rfqId: award.rfqId, status: { in: ['QUALIFIED', 'OPENED'] } },
      include: { lines: true },
    });
    // baseline (highest qualified landed unit price) per rfq line.
    const baselineByLine = new Map<string, Decimal>();
    for (const q of quotes) {
      for (const l of q.lines) {
        const price = new Decimal((l.unitPriceInrLanded ?? l.unitPriceNative).toString());
        const cur = baselineByLine.get(l.rfqLineId);
        if (!cur || price.greaterThan(cur)) baselineByLine.set(l.rfqLineId, price);
      }
    }

    let baselineValue = new Decimal(0);
    let awardedValue = new Decimal(0);
    for (const a of award.allocations) {
      const qty = new Decimal(a.qtyAllocated.toString());
      const awarded = new Decimal(a.unitPrice.toString());
      const baseline = baselineByLine.get(a.rfqLineId) ?? awarded; // no baseline → no savings
      baselineValue = baselineValue.plus(Decimal.max(baseline, awarded).times(qty));
      awardedValue = awardedValue.plus(awarded.times(qty));
    }
    const savings = Decimal.max(baselineValue.minus(awardedValue), new Decimal(0));
    const savingsPct = baselineValue.gt(0)
      ? savings.div(baselineValue).times(100)
      : new Decimal(0);
    const period = monthKey(award.approvedAt ?? new Date());

    await this.writeEntry({
      periodMonth: period,
      initiativeType: 'HARD_RFQ',
      sourceType: 'RFQ_AWARD',
      sourceId: awardId,
      vendorId: null,
      category: award.rfq.category,
      baselineValue,
      awardedValue,
      savingsAmount: savings,
      savingsPct,
      buyerId: award.recommendationBy,
      status: 'CONFIRMED',
      notes: null,
      actorId,
    });
  }

  async recordAvoidedCost(
    input: AvoidedCostInput,
    actorId: string,
  ): Promise<{ id: string }> {
    const baseline = new Decimal(input.baselineValue);
    const awarded = new Decimal(input.awardedValue);
    const savings = Decimal.max(baseline.minus(awarded), new Decimal(0));
    const savingsPct = baseline.gt(0) ? savings.div(baseline).times(100) : new Decimal(0);
    const id = await this.writeEntry({
      periodMonth: monthKey(new Date()),
      initiativeType: 'AVOIDED_COST',
      sourceType: 'MANUAL',
      sourceId: null,
      vendorId: input.vendorId ?? null,
      category: input.category ?? null,
      baselineValue: baseline,
      awardedValue: awarded,
      savingsAmount: savings,
      savingsPct,
      buyerId: actorId,
      // Self-reported → held for lightweight review before it counts as confirmed.
      status: 'PENDING_REVIEW',
      notes: input.notes,
      actorId,
    });
    return { id };
  }

  private async writeEntry(e: {
    periodMonth: string;
    initiativeType: SavingsInitiativeType;
    sourceType: 'RFQ_AWARD' | 'NEGOTIATED_PO' | 'PAYMENT_TERM' | 'MANUAL';
    sourceId: string | null;
    vendorId: string | null;
    category: string | null;
    baselineValue: Decimal;
    awardedValue: Decimal;
    savingsAmount: Decimal;
    savingsPct: Decimal;
    buyerId: string | null;
    status: 'CONFIRMED' | 'PENDING_REVIEW' | 'REJECTED';
    notes: string | null;
    actorId: string;
  }): Promise<string> {
    // Idempotent for auto-sourced entries (award re-approval): replace prior.
    if (e.sourceId) {
      await this.prisma.client.savingsLedgerEntry.deleteMany({
        where: {
          sourceType: e.sourceType,
          sourceId: e.sourceId,
          initiativeType: e.initiativeType,
        },
      });
    }
    const id = newId('savingsLedgerEntry');
    await this.prisma.client.savingsLedgerEntry.create({
      data: {
        id,
        tenantId: this.prisma.currentTenantId ?? '',
        periodMonth: e.periodMonth,
        initiativeType: e.initiativeType,
        sourceType: e.sourceType,
        sourceId: e.sourceId,
        vendorId: e.vendorId,
        category: e.category,
        baselineValue: e.baselineValue.toFixed(4),
        awardedValue: e.awardedValue.toFixed(4),
        savingsAmount: e.savingsAmount.toFixed(4),
        savingsPct: e.savingsPct.toFixed(4),
        buyerId: e.buyerId,
        status: e.status,
        notes: e.notes,
        createdBy: e.actorId,
      },
    });
    await this.audit.record({
      action: 'SAVINGS_EVENT_RECORDED',
      entityType: 'SavingsLedgerEntry',
      entityId: id,
      actorId: e.actorId,
      after: {
        initiativeType: e.initiativeType,
        savingsAmount: e.savingsAmount.toFixed(4),
        sourceType: e.sourceType,
        sourceId: e.sourceId,
      },
    });
    return id;
  }

  async getSavingsSummary(q: AnalyticsPeriodQuery): Promise<SavingsSummaryResponse> {
    const p = resolvePeriod(q, new Date());
    const entries = await this.prisma.client.savingsLedgerEntry.findMany({
      where: { periodMonth: { in: p.months }, status: 'CONFIRMED' },
      orderBy: { createdAt: 'desc' },
    });
    const totals = SAVINGS_INITIATIVE_TYPES.map((t) => {
      const rows = entries.filter((e) => e.initiativeType === t);
      const amount = rows.reduce(
        (s, e) => s.plus(e.savingsAmount.toString()),
        new Decimal(0),
      );
      return {
        initiativeType: t,
        label: SAVINGS_METHODOLOGY[t].label,
        amount: amount.toFixed(4),
        count: rows.length,
        selfReported: SAVINGS_METHODOLOGY[t].selfReported,
        hard: SAVINGS_METHODOLOGY[t].hard,
      };
    });
    const hardTotal = totals
      .filter((t) => t.hard)
      .reduce((s, t) => s.plus(t.amount), new Decimal(0));
    const allIn = totals.reduce((s, t) => s.plus(t.amount), new Decimal(0));
    const byMonth = new Map<string, Decimal>();
    for (const e of entries) {
      byMonth.set(
        e.periodMonth,
        (byMonth.get(e.periodMonth) ?? new Decimal(0)).plus(e.savingsAmount.toString()),
      );
    }
    return {
      totals,
      hardSavingsTotal: hardTotal.toFixed(4),
      allInSavingsTotal: allIn.toFixed(4),
      initiatives: entries.map((e) => ({
        id: e.id,
        initiativeType: e.initiativeType,
        sourceType: e.sourceType,
        sourceId: e.sourceId,
        vendorId: e.vendorId,
        category: e.category,
        savingsAmount: e.savingsAmount.toFixed(4),
        savingsPct: e.savingsPct.toFixed(4),
        baselineValue: e.baselineValue.toFixed(4),
        awardedValue: e.awardedValue.toFixed(4),
        createdAt: e.createdAt.toISOString(),
        status: e.status,
        notes: e.notes,
      })),
      trend: p.months.map((m) => ({
        month: m,
        amount: (byMonth.get(m) ?? new Decimal(0)).toFixed(4),
      })),
      refreshedAt: null, // ledger is live (written by events + manual)
    };
  }

  async getBuyerLeaderboard(q: AnalyticsPeriodQuery): Promise<BuyerLeaderboardResponse> {
    const p = resolvePeriod(q, new Date());
    const entries = await this.prisma.client.savingsLedgerEntry.findMany({
      where: {
        periodMonth: { in: p.months },
        status: 'CONFIRMED',
        buyerId: { not: null },
      },
    });
    const byBuyer = new Map<string, { amount: Decimal; count: number }>();
    for (const e of entries) {
      const id = e.buyerId as string;
      const cur = byBuyer.get(id) ?? { amount: new Decimal(0), count: 0 };
      cur.amount = cur.amount.plus(e.savingsAmount.toString());
      cur.count += 1;
      byBuyer.set(id, cur);
    }
    const users = await this.prisma.client.user.findMany({
      where: { id: { in: [...byBuyer.keys()] } },
      select: { id: true, name: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    const rows = [...byBuyer.entries()]
      .map(([buyerId, v]) => ({
        buyerId,
        buyerName: nameById.get(buyerId) ?? buyerId,
        savingsAmount: v.amount.toFixed(4),
        initiativeCount: v.count,
      }))
      .sort((a, b) => new Decimal(b.savingsAmount).comparedTo(a.savingsAmount));
    return { rows, refreshedAt: null };
  }
}
