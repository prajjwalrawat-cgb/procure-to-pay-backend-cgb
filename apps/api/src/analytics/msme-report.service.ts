import { Injectable } from '@nestjs/common';
import type { MsmeBucketKey } from '@procureflow/shared';
import PDFDocument from 'pdfkit';

import { PrismaService } from '../prisma/prisma.service';
import { MsmeComplianceService } from './msme-compliance.service';

const BUCKET_LABEL: Record<MsmeBucketKey, string> = {
  SAFE_0_29: 'Safe (0–29 days)',
  APPROACHING_30_44: 'Approaching (30–44 days)',
  BREACH_45_PLUS: 'Breach (45+ days)',
};

/**
 * MsmeReportService (Slice 8). Renders the MSME §15 compliance report as a real
 * application/pdf via pdfkit (no Chromium — same approach as ADR-010). This is
 * the artefact finance hands to a statutory auditor.
 */
@Injectable()
export class MsmeReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly msme: MsmeComplianceService,
  ) {}

  async buildReport(tenantName: string): Promise<Buffer> {
    const dashboard = await this.msme.getAgingDashboard();
    const approaching = await this.msme.getExposureDetail('APPROACHING_30_44');
    const breach = await this.msme.getExposureDetail('BREACH_45_PLUS');

    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
    const left = doc.page.margins.left;
    const inr = (v: string): string => `INR ${Number(v).toLocaleString('en-IN')}`;

    doc
      .font('Helvetica-Bold')
      .fontSize(18)
      .fillColor('#0A0A0A')
      .text('MSME §15 compliance report');
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#78786F')
      .text(`${tenantName} · MSMED Act 2006, Section 15 (45-day payment rule)`)
      .text(
        `Generated ${new Date().toISOString()} · as of ${dashboard.asOfDate.slice(0, 10)}`,
      )
      .text(
        `Interest exposure = net amount × RBI reference rate (${breach.rbiReferenceRatePct}%) × 3 × days late / 365`,
      );
    doc.moveDown(0.8);

    // Bucket summary
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#0A0A0A').text('Aging summary');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9).fillColor('#2E2E2C');
    for (const b of dashboard.buckets) {
      doc.text(
        `${BUCKET_LABEL[b.bucket]}:  ${b.invoiceCount} invoice(s)  ·  exposure ${inr(b.totalExposure)}  ·  avg ${b.avgDays} days`,
      );
    }
    doc.moveDown(0.3);
    doc.text(
      `MSME spend: ${inr(dashboard.msmeSpendNet)} of ${inr(dashboard.totalSpendNet)} total (${dashboard.msmeSpendPct}%)`,
    );
    doc.moveDown(0.8);

    const section = (
      title: string,
      rows: {
        invoiceNumber: string;
        vendorName: string;
        daysOutstanding: number;
        netAmount: string;
        interestIfBreached: string;
      }[],
      totalExposure: string,
      totalInterest: string,
    ): void => {
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#0A0A0A').text(title);
      doc.moveDown(0.3);
      const cols = [
        { label: 'Invoice', w: 110 },
        { label: 'Vendor', w: 150 },
        { label: 'Days', w: 45 },
        { label: 'Net', w: 105 },
        { label: 'Interest if unpaid', w: 105 },
      ];
      const drawHeader = (y: number): number => {
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#78786F');
        let x = left;
        for (const c of cols) {
          doc.text(c.label.toUpperCase(), x, y, { width: c.w });
          x += c.w;
        }
        doc
          .moveTo(left, y + 12)
          .lineTo(left + 515, y + 12)
          .strokeColor('#E8E8E1')
          .stroke();
        return y + 18;
      };
      let y = drawHeader(doc.y);
      const bottom = doc.page.height - doc.page.margins.bottom - 40;
      doc.font('Helvetica').fontSize(8).fillColor('#0A0A0A');
      if (rows.length === 0) {
        doc.text('No invoices in this bucket.', left, y);
        y += 14;
      }
      for (const r of rows) {
        if (y > bottom) {
          doc.addPage();
          y = drawHeader(doc.page.margins.top);
          doc.font('Helvetica').fontSize(8).fillColor('#0A0A0A');
        }
        const cells = [
          r.invoiceNumber,
          r.vendorName,
          String(r.daysOutstanding),
          inr(r.netAmount),
          inr(r.interestIfBreached),
        ];
        let x = left;
        cols.forEach((c, i) => {
          doc.text(cells[i], x, y, {
            width: c.w - 4,
            height: 10,
            ellipsis: true,
            lineBreak: false,
          });
          x += c.w;
        });
        y += 13;
      }
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#0A0A0A');
      doc.text(
        `Total exposure ${inr(totalExposure)} · total interest if unpaid ${inr(totalInterest)}`,
        left,
        y + 4,
      );
      doc.moveDown(1.2);
    };

    section('Breach (45+ days)', breach.rows, breach.totalExposure, breach.totalInterest);
    section(
      'Approaching (30–44 days)',
      approaching.rows,
      approaching.totalExposure,
      approaching.totalInterest,
    );

    doc.end();
    return done;
  }
}
