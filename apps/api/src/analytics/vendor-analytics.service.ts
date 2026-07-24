import { Injectable } from '@nestjs/common';
import type {
  CategoryPerformanceResponse,
  MsmeParticipationResponse,
  RiskDistributionResponse,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { PrismaService } from '../prisma/prisma.service';

/**
 * VendorAnalyticsService (Slice 8) — portfolio-level rollups over the Slice 7
 * vendor scorecards: category performance, risk-grade distribution, MSME
 * participation. All computed live from vendor + scorecard + spend data.
 */
@Injectable()
export class VendorAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getCategoryPerformance(): Promise<CategoryPerformanceResponse> {
    const scorecards = await this.prisma.client.vendorScorecard.findMany({
      where: { period: 'ROLLING_365D' },
      select: { vendorId: true, categoryKey: true, score: true },
    });
    const vendorSpend = await this.prisma.client.analyticsVendorMonthly.groupBy({
      by: ['vendorId'],
      _sum: { netSpend: true },
    });
    const spendByVendor = new Map(
      vendorSpend.map((v) => [
        v.vendorId,
        new Decimal(v._sum.netSpend?.toString() ?? '0'),
      ]),
    );
    const byCat = new Map<
      string,
      { scores: number[]; vendors: Set<string>; spend: Decimal }
    >();
    for (const s of scorecards) {
      const cat = s.categoryKey ?? 'Uncategorised';
      const acc = byCat.get(cat) ?? {
        scores: [],
        vendors: new Set(),
        spend: new Decimal(0),
      };
      if (s.score != null) acc.scores.push(Number(s.score));
      if (!acc.vendors.has(s.vendorId)) {
        acc.spend = acc.spend.plus(spendByVendor.get(s.vendorId) ?? new Decimal(0));
      }
      acc.vendors.add(s.vendorId);
      byCat.set(cat, acc);
    }
    const rows = [...byCat.entries()]
      .map(([category, a]) => ({
        category,
        vendorCount: a.vendors.size,
        avgScore: a.scores.length
          ? Math.round((a.scores.reduce((x, y) => x + y, 0) / a.scores.length) * 10) / 10
          : null,
        netSpend: a.spend.toFixed(4),
      }))
      .sort((x, y) => new Decimal(y.netSpend).comparedTo(x.netSpend));
    return { rows, refreshedAt: null };
  }

  async getRiskDistribution(): Promise<RiskDistributionResponse> {
    // Latest ALL_TIME scorecard grade per vendor.
    const scorecards = await this.prisma.client.vendorScorecard.findMany({
      where: { period: 'ROLLING_365D' },
      select: { vendorId: true, grade: true, computedAt: true },
      orderBy: { computedAt: 'desc' },
    });
    const latest = new Map<string, string>();
    for (const s of scorecards)
      if (!latest.has(s.vendorId)) latest.set(s.vendorId, s.grade);
    const counts = new Map<string, number>();
    for (const g of latest.values()) counts.set(g, (counts.get(g) ?? 0) + 1);
    const order = ['A+', 'A', 'B', 'C', 'D', 'N/A'];
    const distribution = order
      .filter((g) => counts.has(g))
      .map((grade) => ({ grade, count: counts.get(grade)! }));
    return { distribution, totalVendors: latest.size, refreshedAt: null };
  }

  async getMsmeParticipation(): Promise<MsmeParticipationResponse> {
    const [total, msme] = await Promise.all([
      this.prisma.client.vendor.count(),
      this.prisma.client.vendor.count({ where: { isMsme: true } }),
    ]);
    const spend = await this.prisma.client.$queryRawUnsafe<
      { msme: string; total: string }[]
    >(
      `SELECT COALESCE(SUM(net_spend) FILTER (WHERE v."isMsme"),0)::text AS msme,
              COALESCE(SUM(net_spend),0)::text AS total
       FROM "AnalyticsVendorMonthly" avm JOIN "Vendor" v ON v.id = avm.vendor_id`,
    );
    const msmeSpend = new Decimal(spend[0]?.msme ?? '0');
    const totalSpend = new Decimal(spend[0]?.total ?? '0');

    // RFQ participation: distinct MSME vendors who submitted a quote / invited.
    const invited = await this.prisma.client.$queryRawUnsafe<{ cnt: number }[]>(
      `SELECT COUNT(DISTINCT ri.vendor_id)::int AS cnt
       FROM "RfqInvitation" ri JOIN "Vendor" v ON v.id = ri.vendor_id AND v."isMsme"`,
    );
    const participated = await this.prisma.client.$queryRawUnsafe<{ cnt: number }[]>(
      `SELECT COUNT(DISTINCT q.vendor_id)::int AS cnt
       FROM "Quote" q JOIN "Vendor" v ON v.id = q.vendor_id AND v."isMsme"
       WHERE q."submittedAt" IS NOT NULL`,
    );
    const inv = invited[0]?.cnt ?? 0;
    const part = participated[0]?.cnt ?? 0;
    return {
      msmeSpendPct: totalSpend.gt(0)
        ? msmeSpend.div(totalSpend).times(100).toDP(2).toNumber()
        : 0,
      msmeVendorCount: msme,
      totalVendorCount: total,
      msmeRfqParticipationPct: inv > 0 ? Math.round((part / inv) * 1000) / 10 : 0,
      refreshedAt: null,
    };
  }
}
