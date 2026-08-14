import { createHash } from 'node:crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import { computeDocTax, taxKindLabel, type PaymentTerms } from '@procureflow/shared';
import Decimal from 'decimal.js';
import PDFDocument from 'pdfkit';

import { PrismaService } from '../prisma/prisma.service';

export interface GeneratedPo {
  buffer: Buffer;
  hash: string;
}

/** Fixed creation date so golden-PDF regression tests are byte-stable except
 *  for content we deliberately vary. */
const GOLDEN_DATE = new Date('2026-07-14T00:00:00.000Z');

const DEFAULT_TERMS = [
  'Goods must conform to the specifications, quantity and quality stated in this order.',
  'Delivery must be accompanied by a valid tax invoice and e-way bill where applicable.',
  'Payment is subject to a successful 3-way match against GRN and invoice.',
  'This order is governed by the laws of India; disputes subject to Meghalaya jurisdiction.',
];

/**
 * PoDocumentService (Slice 4). Renders a real, binary PDF purchase order with
 * pdfkit (a pure-JS PDF engine — no Chromium dependency; see ADR-010 note) and
 * returns the bytes plus a sha256 hash recorded on the PO at issue time.
 */
@Injectable()
export class PoDocumentService {
  constructor(private readonly prisma: PrismaService) {}

  async generate(
    poId: string,
    opts: { watermark?: string; deterministic?: boolean } = {},
  ): Promise<GeneratedPo> {
    const po = await this.load(poId);
    if (!po) throw new NotFoundException('Purchase order not found');

    const plant =
      po.requisition?.plant ??
      (await this.prisma.client.plant.findFirst({
        where: { tenantId: po.tenantId },
      }));
    const plantState = plant?.stateCode ?? '17';

    const tax = computeDocTax(
      po.lines.map((l) => ({
        qty: l.qtyOrdered.toString(),
        unitPrice: l.unitPrice.toString(),
        discountPct: l.discountPct.toString(),
        taxRate: l.taxRate.toString(),
      })),
      { plantStateCode: plantState, vendorGstin: po.vendor.gstin },
    );

    const paymentTerms =
      (po.paymentTermsSnapshot as unknown as PaymentTerms | null) ?? null;
    const buffer = await this.render(po, plant, tax, paymentTerms, opts);
    const hash = createHash('sha256').update(buffer).digest('hex');
    return { buffer, hash };
  }

  private render(
    po: NonNullable<Awaited<ReturnType<PoDocumentService['load']>>>,
    plant: { name: string; address: string | null; gstin: string | null } | null,
    tax: ReturnType<typeof computeDocTax>,
    paymentTerms: PaymentTerms | null,
    opts: { watermark?: string; deterministic?: boolean },
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 48,
        info: {
          Title: `Purchase Order ${po.number}`,
          Author: po.tenant.name,
          // Only pin the date for golden-PDF tests; otherwise let pdfkit default
          // it (passing `undefined` explicitly breaks pdfkit's file-id hashing).
          ...(opts.deterministic ? { CreationDate: GOLDEN_DATE } : {}),
        },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const money = (v: string | Decimal): string => new Decimal(v.toString()).toFixed(2);

      // Header
      doc.fontSize(18).font('Helvetica-Bold').text(po.tenant.name, { continued: false });
      doc.fontSize(9).font('Helvetica').fillColor('#555');
      doc.text(`GSTIN: ${po.tenant.gstin ?? '—'}`);
      if (plant?.address) doc.text(plant.address);
      doc.moveDown(0.5);
      doc.fillColor('#000').fontSize(15).font('Helvetica-Bold').text('PURCHASE ORDER');
      doc.fontSize(10).font('Helvetica');
      doc.text(`PO Number: ${po.number}`);
      doc.text(`Issue date: ${(po.issuedAt ?? po.createdAt).toISOString().slice(0, 10)}`);
      if (po.requisition) doc.text(`Against requisition: ${po.requisition.number}`);
      doc.moveDown(0.75);

      // Vendor + delivery blocks
      const topY = doc.y;
      doc.font('Helvetica-Bold').text('Vendor', 48, topY);
      doc.font('Helvetica').fontSize(9);
      doc.text(po.vendor.name);
      doc.text(`GSTIN: ${po.vendor.gstin ?? '—'}`);
      if (po.vendor.isMsme) doc.text(`MSME: ${po.vendor.udyamNumber ?? 'Yes'}`);

      const addr = po.deliveryAddress as { line1?: string; city?: string } | null;
      doc.font('Helvetica-Bold').fontSize(10).text('Deliver to', 320, topY);
      doc.font('Helvetica').fontSize(9);
      doc.text(addr?.line1 ?? plant?.name ?? po.deliveryAddr ?? '—', 320);
      doc.text(
        `Expected: ${po.expectedDeliveryDate?.toISOString().slice(0, 10) ?? '—'}`,
        320,
      );
      doc.text(`Incoterm: ${po.deliveryTerms ?? 'DDP'}`, 320);
      doc.moveDown(1.5);

      // Line items table
      const startX = 48;
      let y = Math.max(doc.y, topY + 70);
      doc.font('Helvetica-Bold').fontSize(8);
      const cols = [
        { label: '#', x: startX, w: 18 },
        { label: 'Description', x: startX + 18, w: 150 },
        { label: 'HSN', x: startX + 168, w: 44 },
        { label: 'Qty', x: startX + 212, w: 44 },
        { label: 'UOM', x: startX + 256, w: 34 },
        { label: 'Rate', x: startX + 290, w: 60 },
        { label: 'Tax%', x: startX + 350, w: 40 },
        { label: 'Total', x: startX + 390, w: 70 },
      ];
      for (const c of cols) doc.text(c.label, c.x, y, { width: c.w });
      y += 14;
      doc
        .moveTo(startX, y - 3)
        .lineTo(startX + 460, y - 3)
        .strokeColor('#ccc')
        .stroke();
      doc.font('Helvetica').fontSize(8).fillColor('#000');
      for (const l of po.lines) {
        const lineTotal = new Decimal(l.qtyOrdered.toString())
          .times(l.unitPrice.toString())
          .times(new Decimal(1).minus(l.discountPct.toString()));
        const withTax = lineTotal.times(new Decimal(1).plus(l.taxRate.toString()));
        doc.text(String(l.lineNo), cols[0]!.x, y, { width: cols[0]!.w });
        doc.text(l.itemDesc, cols[1]!.x, y, { width: cols[1]!.w });
        doc.text(l.hsnCode ?? '—', cols[2]!.x, y, { width: cols[2]!.w });
        doc.text(l.qtyOrdered.toString(), cols[3]!.x, y, { width: cols[3]!.w });
        doc.text(l.uom, cols[4]!.x, y, { width: cols[4]!.w });
        doc.text(money(l.unitPrice.toString()), cols[5]!.x, y, { width: cols[5]!.w });
        doc.text(new Decimal(l.taxRate.toString()).times(100).toFixed(1), cols[6]!.x, y, {
          width: cols[6]!.w,
        });
        doc.text(money(withTax), cols[7]!.x, y, { width: cols[7]!.w });
        y += 16;
        if (y > 720) {
          doc.addPage();
          y = 60;
        }
      }

      // Totals block
      y += 8;
      doc
        .moveTo(startX + 290, y)
        .lineTo(startX + 460, y)
        .strokeColor('#ccc')
        .stroke();
      y += 6;
      const totalRow = (label: string, value: string): void => {
        doc
          .font('Helvetica')
          .fontSize(9)
          .text(label, startX + 290, y, { width: 100 });
        doc.text(value, startX + 390, y, { width: 70 });
        y += 14;
      };
      totalRow('Subtotal', money(tax.subtotal));
      if (tax.taxKind === 'CGST_SGST') {
        totalRow('CGST', money(tax.cgst));
        totalRow('SGST', money(tax.sgst));
      } else if (tax.taxKind === 'IGST') {
        totalRow('IGST', money(tax.igst));
      }
      doc.font('Helvetica-Bold');
      totalRow('Total', `INR ${money(tax.total)}`);
      doc.font('Helvetica').fontSize(8).fillColor('#555');
      doc.text(`(${taxKindLabel(tax.taxKind)})`, startX + 290, y);
      y += 20;

      // Payment terms + T&C
      doc
        .fillColor('#000')
        .font('Helvetica-Bold')
        .fontSize(10)
        .text('Payment terms', startX, y);
      doc.font('Helvetica').fontSize(9);
      doc.text(
        paymentTerms?.label ??
          `${paymentTerms?.kind ?? 'NET_30'}${paymentTerms?.days ? ` (${paymentTerms.days} days)` : ''}`,
      );
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(10).text('Terms & conditions');
      doc.font('Helvetica').fontSize(8).fillColor('#333');
      // Terms chosen for this order (library clauses + any special conditions),
      // already ordered. DEFAULT_TERMS is the floor for POs raised before terms
      // selection existed, or where the clause library is still empty — a PO
      // must never go out to a vendor with no conditions on it at all.
      if (po.terms.length > 0) {
        po.terms.forEach((t, i) => {
          doc.font('Helvetica-Bold').text(`${i + 1}. ${t.title}`);
          doc.font('Helvetica').text(t.contentText, { indent: 10 });
        });
      } else {
        DEFAULT_TERMS.forEach((t, i) => doc.text(`${i + 1}. ${t}`));
      }
      doc.moveDown(1.5);

      // Signature block
      doc.fillColor('#000').font('Helvetica').fontSize(9);
      doc.text('_______________________________');
      doc.text(`For ${po.tenant.name}`);
      doc.text('Authorised signatory · Procurement');
      doc.text('(Digital signature placeholder)', { oblique: true } as never);

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

  // Type helper so `render`'s `po` param is well-typed.
  private load(poId: string) {
    return this.prisma.client.purchaseOrder.findUnique({
      where: { id: poId },
      include: {
        vendor: true,
        lines: { orderBy: { lineNo: 'asc' } },
        terms: { orderBy: { orderNo: 'asc' } },
        requisition: { include: { plant: true } },
        tenant: true,
      },
    });
  }
}
