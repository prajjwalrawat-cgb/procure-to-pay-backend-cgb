/**
 * Generates the golden RMA PDF fixture (packages/db/fixtures/rma-golden.pdf).
 * Deterministic (pinned CreationDate) so byte-stable regression tests are
 * possible. Mirrors the demo RMA: Patel Engineering, 0.2 tonne 25mm grinding
 * media rejected for visible transit damage. Run: `tsx scripts/generate-rma-golden.ts`.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Decimal from 'decimal.js';
import PDFDocument from 'pdfkit';

const GOLDEN_DATE = new Date('2026-07-15T00:00:00.000Z');
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../../../packages/db/fixtures/rma-golden.pdf');

const rma = {
  number: 'RMA-0001',
  grnNumber: 'GRN-0312',
  reasonCode: 'DAMAGED',
  reasonNotes: 'Damage in transit — 2 drums dented, material contaminated with debris.',
  returnFreightBorneBy: 'VENDOR',
  totalReturnValue: '25700.0000',
  tenant: { name: 'Star Cement Ltd', gstin: '17AAACS1234M1Z9' },
  vendor: { name: 'Patel Engineering', code: 'V-PATEL', gstin: '24AABCP1234K1Z5' },
  lines: [
    {
      itemDesc: 'Forged steel grinding balls 25mm',
      uom: 'tonne',
      qtyReturned: '0.2000',
      unitPrice: '128500.0000',
      lineTotal: '25700.0000',
    },
  ],
};

function money(v: string): string {
  return new Decimal(v).toFixed(2);
}

const doc = new PDFDocument({
  size: 'A4',
  margin: 48,
  info: {
    Title: `Return Material Authorisation ${rma.number}`,
    Author: rma.tenant.name,
    CreationDate: GOLDEN_DATE,
  },
});
const chunks: Buffer[] = [];
doc.on('data', (c: Buffer) => chunks.push(c));
doc.on('end', () => {
  const buffer = Buffer.concat(chunks);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buffer);
  const hash = createHash('sha256').update(buffer).digest('hex');
  console.log(`Wrote ${out} (${buffer.length} bytes, sha256 ${hash.slice(0, 16)}…)`);
});

doc.fontSize(18).font('Helvetica-Bold').text(rma.tenant.name);
doc.fontSize(9).font('Helvetica').fillColor('#555');
doc.text(`GSTIN: ${rma.tenant.gstin}`);
doc.moveDown(0.5);
doc
  .fillColor('#000')
  .fontSize(15)
  .font('Helvetica-Bold')
  .text('RETURN MATERIAL AUTHORISATION');
doc.fontSize(10).font('Helvetica');
doc.text(`RMA Number: ${rma.number}`);
doc.text(`Against GRN: ${rma.grnNumber}`);
doc.text(`Reason: ${rma.reasonCode}`);
doc.text(`Notes: ${rma.reasonNotes}`);
doc.moveDown(0.75);

const topY = doc.y;
doc.font('Helvetica-Bold').text('Return to vendor', 48, topY);
doc.font('Helvetica').fontSize(9);
doc.text(rma.vendor.name);
doc.text(`Code: ${rma.vendor.code}`);
doc.text(`GSTIN: ${rma.vendor.gstin}`);
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
  doc.text(l.itemDesc, cols[1]!.x, y, { width: cols[1]!.w });
  doc.text(l.qtyReturned, cols[2]!.x, y, { width: cols[2]!.w });
  doc.text(l.uom, cols[3]!.x, y, { width: cols[3]!.w });
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
