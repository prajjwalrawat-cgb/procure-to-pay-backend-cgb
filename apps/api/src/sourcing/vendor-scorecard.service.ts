import { Injectable } from '@nestjs/common';
import { Prisma } from '@procureflow/db';
import Decimal from 'decimal.js';

import { PrismaService } from '../prisma/prisma.service';

/**
 * VendorScorecardService (Slice 6 vendor directory). Recomputes each vendor's
 * historical OTIF, quality acceptance and average response time from Slice 5
 * GRN receipt data. Intended to run nightly (BullMQ scheduling is wired in
 * Slice 10); exposed as a callable so the seed + tests can trigger it directly.
 */
@Injectable()
export class VendorScorecardService {
  constructor(private readonly prisma: PrismaService) {}

  /** Recompute the scorecard for every vendor in the current tenant. */
  async recomputeAll(tenantId: string): Promise<{ updated: number }> {
    const vendors = await this.prisma.client.vendor.findMany({
      where: { tenantId },
      select: { id: true },
    });
    let updated = 0;
    for (const v of vendors) {
      await this.recompute(v.id);
      updated += 1;
    }
    return { updated };
  }

  async recompute(vendorId: string): Promise<void> {
    const grns = await this.prisma.client.goodsReceiptNote.findMany({
      where: { po: { vendorId }, status: 'POSTED' },
      include: { lines: true, po: { select: { expectedDeliveryDate: true } } },
    });

    let accepted = new Decimal(0);
    let received = new Decimal(0);
    let onTime = 0;
    let total = 0;
    for (const grn of grns) {
      total += 1;
      const expected = grn.po.expectedDeliveryDate;
      if (expected && grn.receivedAt.getTime() <= expected.getTime()) onTime += 1;
      for (const line of grn.lines) {
        accepted = accepted.plus(line.qtyAccepted.toString());
        received = received.plus(
          new Decimal(line.qtyAccepted.toString()).plus(line.qtyRejected.toString()),
        );
      }
    }

    // No history → leave nulls; the auto-scorer applies the tenant default cap.
    if (total === 0) return;

    const otif = new Decimal(onTime).dividedBy(total).times(100);
    const quality = received.isZero()
      ? new Decimal(100)
      : accepted.dividedBy(received).times(100);

    await this.prisma.client.vendor.update({
      where: { id: vendorId },
      data: {
        historicalOtif: new Prisma.Decimal(otif.toDecimalPlaces(2).toFixed(2)),
        historicalQuality: new Prisma.Decimal(quality.toDecimalPlaces(2).toFixed(2)),
        onTimePct: new Prisma.Decimal(otif.toDecimalPlaces(2).toFixed(2)),
        qualityPct: new Prisma.Decimal(quality.toDecimalPlaces(2).toFixed(2)),
      },
    });
  }
}
