import { Injectable } from '@nestjs/common';
import {
  resolvePeriod,
  priorYearRange,
  type AnalyticsPeriodQuery,
  type ConcentrationResponse,
  type ContractCoverageResponse,
  type SpendByCategoryResponse,
  type SpendTrendResponse,
  type TopVendorsQuery,
  type TopVendorsResponse,
  type TopVendorRow,
  type TotalSpendResponse,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { PrismaService } from '../prisma/prisma.service';

interface CategoryRow {
  category: string;
  net: string;
}
interface VendorAgg {
  vendorId: string;
  vendorName: string;
  isMsme: boolean;
  net: Decimal;
  txn: number;
}

/**
 * SpendAnalyticsService (Slice 8). Reads the RLS-protected summary tables
 * (spend/vendor monthly) for headline spend, trend, top vendors and
 * concentration; category breakdown is a live PO-line query (invoices carry no
 * category). Contract coverage is an honest 0% until Slice 9 ships.
 */
@Injectable()
export class SpendAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  private async refreshedAt(view: string): Promise<string | null> {
    const log = await this.prisma.client.analyticsRefreshLog.findFirst({
      where: { viewName: view },
    });
    return log?.refreshedAt.toISOString() ?? null;
  }

  async getTotalSpend(q: AnalyticsPeriodQuery): Promise<TotalSpendResponse> {
    const p = resolvePeriod(q, new Date());
    const rows = await this.prisma.client.analyticsSpendMonthly.findMany({
      where: { month: { in: p.months } },
    });
    const gross = rows.reduce((s, r) => s.plus(r.grossSpend.toString()), new Decimal(0));
    const tax = rows.reduce((s, r) => s.plus(r.taxSpend.toString()), new Decimal(0));
    const net = rows.reduce((s, r) => s.plus(r.netSpend.toString()), new Decimal(0));
    const txn = rows.reduce((s, r) => s + r.txnCount, 0);
    return {
      grossSpend: gross.toFixed(4),
      taxSpend: tax.toFixed(4),
      netSpend: net.toFixed(4),
      transactionCount: txn,
      periodLabel: q.period,
      refreshedAt: await this.refreshedAt('spend_monthly'),
    };
  }

  async getSpendTrend(q: AnalyticsPeriodQuery): Promise<SpendTrendResponse> {
    const p = resolvePeriod(q, new Date());
    const cur = await this.prisma.client.analyticsSpendMonthly.findMany({
      where: { month: { in: p.months } },
    });
    const curByMonth = new Map(cur.map((r) => [r.month, r.netSpend.toString()]));
    const compare = q.compareToLastYear ?? false;
    const prior = priorYearRange(p);
    const priorRows = compare
      ? await this.prisma.client.analyticsSpendMonthly.findMany({
          where: { month: { in: prior.months } },
        })
      : [];
    const priorByMonth = new Map(priorRows.map((r) => [r.month, r.netSpend.toString()]));
    const points = p.months.map((m, i) => ({
      month: m,
      netSpend: curByMonth.get(m) ?? '0',
      priorYearNetSpend: compare ? (priorByMonth.get(prior.months[i]) ?? '0') : null,
    }));
    return {
      points,
      comparedToLastYear: compare,
      refreshedAt: await this.refreshedAt('spend_monthly'),
    };
  }

  async getSpendByCategory(q: AnalyticsPeriodQuery): Promise<SpendByCategoryResponse> {
    const p = resolvePeriod(q, new Date());
    const rows = await this.prisma.client.$queryRawUnsafe<CategoryRow[]>(
      `SELECT COALESCE(rl.category, 'Uncategorised') AS category,
              COALESCE(SUM(pol.line_total),0)::text AS net
       FROM "PurchaseOrderLine" pol
       JOIN "PurchaseOrder" po ON po.id = pol.po_id
       LEFT JOIN "RequisitionLine" rl ON rl.id = pol.pr_line_id
       WHERE po."issuedAt" IS NOT NULL AND po."issuedAt" >= $1::timestamptz AND po."issuedAt" < $2::timestamptz
       GROUP BY 1
       ORDER BY 2 DESC`,
      p.start.toISOString(),
      p.end.toISOString(),
    );
    const total = rows.reduce((s, r) => s.plus(r.net), new Decimal(0));
    const slices = rows.map((r) => ({
      category: r.category,
      netSpend: new Decimal(r.net).toFixed(4),
      pct: total.gt(0) ? new Decimal(r.net).div(total).times(100).toDP(2).toNumber() : 0,
    }));
    return {
      slices,
      totalNetSpend: total.toFixed(4),
      basis: 'PO_LINE',
      refreshedAt: await this.refreshedAt('spend_monthly'),
    };
  }

  /** Aggregate vendor spend over the period from the vendor-monthly summary. */
  private async vendorAggregates(months: string[]): Promise<VendorAgg[]> {
    const rows = await this.prisma.client.analyticsVendorMonthly.findMany({
      where: { month: { in: months } },
    });
    const byVendor = new Map<string, VendorAgg>();
    for (const r of rows) {
      const cur = byVendor.get(r.vendorId) ?? {
        vendorId: r.vendorId,
        vendorName: '',
        isMsme: false,
        net: new Decimal(0),
        txn: 0,
      };
      cur.net = cur.net.plus(r.netSpend.toString());
      cur.txn += r.txnCount;
      byVendor.set(r.vendorId, cur);
    }
    const ids = [...byVendor.keys()];
    if (ids.length) {
      const vendors = await this.prisma.client.vendor.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, isMsme: true },
      });
      for (const v of vendors) {
        const agg = byVendor.get(v.id);
        if (agg) {
          agg.vendorName = v.name;
          agg.isMsme = v.isMsme;
        }
      }
    }
    return [...byVendor.values()].sort((a, b) => b.net.comparedTo(a.net));
  }

  private async savingsByVendor(): Promise<Map<string, Decimal>> {
    const entries = await this.prisma.client.savingsLedgerEntry.findMany({
      where: { status: 'CONFIRMED' },
      select: { vendorId: true, savingsAmount: true },
    });
    const m = new Map<string, Decimal>();
    for (const e of entries) {
      if (!e.vendorId) continue;
      m.set(
        e.vendorId,
        (m.get(e.vendorId) ?? new Decimal(0)).plus(e.savingsAmount.toString()),
      );
    }
    return m;
  }

  async getTopVendors(q: TopVendorsQuery): Promise<TopVendorsResponse> {
    const p = resolvePeriod(q, new Date());
    const aggs = await this.vendorAggregates(p.months);
    const savings = await this.savingsByVendor();
    const total = aggs.reduce((s, a) => s.plus(a.net), new Decimal(0));
    const rows: TopVendorRow[] = aggs.map((a) => ({
      vendorId: a.vendorId,
      vendorName: a.vendorName,
      isMsme: a.isMsme,
      netSpend: a.net.toFixed(4),
      transactionCount: a.txn,
      savingsAmount: (savings.get(a.vendorId) ?? new Decimal(0)).toFixed(4),
      pctOfTotal: total.gt(0) ? a.net.div(total).times(100).toDP(2).toNumber() : 0,
    }));
    const sorted = [...rows].sort((x, y) => {
      if (q.sortBy === 'volume') return y.transactionCount - x.transactionCount;
      if (q.sortBy === 'savings')
        return new Decimal(y.savingsAmount).comparedTo(x.savingsAmount);
      return new Decimal(y.netSpend).comparedTo(x.netSpend);
    });
    return {
      vendors: sorted.slice(0, q.n),
      totalNetSpend: total.toFixed(4),
      sortBy: q.sortBy,
      refreshedAt: await this.refreshedAt('vendor_monthly'),
    };
  }

  async getConcentrationRisk(q: AnalyticsPeriodQuery): Promise<ConcentrationResponse> {
    const p = resolvePeriod(q, new Date());
    const aggs = await this.vendorAggregates(p.months);
    const total = aggs.reduce((s, a) => s.plus(a.net), new Decimal(0));
    const top10 = aggs.slice(0, 10);
    const top10Net = top10.reduce((s, a) => s.plus(a.net), new Decimal(0));
    const concentrationPct = total.gt(0)
      ? top10Net.div(total).times(100).toDP(2).toNumber()
      : 0;

    // Prior period (same span, shifted back one period length) for the trend arrow.
    const prior = priorYearRange(p);
    const priorAggs = await this.vendorAggregates(prior.months);
    const priorTotal = priorAggs.reduce((s, a) => s.plus(a.net), new Decimal(0));
    const priorTop10 = priorAggs
      .slice(0, 10)
      .reduce((s, a) => s.plus(a.net), new Decimal(0));
    const priorPct = priorTotal.gt(0)
      ? priorTop10.div(priorTotal).times(100).toDP(2).toNumber()
      : null;

    const savings = await this.savingsByVendor();
    const vendors: TopVendorRow[] = top10.map((a) => ({
      vendorId: a.vendorId,
      vendorName: a.vendorName,
      isMsme: a.isMsme,
      netSpend: a.net.toFixed(4),
      transactionCount: a.txn,
      savingsAmount: (savings.get(a.vendorId) ?? new Decimal(0)).toFixed(4),
      pctOfTotal: total.gt(0) ? a.net.div(total).times(100).toDP(2).toNumber() : 0,
    }));
    return {
      topN: 10,
      concentrationPct,
      priorConcentrationPct: priorPct,
      totalNetSpend: total.toFixed(4),
      vendors,
      refreshedAt: await this.refreshedAt('vendor_monthly'),
    };
  }

  /** Contract coverage — honest 0% until the Slice 9 Contract model exists. */
  async getContractCoverage(q: AnalyticsPeriodQuery): Promise<ContractCoverageResponse> {
    const p = resolvePeriod(q, new Date());
    const total = await this.getTotalSpend(q);

    // Coverage = share of net spend going to vendors under a live contract
    // (Slice 9 — real data. This became non-zero the moment Slice 9's contracts
    // landed, with no change to the coverage KPI's callers or response shape).
    const contracts = await this.prisma.client.contract.findMany({
      where: {
        status: { in: ['ACTIVE', 'EXPIRING_SOON', 'AWAITING_VENDOR_SIGNATURE'] },
      },
      select: { vendorId: true },
    });
    const vendorIds = [...new Set(contracts.map((c) => c.vendorId))];

    let contracted = new Decimal(0);
    if (vendorIds.length > 0) {
      const rows = await this.prisma.client.analyticsVendorMonthly.findMany({
        where: { month: { in: p.months }, vendorId: { in: vendorIds } },
      });
      contracted = rows.reduce((s, r) => s.plus(r.netSpend.toString()), new Decimal(0));
    }

    const totalNet = new Decimal(total.netSpend);
    const pct = totalNet.greaterThan(0)
      ? contracted.dividedBy(totalNet).times(100).toDecimalPlaces(1).toNumber()
      : 0;

    return {
      totalSpend: total.netSpend,
      contractedSpend: contracted.toFixed(4),
      coveragePct: pct,
      note:
        vendorIds.length > 0
          ? `${vendorIds.length} vendor(s) under a live contract.`
          : 'No active contracts on file.',
      refreshedAt: total.refreshedAt,
    };
  }
}
