import { createHash } from 'node:crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import Decimal from 'decimal.js';
import PDFDocument from 'pdfkit';

import { PrismaService } from '../prisma/prisma.service';

export interface GeneratedRma {
  buffer: Buffer;
  hash: string;
}

const GOLDEN_DATE = new Date('2026-07-15T00:00:00.000Z');

/**
 * RmaDocumentService (Slice 5). Renders a real binary Return Material
 * Authorisation PDF with pdfkit (reuses the Slice 4 PoDocument pattern — no
 * Chromium). Returns bytes + sha256 hash recorded on the RMA at issue time.
 */
@Injectable()
export class RmaDocumentService {
  constructor(private readonly prisma: PrismaService) {}

  async generate(
    rmaId: string,
    opts: { deterministic?: boolean } = {},
  ): Promise<GeneratedRma> {
    const rma = await this.prisma.client.returnMaterialAuth.findUnique({
      where: { id: rmaId },
      include: {
        tenant: true,
        vendor: true,
        grn: true,
        lines: { include: { grnLine: { include: { poLine: true } } } },
      },
    });
    if (!rma) throw new NotFoundException('RMA not found');
    const buffer = await this.render(rma, opts);
    const hash = createHash('sha256').update(buffer).digest('hex');
    return { buffer, hash };
  }

  private render(
    rma: NonNullable<
      Awaited<ReturnType<PrismaService['client']['returnMaterialAuth']['findUnique']>>
    > & {
      tenant: { name: string; gstin: string | null };
      vendor: { name: string; code: string; gstin: string | null };
      grn: { number: string };
      lines: {
        qtyReturned: Decimal;
        unitPrice: Decimal;
        lineTotal: Decimal;
        returnReasonDetail: string | null;
        grnLine: { poLine: { itemDesc: string; uom: string } };
      }[];
    },
    opts: { deterministic?: boolean },
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 48,
        info: {
          Title: `Return Material Authorisation ${rma.number}`,
          Author: rma.tenant.name,
          ...(opts.deterministic ? { CreationDate: GOLDEN_DATE } : {}),
        },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const money = (v: string | Decimal): string => new Decimal(v.toString()).toFixed(2);

      doc.fontSize(18).font('Helvetica-Bold').text(rma.tenant.name);
      doc.fontSize(9).font('Helvetica').fillColor('#555');
      doc.text(`GSTIN: ${rma.tenant.gstin ?? '—'}`);
      doc.moveDown(0.5);
      doc
        .fillColor('#000')
        .fontSize(15)
        .font('Helvetica-Bold')
        .text('RETURN MATERIAL AUTHORISATION');
      doc.fontSize(10).font('Helvetica');
      doc.text(`RMA Number: ${rma.number}`);
      doc.text(`Against GRN: ${rma.grn.number}`);
      doc.text(`Reason: ${rma.reasonCode}`);
      if (rma.reasonNotes) doc.text(`Notes: ${rma.reasonNotes}`);
      doc.moveDown(0.75);

      const topY = doc.y;
      doc.font('Helvetica-Bold').text('Return to vendor', 48, topY);
      doc.font('Helvetica').fontSize(9);
      doc.text(rma.vendor.name);
      doc.text(`Code: ${rma.vendor.code}`);
      doc.text(`GSTIN: ${rma.vendor.gstin ?? '—'}`);
      doc.moveDown(1.2);

      const startX = 48;
      let y = Math.max(doc.y, topY + 60);
      doc.font('Helvetica-Bold').fontSize(8);
      const cols = [
        { label: '#', x: startX, w: 18 },
        { label: 'Description', x: startX + 18, w: 200 },
        { label: 'Qty', x: startX + 218, w: 50 },
        { label: 'UOM', x: startX + 268, w: 40 },
        { label: 'Rate', x: startX + 308, w: 70 },
        { label: 'Value', x: startX + 378, w: 80 },
      ];
      for (const c of cols) doc.text(c.label, c.x, y, { width: c.w });
      y += 14;
      doc
        .moveTo(startX, y - 3)
        .lineTo(startX + 460, y - 3)
        .strokeColor('#ccc')
        .stroke();
      doc.font('Helvetica').fontSize(8).fillColor('#000');
      rma.lines.forEach((l, i) => {
        doc.text(String(i + 1), cols[0]!.x, y, { width: cols[0]!.w });
        doc.text(l.grnLine.poLine.itemDesc, cols[1]!.x, y, { width: cols[1]!.w });
        doc.text(l.qtyReturned.toString(), cols[2]!.x, y, { width: cols[2]!.w });
        doc.text(l.grnLine.poLine.uom, cols[3]!.x, y, { width: cols[3]!.w });
        doc.text(money(l.unitPrice), cols[4]!.x, y, { width: cols[4]!.w });
        doc.text(money(l.lineTotal), cols[5]!.x, y, { width: cols[5]!.w });
        y += 16;
      });
      y += 8;
      doc
        .moveTo(startX + 308, y)
        .lineTo(startX + 460, y)
        .strokeColor('#ccc')
        .stroke();
      y += 6;
      doc.font('Helvetica-Bold').fontSize(9);
      doc.text('Total return value', startX + 308, y, { width: 100 });
      doc.text(`INR ${money(rma.totalReturnValue)}`, startX + 378, y, { width: 80 });
      y += 26;

      doc
        .fillColor('#000')
        .font('Helvetica-Bold')
        .fontSize(10)
        .text('Pickup instructions', startX, y);
      doc.font('Helvetica').fontSize(9);
      doc.text(
        'Please arrange pickup of the above rejected material and issue a credit note against this RMA. ' +
          `Return freight to be borne by: ${rma.returnFreightBorneBy}.`,
      );
      doc.moveDown(1);
      doc.font('Helvetica-Bold').fontSize(10).text('Credit note request');
      doc.font('Helvetica').fontSize(9);
      doc.text(
        `A credit note for INR ${money(rma.totalReturnValue)} is requested against this return.`,
      );
      doc.moveDown(1.5);
      doc.text('_______________________________');
      doc.text(`For ${rma.tenant.name}`);
      doc.text('Authorised signatory · Stores & Quality');

      doc.end();
    });
  }
}
