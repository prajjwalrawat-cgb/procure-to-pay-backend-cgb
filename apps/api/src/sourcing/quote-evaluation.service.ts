import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import {
  autoScoreDelivery,
  autoScorePrice,
  weightedTotal,
  type ComparisonMatrixResponse,
  type ComparisonRow,
  type EvaluationCriterion,
  type QuoteEvaluateInput,
  type RfqLineView,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { PrismaService } from '../prisma/prisma.service';
import { SourcingAuditService } from './sourcing-audit.service';
import { SourcingStateError } from './sourcing.errors';

type EvaluableQuote = Prisma.QuoteGetPayload<{
  include: { lines: true; vendor: true; evaluations: true };
}>;

/**
 * QuoteEvaluationService (Slice 6 §7). Auto-scores price + delivery on an
 * L1-relative basis (with MSME preference), records manual criterion scores,
 * and assembles the apples-to-apples comparison matrix — masking commercial
 * values pre-open and vendor names in blind-evaluation mode.
 */
@Injectable()
export class QuoteEvaluationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: SourcingAuditService,
  ) {}

  async autoScore(rfqId: string, actorId: string): Promise<{ scored: number }> {
    const rfq = await this.requireCommercialOpen(rfqId);
    const criteria = this.criteria(rfq);
    const priceCrit = criteria.find((c) => c.key === 'price');
    const deliveryCrit = criteria.find((c) => c.key === 'delivery');
    const tenant = await this.prisma.client.tenant.findUniqueOrThrow({
      where: { id: rfq.tenantId },
    });

    const quotes = await this.evaluableQuotes(rfqId);
    if (priceCrit) {
      const prices = autoScorePrice(
        quotes.map((q) => ({
          quoteId: q.id,
          totalCommercialValue: q.totalCommercialValue?.toString() ?? '0',
          isMsme: q.vendor.isMsme,
        })),
        Number(tenant.msmePreferencePct.toString()),
      );
      for (const p of prices) {
        await this.persist(quotes, p.quoteId, priceCrit, p.score, actorId);
      }
    }
    if (deliveryCrit) {
      const deliveries = autoScoreDelivery(
        quotes.map((q) => ({ quoteId: q.id, leadDays: this.leadDays(q) })),
      );
      for (const d of deliveries) {
        await this.persist(quotes, d.quoteId, deliveryCrit, d.score, actorId);
      }
    }
    for (const q of quotes) await this.recomputeWeighted(q.id);
    await this.audit.rfq('RFQ_AUTO_SCORED', rfqId, actorId, {
      quoteCount: quotes.length,
    });
    return { scored: quotes.length };
  }

  async evaluateQuote(
    quoteId: string,
    input: QuoteEvaluateInput,
    actorId: string,
  ): Promise<{ ok: true }> {
    const quote = await this.prisma.client.quote.findUnique({
      where: { id: quoteId },
      include: { rfq: true },
    });
    if (!quote) throw new NotFoundException('Quote not found');
    const criteria = this.criteria(quote.rfq);
    for (const score of input.scores) {
      const crit = criteria.find((c) => c.key === score.criterion);
      if (!crit) continue;
      await this.upsertEvaluation(
        quoteId,
        quote.tenantId,
        crit,
        new Decimal(score.rawScore).toFixed(2),
        actorId,
        score.notes ?? null,
      );
    }
    await this.recomputeWeighted(quoteId);
    await this.audit.quote('QUOTE_EVALUATION_RECORDED', quoteId, actorId, {
      criteria: input.scores.map((s) => s.criterion),
    });
    return { ok: true };
  }

  async getComparisonMatrix(
    rfqId: string,
    viewer: { isVendor: boolean },
  ): Promise<ComparisonMatrixResponse> {
    const rfq = await this.prisma.client.rfq.findUnique({
      where: { id: rfqId },
      include: { lines: true },
    });
    if (!rfq) throw new NotFoundException('RFQ not found');
    const criteria = this.criteria(rfq);
    // Commercial visible only once opened (Master Context sealed-quote invariant).
    const commercialOpen = [
      'COMMERCIAL_OPEN',
      'EVALUATION',
      'AWARD_PENDING',
      'AWARDED',
    ].includes(rfq.status);
    const masked = viewer.isVendor || !commercialOpen;

    const quotes = await this.evaluableQuotes(rfqId);
    const lineViews: RfqLineView[] = rfq.lines.map((l) => ({
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
    }));

    const rows: ComparisonRow[] = [];
    let idx = 0;
    // Rank by weighted total among quotes that have one.
    const ranked = [...quotes]
      .filter((q) => q.weightedScore != null)
      .sort((a, b) =>
        new Decimal(b.weightedScore!.toString()).comparedTo(a.weightedScore!.toString()),
      )
      .map((q, i) => [q.id, i + 1] as const);
    const rankById = new Map(ranked);

    for (const q of quotes) {
      const displayName = rfq.blindEvaluation
        ? `Vendor ${String.fromCharCode(65 + idx)}`
        : q.vendor.name;
      idx += 1;
      const pastSpend = await this.pastSpend(q.vendorId);
      const scores = criteria.map((c) => {
        const ev = q.evaluations.find((e) => e.criterion === c.key);
        return {
          criterion: c.key,
          weight: c.weight,
          rawScore:
            masked && c.key === 'price' ? null : (ev?.rawScore.toString() ?? null),
          weightedScore: ev?.weightedScore.toString() ?? null,
        };
      });
      const rank = rankById.get(q.id) ?? null;
      rows.push({
        quoteId: q.id,
        vendorId: rfq.blindEvaluation ? '' : q.vendorId,
        displayName,
        isMsme: q.vendor.isMsme,
        historicalOtif: q.vendor.historicalOtif?.toString() ?? null,
        historicalQuality: q.vendor.historicalQuality?.toString() ?? null,
        pastSpend: masked ? null : pastSpend,
        totalCommercialValue: masked
          ? null
          : (q.totalCommercialValue?.toString() ?? null),
        totalLandedInr: masked ? null : this.landedTotal(q),
        leadDays: this.leadDays(q) || null,
        specCompliance: this.worstCompliance(q),
        status: q.status,
        scores,
        weightedTotal: q.weightedScore?.toString() ?? null,
        rank,
        rankLabel: rank ? `L${rank}` : null,
      });
    }

    return {
      rfqId,
      masked,
      blindEvaluation: rfq.blindEvaluation,
      criteria,
      lines: lineViews,
      rows,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private criteria(rfq: { evaluationCriteria: Prisma.JsonValue }): EvaluationCriterion[] {
    return rfq.evaluationCriteria as unknown as EvaluationCriterion[];
  }

  private leadDays(q: EvaluableQuote): number {
    return q.lines.reduce((max, l) => Math.max(max, l.deliveryLeadDays), 0);
  }

  private worstCompliance(q: EvaluableQuote): 'FULL' | 'PARTIAL' | 'DEVIATION' | null {
    if (q.lines.length === 0) return null;
    if (q.lines.some((l) => l.specCompliance === 'DEVIATION')) return 'DEVIATION';
    if (q.lines.some((l) => l.specCompliance === 'PARTIAL')) return 'PARTIAL';
    return 'FULL';
  }

  private landedTotal(q: EvaluableQuote): string | null {
    if (q.lines.some((l) => l.unitPriceInrLanded == null)) return null;
    const total = q.lines.reduce(
      (acc, l) =>
        acc.plus(
          new Decimal(l.unitPriceInrLanded!.toString()).times(l.qtyQuoted.toString()),
        ),
      new Decimal(0),
    );
    return total.toFixed(4);
  }

  private async evaluableQuotes(rfqId: string): Promise<EvaluableQuote[]> {
    return this.prisma.client.quote.findMany({
      where: { rfqId, status: { in: ['OPENED', 'QUALIFIED'] } },
      include: { lines: true, vendor: true, evaluations: true },
      orderBy: { submittedAt: 'asc' },
    });
  }

  private async persist(
    quotes: EvaluableQuote[],
    quoteId: string,
    crit: EvaluationCriterion,
    rawScore: string,
    actorId: string,
  ): Promise<void> {
    const q = quotes.find((x) => x.id === quoteId);
    if (!q) return;
    await this.upsertEvaluation(quoteId, q.tenantId, crit, rawScore, actorId, null);
  }

  private async upsertEvaluation(
    quoteId: string,
    tenantId: string,
    crit: EvaluationCriterion,
    rawScore: string,
    actorId: string,
    notes: string | null,
  ): Promise<void> {
    const weighted = new Decimal(rawScore).times(crit.weight).dividedBy(100).toFixed(2);
    await this.prisma.client.quoteEvaluation.upsert({
      where: { quoteId_criterion: { quoteId, criterion: crit.key } },
      create: {
        id: newId('quoteEvaluation'),
        tenantId,
        quoteId,
        evaluatorId: actorId,
        criterion: crit.key,
        weight: crit.weight,
        rawScore: new Prisma.Decimal(rawScore),
        weightedScore: new Prisma.Decimal(weighted),
        notes,
      },
      update: {
        evaluatorId: actorId,
        rawScore: new Prisma.Decimal(rawScore),
        weightedScore: new Prisma.Decimal(weighted),
        notes,
        evaluatedAt: new Date(),
      },
    });
  }

  private async recomputeWeighted(quoteId: string): Promise<void> {
    const evals = await this.prisma.client.quoteEvaluation.findMany({
      where: { quoteId },
    });
    const total = weightedTotal(
      evals.map((e) => ({
        criterion: e.criterion,
        weight: e.weight,
        rawScore: e.rawScore.toString(),
      })),
    );
    await this.prisma.client.quote.update({
      where: { id: quoteId },
      data: { weightedScore: new Prisma.Decimal(total) },
    });
  }

  private async pastSpend(vendorId: string): Promise<string> {
    const rows = await this.prisma.client.purchaseOrder.findMany({
      where: { vendorId, status: { in: ['ISSUED', 'RECEIVED', 'INVOICED', 'CLOSED'] } },
      select: { totalAmount: true },
    });
    const total = rows.reduce(
      (acc, r) => acc.plus(r.totalAmount.toString()),
      new Decimal(0),
    );
    return total.toFixed(2);
  }

  private async requireCommercialOpen(
    rfqId: string,
  ): Promise<Prisma.RfqGetPayload<Record<string, never>>> {
    const rfq = await this.prisma.client.rfq.findUnique({ where: { id: rfqId } });
    if (!rfq) throw new NotFoundException('RFQ not found');
    if (!['COMMERCIAL_OPEN', 'EVALUATION'].includes(rfq.status)) {
      throw new SourcingStateError(
        'Auto-score requires the commercial envelope to be open.',
        {
          status: rfq.status,
        },
      );
    }
    return rfq;
  }
}
