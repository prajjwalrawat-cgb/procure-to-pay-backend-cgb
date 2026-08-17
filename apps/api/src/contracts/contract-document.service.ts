import { createHash } from 'node:crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import {
  CLAUSE_TYPE_LABEL,
  CONTRACT_TYPE_LABEL,
  type PaymentTerms,
} from '@procureflow/shared';
import Decimal from 'decimal.js';
import PDFDocument from 'pdfkit';

import { PrismaService } from '../prisma/prisma.service';
import { defaultPlantQuery } from '../common/plants/default-plant';

export interface GeneratedContract {
  buffer: Buffer;
  hash: string;
}

/** Fixed creation date so golden-PDF regression tests are byte-stable. */
const GOLDEN_DATE = new Date('2026-07-14T00:00:00.000Z');

/**
 * ContractDocumentService (Slice 9). Renders the executed contract PDF with
 * pdfkit — the repo's standard pure-JS engine (no Chromium; ADR-010). Layout:
 * header → parties → recitals → clauses (mandatory first, then custom, in order)
 * → rate-card annexure (multi-year tables) → signature blocks. Returns bytes +
 * a sha256 hash recorded on the contract at execution time.
 */
@Injectable()
export class ContractDocumentService {
  constructor(private readonly prisma: PrismaService) {}

  async generate(
    contractId: string,
    opts: { watermark?: string; deterministic?: boolean } = {},
  ): Promise<GeneratedContract> {
    const contract = await this.load(contractId);
    if (!contract) throw new NotFoundException('Contract not found');
    // A GSTIN belongs to a state registration, so the letterhead takes it from
    // the tenant's default branch.
    const branch = await this.prisma.client.plant.findFirst(
      defaultPlantQuery(contract.tenantId),
    );
    const buffer = await this.render(contract, { ...opts, branchGstin: branch?.gstin ?? null });
    const hash = createHash('sha256').update(buffer).digest('hex');
    return { buffer, hash };
  }

  private render(
    c: NonNullable<Awaited<ReturnType<ContractDocumentService['load']>>>,
    opts: { watermark?: string; deterministic?: boolean; branchGstin?: string | null },
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 48,
        info: {
          Title: `Contract ${c.number}`,
          Author: c.tenant.name,
          ...(opts.deterministic ? { CreationDate: GOLDEN_DATE } : {}),
        },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (ch: Buffer) => chunks.push(ch));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const money = (v: string | Decimal): string => new Decimal(v.toString()).toFixed(2);
      const date = (d: Date): string => d.toISOString().slice(0, 10);
      const terms = c.paymentTermsSnapshot as unknown as PaymentTerms | null;

      // Header
      doc.fontSize(18).font('Helvetica-Bold').fillColor('#000').text(c.tenant.name);
      doc.fontSize(9).font('Helvetica').fillColor('#555');
      doc.text(`GSTIN: ${opts.branchGstin ?? '—'}`);
      doc.moveDown(0.5);
      doc
        .fillColor('#000')
        .fontSize(15)
        .font('Helvetica-Bold')
        .text(c.title.toUpperCase());
      doc.fontSize(10).font('Helvetica');
      doc.text(`${CONTRACT_TYPE_LABEL[c.contractType]} · ${c.number}`);
      doc.text(`Validity: ${date(c.validityStart)} to ${date(c.validityEnd)}`);
      doc.text(`Category: ${c.category}`);
      doc.moveDown(0.75);

      // Parties
      const topY = doc.y;
      doc.font('Helvetica-Bold').fontSize(10).text('Buyer', 48, topY);
      doc.font('Helvetica').fontSize(9);
      doc.text(c.tenant.name);
      doc.text(`GSTIN: ${opts.branchGstin ?? '—'}`);
      doc.font('Helvetica-Bold').fontSize(10).text('Vendor', 320, topY);
      doc.font('Helvetica').fontSize(9);
      doc.text(c.vendor.name, 320);
      doc.text(`GSTIN: ${c.vendor.gstin ?? '—'}`, 320);
      if (c.vendor.isMsme) doc.text(`MSME: ${c.vendor.udyamNumber ?? 'Yes'}`, 320);
      doc.moveDown(1.5);

      // Recitals
      doc.fillColor('#000').font('Helvetica-Bold').fontSize(11).text('1. Recitals');
      doc.font('Helvetica').fontSize(9).fillColor('#333');
      doc.text(
        `This ${CONTRACT_TYPE_LABEL[c.contractType]} is entered into between ${c.tenant.name} ` +
          `("Buyer") and ${c.vendor.name} ("Vendor") for the supply of ${c.category}. ` +
          `Purchase orders may be issued against this agreement (call-offs) at the locked ` +
          `rates set out in the Rate Card Annexure, without re-negotiation of pricing, ` +
          `for the duration of the validity period.`,
      );
      if (terms) {
        doc.moveDown(0.4);
        doc.text(
          `Payment terms: ${terms.label ?? terms.kind}${terms.days ? ` (${terms.days} days)` : ''}.`,
        );
      }
      if (c.minimumCommitmentValue || c.minimumCommitmentQty) {
        doc.text(
          `Minimum ${c.commitmentPeriod === 'ANNUAL' ? 'annual' : 'contract'} commitment: ` +
            `${c.minimumCommitmentQty ? `${c.minimumCommitmentQty} ${c.commitmentUom ?? ''}` : ''}` +
            `${c.minimumCommitmentValue ? ` / INR ${money(c.minimumCommitmentValue)}` : ''}.`,
        );
      }
      doc.moveDown(0.8);

      // Clauses — mandatory first, then by orderNo
      const clauses = [...c.clauses].sort(
        (a, b) => Number(b.isMandatory) - Number(a.isMandatory) || a.orderNo - b.orderNo,
      );
      doc
        .fillColor('#000')
        .font('Helvetica-Bold')
        .fontSize(11)
        .text('2. Terms & Clauses');
      doc.moveDown(0.3);
      clauses.forEach((cl, i) => {
        if (doc.y > 700) doc.addPage();
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#000');
        doc.text(`2.${i + 1} ${cl.title} (${CLAUSE_TYPE_LABEL[cl.clauseType]})`);
        doc.font('Helvetica').fontSize(9).fillColor('#333').text(cl.contentText);
        doc.moveDown(0.5);
      });

      // Rate card annexure — grouped by rate year
      doc.addPage();
      doc
        .fillColor('#000')
        .font('Helvetica-Bold')
        .fontSize(13)
        .text('Annexure A — Rate Card');
      doc.moveDown(0.5);
      const years = [...new Set(c.rateCards.map((r) => r.rateYear))].sort(
        (a, b) => a - b,
      );
      const startX = 48;
      for (const yr of years) {
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#000').text(`Year ${yr}`);
        let y = doc.y + 4;
        const cols = [
          { label: 'Item / Route', x: startX, w: 200 },
          { label: 'UOM', x: startX + 200, w: 44 },
          { label: 'Band', x: startX + 244, w: 80 },
          { label: 'Unit rate', x: startX + 324, w: 70 },
          { label: 'Tax%', x: startX + 394, w: 40 },
        ];
        doc.fontSize(8).font('Helvetica-Bold');
        for (const col of cols) doc.text(col.label, col.x, y, { width: col.w });
        y += 13;
        doc
          .moveTo(startX, y - 3)
          .lineTo(startX + 434, y - 3)
          .strokeColor('#ccc')
          .stroke();
        doc.font('Helvetica').fontSize(8).fillColor('#000');
        for (const r of c.rateCards.filter((rc) => rc.rateYear === yr)) {
          const label = r.routeOrigin
            ? `${r.routeOrigin} → ${r.routeDest ?? ''}`
            : r.itemDesc;
          const band =
            r.volumeBandMin || r.volumeBandMax
              ? `${r.volumeBandMin ?? '0'}–${r.volumeBandMax ?? '∞'}`
              : '—';
          doc.text(label, cols[0]!.x, y, { width: cols[0]!.w });
          doc.text(r.uom, cols[1]!.x, y, { width: cols[1]!.w });
          doc.text(band, cols[2]!.x, y, { width: cols[2]!.w });
          doc.text(money(r.unitRate), cols[3]!.x, y, { width: cols[3]!.w });
          doc.text(
            new Decimal(r.taxRate.toString()).times(100).toFixed(1),
            cols[4]!.x,
            y,
            {
              width: cols[4]!.w,
            },
          );
          y += 15;
          if (y > 740) {
            doc.addPage();
            y = 60;
          }
        }
        doc.y = y + 8;
      }

      // Signature blocks
      doc.moveDown(2);
      const sigY = doc.y;
      doc.font('Helvetica').fontSize(9).fillColor('#000');
      doc.text('_______________________________', 48, sigY);
      doc.text(`For ${c.tenant.name}`, 48);
      doc.text('Authorised signatory · Procurement', 48);
      doc.text('_______________________________', 320, sigY);
      doc.text(`For ${c.vendor.name}`, 320);
      doc.text('Authorised signatory · Vendor', 320);

      if (opts.watermark) {
        doc
          .save()
          .rotate(45, { origin: [300, 400] })
          .fontSize(80)
          .fillColor('#e11d48')
          .opacity(0.18)
          .text(opts.watermark, 120, 380)
          .restore();
      }

      doc.end();
    });
  }

  private load(contractId: string) {
    return this.prisma.client.contract.findUnique({
      where: { id: contractId },
      include: {
        vendor: true,
        tenant: true,
        rateCards: { orderBy: [{ rateYear: 'asc' }, { lineNo: 'asc' }] },
        clauses: { orderBy: { orderNo: 'asc' } },
      },
    });
  }
}
