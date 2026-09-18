import { Injectable } from '@nestjs/common';
import {
  monthKey,
  resolvePeriod,
  type AnalyticsPeriodQuery,
  type ApPerformanceResponse,
  type ExceptionTypeRate,
} from '@procureflow/shared';

import { PrismaService } from '../prisma/prisma.service';

const APPROVED_STATUSES = ['APPROVED', 'SCHEDULED', 'PARTIALLY_PAID', 'PAID'];

interface MonthAcc {
  total: number;
  approved: number;
  firstPass: number;
  straightThrough: number;
  cycleSumWithExc: number;
  cycleCountWithExc: number;
  cycleSumClean: number;
  cycleCountClean: number;
}

/**
 * ApPerformanceService (Slice 8). Cycle time, first-pass yield, exception rate,
 * straight-through rate — computed LIVE from Slice 1 invoice/exception/approval
 * data. First-pass yield counts invoices with ZERO exceptions EVER raised (not
 * zero currently-open), and straight-through means no human approval decision.
 */
@Injectable()
export class ApPerformanceService {
  constructor(private readonly prisma: PrismaService) {}

  async getPerformance(q: AnalyticsPeriodQuery): Promise<ApPerformanceResponse> {
    const p = resolvePeriod(q, new Date());
    const invoices = await this.prisma.client.invoice.findMany({
      where: { receivedAt: { gte: p.start, lt: p.end } },
      select: {
        id: true,
        status: true,
        receivedAt: true,
        paidAt: true,
        updatedAt: true,
        exceptions: { select: { exceptionType: true } },
      },
    });
    const ids = invoices.map((i) => i.id);
    const approvals = ids.length
      ? await this.prisma.client.approval.findMany({
          where: {
            documentType: 'INVOICE',
            documentId: { in: ids },
            decision: 'APPROVED',
          },
          select: { documentId: true, decidedAt: true },
        })
      : [];
    const approvalEnd = new Map<string, Date>();
    for (const a of approvals) {
      if (!a.decidedAt) continue;
      const cur = approvalEnd.get(a.documentId);
      if (!cur || a.decidedAt > cur) approvalEnd.set(a.documentId, a.decidedAt);
    }

    const months = new Map<string, MonthAcc>();
    const excCounts = new Map<string, number>();
    let total = 0;
    let approvedTotal = 0;
    let firstPass = 0;
    let withException = 0;
    let straightThrough = 0;
    let cycleSumWithExc = 0;
    let cycleCountWithExc = 0;
    let cycleSumClean = 0;
    let cycleCountClean = 0;

    for (const inv of invoices) {
      total += 1;
      const m = monthKey(inv.receivedAt);
      const acc = months.get(m) ?? {
        total: 0,
        approved: 0,
        firstPass: 0,
        straightThrough: 0,
        cycleSumWithExc: 0,
        cycleCountWithExc: 0,
        cycleSumClean: 0,
        cycleCountClean: 0,
      };
      acc.total += 1;

      const hadException = inv.exceptions.length > 0;
      if (hadException) {
        withException += 1;
        for (const e of inv.exceptions) {
          excCounts.set(e.exceptionType, (excCounts.get(e.exceptionType) ?? 0) + 1);
        }
      }
      const approved = APPROVED_STATUSES.includes(inv.status);
      const hasApproval = approvalEnd.has(inv.id);
      if (approved) {
        approvedTotal += 1;
        acc.approved += 1;
        if (!hadException) {
          firstPass += 1;
          acc.firstPass += 1;
          if (!hasApproval) {
            straightThrough += 1;
            acc.straightThrough += 1;
          }
        }
        const end = approvalEnd.get(inv.id) ?? inv.paidAt ?? inv.updatedAt;
        const days = (end.getTime() - inv.receivedAt.getTime()) / 86_400_000;
        if (days >= 0) {
          if (hadException) {
            cycleSumWithExc += days;
            cycleCountWithExc += 1;
            acc.cycleSumWithExc += days;
            acc.cycleCountWithExc += 1;
          } else {
            cycleSumClean += days;
            cycleCountClean += 1;
            acc.cycleSumClean += days;
            acc.cycleCountClean += 1;
          }
        }
      }
      months.set(m, acc);
    }

    const cycleCount = cycleCountWithExc + cycleCountClean;
    const round1 = (n: number): number => Math.round(n * 10) / 10;
    const pct = (num: number, den: number): number =>
      den > 0 ? Math.round((num / den) * 1000) / 10 : 0;

    const exceptionBreakdown: ExceptionTypeRate[] = [...excCounts.entries()]
      .map(([exceptionType, count]) => ({
        exceptionType,
        count,
        pct: pct(count, withException),
      }))
      .sort((a, b) => b.count - a.count);

    const sortedMonths = [...months.keys()].sort();
    const cycleTrend = sortedMonths.map((m) => {
      const a = months.get(m)!;
      return {
        month: m,
        withException:
          a.cycleCountWithExc > 0 ? round1(a.cycleSumWithExc / a.cycleCountWithExc) : 0,
        cleanMatch:
          a.cycleCountClean > 0 ? round1(a.cycleSumClean / a.cycleCountClean) : 0,
      };
    });
    const fpyTrend = sortedMonths.map((m) => {
      const a = months.get(m)!;
      return { month: m, pct: pct(a.firstPass, a.approved) };
    });
    const stpTrend = sortedMonths.map((m) => {
      const a = months.get(m)!;
      return { month: m, pct: pct(a.straightThrough, a.total) };
    });

    // Discount capture: honest null until any tenant uses early-payment discount terms.
    const discountTerms = await this.prisma.client.$queryRawUnsafe<{ cnt: number }[]>(
      `SELECT COUNT(*)::int AS cnt FROM "PurchaseOrder"
       WHERE (payment_terms_snapshot ->> 'earlyPaymentDiscountPct') IS NOT NULL
         AND (payment_terms_snapshot ->> 'earlyPaymentDiscountPct')::numeric > 0`,
    );

    return {
      avgCycleDays:
        cycleCount > 0 ? round1((cycleSumWithExc + cycleSumClean) / cycleCount) : 0,
      avgCycleDaysWithException:
        cycleCountWithExc > 0 ? round1(cycleSumWithExc / cycleCountWithExc) : 0,
      avgCycleDaysCleanMatch:
        cycleCountClean > 0 ? round1(cycleSumClean / cycleCountClean) : 0,
      firstPassYieldPct: pct(firstPass, approvedTotal),
      exceptionRatePct: pct(withException, total),
      straightThroughPct: pct(straightThrough, total),
      discountCapturePct: (discountTerms[0]?.cnt ?? 0) > 0 ? 0 : null,
      invoicesTotal: total,
      exceptionBreakdown,
      cycleTrend,
      fpyTrend,
      stpTrend,
      refreshedAt: null, // computed live
    };
  }
}
