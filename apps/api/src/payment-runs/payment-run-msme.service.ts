import { Injectable } from '@nestjs/common';
import type { MsmeAtRiskInvoice, MsmeAuditResult } from '@procureflow/shared';

import { MsmeService } from '../invoices/domain/msme.service';
import { PrismaService } from '../prisma/prisma.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Invoices at/after this age (days since invoice date) are flagged. */
const AGE_THRESHOLD_DAYS = 40;

/**
 * MSME Section 15 pre-submission audit (Slice 3). Every MSME invoice at day 40+
 * should be in the run OR have a documented reason for exclusion (`held`). Any
 * that are neither surface as "MSME risk before submitting".
 *
 * Kept separate from the pure `MsmeService` (which has no DB dependency) but
 * reuses its clock helpers.
 */
@Injectable()
export class PaymentRunMsmeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly msme: MsmeService,
  ) {}

  async runMsmeAudit(runId: string, now = new Date()): Promise<MsmeAuditResult> {
    const candidates = await this.prisma.client.invoice.findMany({
      where: {
        vendor: { isMsme: true },
        status: { in: ['APPROVED', 'SCHEDULED', 'HELD'] },
      },
      include: { vendor: { select: { name: true } } },
    });

    const inRunIds = new Set(
      (
        await this.prisma.client.paymentRunItem.findMany({
          where: { paymentRunId: runId },
          select: { invoiceId: true },
        })
      ).map((i) => i.invoiceId),
    );

    const atRisk: MsmeAtRiskInvoice[] = [];
    let checkedCount = 0;

    for (const inv of candidates) {
      const ageDays = Math.floor(
        (now.getTime() - inv.invoiceDate.getTime()) / MS_PER_DAY,
      );
      if (ageDays < AGE_THRESHOLD_DAYS) continue;
      checkedCount += 1;

      const inRun = inRunIds.has(inv.id);
      const excludedReason = inv.status === 'HELD' ? 'held' : null;
      if (inRun || excludedReason) continue;

      atRisk.push({
        invoiceId: inv.id,
        number: inv.number,
        vendorName: inv.vendor.name,
        daysRemaining: this.msme.daysRemaining(inv.msmeDueDate, now) ?? 0,
        dueDate: inv.msmeDueDate?.toISOString() ?? '',
        inRun: false,
        excludedReason: null,
      });
    }

    return { atRisk, checkedCount };
  }
}
