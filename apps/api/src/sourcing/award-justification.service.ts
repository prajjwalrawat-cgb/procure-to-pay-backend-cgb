import { createHash } from 'node:crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import PDFDocument from 'pdfkit';

import { PrismaService } from '../prisma/prisma.service';

export interface GeneratedJustification {
  buffer: Buffer;
  hash: string;
}

/** Fixed date so the golden justification PDF is byte-reproducible. */
const GOLDEN_DATE = new Date('2026-07-14T00:00:00.000Z');

/**
 * Award justification PDF (Slice 6 §10). Renders the full comparison matrix,
 * every opened quote, the scoring rationale and the variance-from-L1
 * justification into a real binary PDF whose sha256 is recorded on the Award —
 * the artefact Star Cement hands to internal audit / SEBI compliance.
 */
@Injectable()
export class AwardJustificationService {
  constructor(private readonly prisma: PrismaService) {}

  async generate(awardId: string): Promise<GeneratedJustification> {
    const award = await this.prisma.client.award.findUnique({
      where: { id: awardId },
      include: {
        rfq: { include: { lines: true } },
        allocations: { include: { vendor: { select: { name: true } } } },
      },
    });
    if (!award) throw new NotFoundException('Award not found');
    const quotes = await this.prisma.client.quote.findMany({
      where: {
        rfqId: award.rfqId,
        status: { in: ['QUALIFIED', 'OPENED', 'DISQUALIFIED_TECH'] },
      },
      include: {
        vendor: { select: { name: true, isMsme: true } },
        evaluations: true,
        lines: true,
      },
      orderBy: { weightedScore: 'desc' },
    });

    const buffer = await this.render(award, quotes);
    const hash = createHash('sha256').update(buffer).digest('hex');
    await this.prisma.client.award.update({
      where: { id: awardId },
      data: { justificationHash: hash },
    });
    return { buffer, hash };
  }

  private render(
    award: NonNullable<Awaited<ReturnType<AwardJustificationService['loadAward']>>>,
    quotes: Awaited<ReturnType<AwardJustificationService['loadQuotes']>>,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        margin: 48,
        size: 'A4',
        info: { CreationDate: GOLDEN_DATE },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(16).text('Award Justification Report', { align: 'left' });
      doc.moveDown(0.3);
      doc
        .fontSize(10)
        .fillColor('#555')
        .text(`RFQ ${award.rfq.number} — ${award.rfq.title}`);
      doc.text(`Category: ${award.rfq.category}   Type: ${award.rfq.rfqType}`);
      doc.text(`Estimated value: INR ${award.rfq.estimatedValue.toString()}`);
      doc.fillColor('#000').moveDown(0.8);

      doc.fontSize(12).text('Comparison matrix');
      doc.moveDown(0.3).fontSize(9);
      for (const q of quotes) {
        const scores = q.evaluations
          .map((e) => `${e.criterion}:${e.rawScore.toString()}`)
          .join('  ');
        doc.text(
          `${q.vendor.name}${q.vendor.isMsme ? ' (MSME)' : ''} — total INR ${
            q.totalCommercialValue?.toString() ?? 'n/a'
          }, weighted ${q.weightedScore?.toString() ?? 'n/a'}, status ${q.status}`,
        );
        if (scores) doc.fillColor('#555').text(`   scores: ${scores}`).fillColor('#000');
      }
      doc.moveDown(0.6);

      doc.fontSize(12).text('Award allocation');
      doc.moveDown(0.3).fontSize(9);
      for (const a of award.allocations) {
        doc.text(
          `${a.vendor.name}: qty ${a.qtyAllocated.toString()} @ INR ${a.unitPrice.toString()} = INR ${a.totalValue.toString()} (PO ${a.poId ?? 'pending'})`,
        );
      }
      doc.moveDown(0.6);

      if (award.varianceFromL1Reason) {
        doc.fontSize(12).text('Variance-from-L1 justification');
        doc.moveDown(0.3).fontSize(9).text(award.varianceFromL1Reason, { align: 'left' });
        doc.moveDown(0.6);
      }
      if (award.recommendationNotes) {
        doc.fontSize(12).text('Recommendation notes');
        doc.moveDown(0.3).fontSize(9).text(award.recommendationNotes);
      }
      doc.end();
    });
  }

  // Typing helpers for render() signatures.
  private loadAward(awardId: string) {
    return this.prisma.client.award.findUnique({
      where: { id: awardId },
      include: {
        rfq: { include: { lines: true } },
        allocations: { include: { vendor: { select: { name: true } } } },
      },
    });
  }

  private loadQuotes(rfqId: string) {
    return this.prisma.client.quote.findMany({
      where: { rfqId },
      include: {
        vendor: { select: { name: true, isMsme: true } },
        evaluations: true,
        lines: true,
      },
    });
  }
}
