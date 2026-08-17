import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import {
  computeDocTax,
  formatCustomFieldValue,
  formatGstState,
  gstStateName,
  taxKindLabel,
  type CustomFieldDefinition,
  type PaymentTerms,
} from '@procureflow/shared';
import Decimal from 'decimal.js';
import PDFDocument from 'pdfkit';

import { StorageService } from '../common/storage/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { CustomFieldsService } from '../settings/custom-fields.service';
import { tenantLogoKey } from '../settings/settings.service';

export interface GeneratedPo {
  buffer: Buffer;
  hash: string;
}

/** Fixed creation date so golden-PDF regression tests are byte-stable except
 *  for content we deliberately vary. */
const GOLDEN_DATE = new Date('2026-07-14T00:00:00.000Z');

/** Jurisdiction follows the buying plant's own state — it used to name one
 *  state outright, which put the wrong court on every other tenant's orders. */
function defaultTerms(jurisdiction: string | null): string[] {
  return [
    'Goods must conform to the specifications, quantity and quality stated in this order.',
    'Delivery must be accompanied by a valid tax invoice and e-way bill where applicable.',
    'Payment is subject to a successful 3-way match against GRN and invoice.',
    jurisdiction
      ? `This order is governed by the laws of India; disputes subject to ${jurisdiction} jurisdiction.`
      : 'This order is governed by the laws of India.',
  ];
}

// ── Page geometry ──────────────────────────────────────────────────────────
// The document is a ruled grid (one outer table, everything inside a cell) so
// it reads like a commercial purchase order rather than a letter.
const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN = 30;
const X0 = MARGIN;
const CONTENT_W = PAGE_W - MARGIN * 2; // 535.28
const X1 = X0 + CONTENT_W;
const FOOTER_H = 28;
const BOTTOM = PAGE_H - MARGIN - FOOTER_H;
const PAD = 4;

const REG = 'Helvetica';
const BOLD = 'Helvetica-Bold';
const BORDER = '#000000';
const HEAD_FILL = '#e8e8e8';
const SOFT_FILL = '#f4f4f4';
const MUTED = '#555555';

/** A run of text inside a cell. Cells stack their fragments vertically. */
interface Frag {
  text: string;
  bold?: boolean;
  size?: number;
  color?: string;
  align?: 'left' | 'right' | 'center';
  /** Extra vertical space after this fragment. */
  gap?: number;
}

interface Cell {
  w: number;
  frags: Frag[];
  fill?: string;
}

const ONES = [
  '',
  'ONE',
  'TWO',
  'THREE',
  'FOUR',
  'FIVE',
  'SIX',
  'SEVEN',
  'EIGHT',
  'NINE',
  'TEN',
  'ELEVEN',
  'TWELVE',
  'THIRTEEN',
  'FOURTEEN',
  'FIFTEEN',
  'SIXTEEN',
  'SEVENTEEN',
  'EIGHTEEN',
  'NINETEEN',
];
const TENS = [
  '',
  '',
  'TWENTY',
  'THIRTY',
  'FORTY',
  'FIFTY',
  'SIXTY',
  'SEVENTY',
  'EIGHTY',
  'NINETY',
];

/** 0–99 in words. */
function twoDigits(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const t = TENS[Math.floor(n / 10)] ?? '';
  const o = ONES[n % 10] ?? '';
  return o ? `${t} ${o}` : t;
}

/** Indian numbering: crore / lakh / thousand / hundred. */
function integerInWords(value: number): string {
  if (value === 0) return 'ZERO';
  const parts: string[] = [];
  const crore = Math.floor(value / 10000000);
  const lakh = Math.floor((value % 10000000) / 100000);
  const thousand = Math.floor((value % 100000) / 1000);
  const hundred = Math.floor((value % 1000) / 100);
  const rest = value % 100;
  if (crore) parts.push(`${integerInWords(crore)} CRORE`);
  if (lakh) parts.push(`${twoDigits(lakh)} LAKH`);
  if (thousand) parts.push(`${twoDigits(thousand)} THOUSAND`);
  if (hundred) parts.push(`${ONES[hundred]} HUNDRED`);
  if (rest) parts.push(twoDigits(rest));
  return parts.join(' ');
}

/** "10290.00" → "TEN THOUSAND TWO HUNDRED NINETY RUPEES ONLY." */
function amountInWords(amount: Decimal | string, currency: string): string {
  const v = new Decimal(amount.toString()).toDecimalPlaces(2);
  const rupees = v.floor().toNumber();
  const paise = v.minus(v.floor()).times(100).round().toNumber();
  const unit = currency === 'INR' ? 'RUPEES' : currency;
  const head = `${integerInWords(rupees)} ${unit}`;
  return paise > 0 ? `${head} AND ${twoDigits(paise)} PAISE ONLY.` : `${head} ONLY.`;
}

/** Indian digit grouping: 1234567.5 → "12,34,567.50". */
function groupIndian(value: Decimal | string): string {
  const fixed = new Decimal(value.toString()).toFixed(2);
  const neg = fixed.startsWith('-');
  const [intPart = '0', frac = '00'] = fixed.replace('-', '').split('.');
  const last3 = intPart.slice(-3);
  const rest = intPart.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${neg ? '-' : ''}${grouped}.${frac}`;
}

/** Trims trailing zeros off a quantity: "35.0000" → "35". */
function qtyText(value: Decimal | string): string {
  return new Decimal(value.toString()).toDecimalPlaces(4).toString();
}

/** UTC date as dd.mm.yyyy (UTC keeps golden PDFs stable across machines). */
function fmtDate(value: Date | null | undefined): string {
  if (!value) return '—';
  const [y, m, d] = value.toISOString().slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

// ── Tenant letterhead logo ─────────────────────────────────────────────────
// Dropped in as a file rather than a DB column so a tenant can be branded
// without a migration. Looked up per tenant — never one hardcoded brand.
const LOGO_DIR =
  process.env.TENANT_LOGO_DIR ?? join(process.cwd(), 'assets', 'tenant-logos');
const LOGO_EXTS = ['.png', '.jpg', '.jpeg'];

/** "ArtBox Solutions" → "artbox-solutions" (the logo file's basename). */
function tenantSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** `<slug>.png` for this tenant, else a shared `default.png`, else none. */
function resolveTenantLogo(tenantName: string): string | null {
  for (const base of [tenantSlug(tenantName), 'default']) {
    if (!base) continue;
    for (const ext of LOGO_EXTS) {
      const candidate = join(LOGO_DIR, `${base}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** GSTIN's first two digits are the state code. */
function stateOfGstin(gstin: string | null | undefined): string | null {
  return gstin && gstin.length >= 2 ? gstin.slice(0, 2) : null;
}

/**
 * PoDocumentService (Slice 4). Renders a real, binary PDF purchase order with
 * pdfkit (a pure-JS PDF engine — no Chromium dependency; see ADR-010 note) and
 * returns the bytes plus a sha256 hash recorded on the PO at issue time.
 *
 * Layout is a ruled grid modelled on the commercial POs vendors already handle
 * (header block, key/value particulars, item table, tax summary, amount in
 * words, conditions, acknowledgement + signatory blocks, page footer).
 */
@Injectable()
export class PoDocumentService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly storage?: StorageService,
    @Optional() private readonly customFields?: CustomFieldsService,
  ) {}

  /**
   * The tenant's letterhead logo: the one uploaded through organisation
   * settings, else a file dropped into the logo directory, else none. Never
   * throws — a PO must still render without branding.
   */
  private async loadLogo(
    tenantId: string,
    tenantName: string,
  ): Promise<Buffer | string | null> {
    const stored = await this.storage?.getBuffer(tenantLogoKey(tenantId));
    return stored ?? resolveTenantLogo(tenantName);
  }

  /** The tenant's own PO fields that were marked "print on the PDF", in the
   *  order an admin arranged them. */
  private async printableFields(
    tenantId: string,
    values: unknown,
  ): Promise<{ label: string; value: string }[]> {
    if (!this.customFields || !values) return [];
    const described = await this.customFields.describe(
      tenantId,
      'PURCHASE_ORDER',
      values,
      { printableOnly: true },
    );
    return described.map((f) => ({
      label: f.label,
      value: formatCustomFieldValue(
        { fieldType: f.fieldType as CustomFieldDefinition['fieldType'] },
        f.value,
      ),
    }));
  }

  async generate(
    poId: string,
    opts: { watermark?: string; deterministic?: boolean } = {},
  ): Promise<GeneratedPo> {
    const po = await this.load(poId);
    if (!po) throw new NotFoundException('Purchase order not found');

    // Bill-to registration, in precedence order: the one named on the order,
    // else the requisition's plant, else the tenant's default. Never
    // "whichever row comes back first" — with more than one GST registration
    // that would decide the tax split by chance.
    const plant =
      po.billToPlant ??
      po.requisition?.plant ??
      (await this.prisma.client.plant.findFirst({
        where: { tenantId: po.tenantId },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      }));
    const plantState = plant?.stateCode ?? '';

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
    const logo = await this.loadLogo(po.tenantId, po.tenant.name);
    const customFields = await this.printableFields(po.tenantId, po.customFields);
    const buffer = await this.render(po, plant, tax, paymentTerms, {
      ...opts,
      logo,
      customFields,
    });
    const hash = createHash('sha256').update(buffer).digest('hex');
    return { buffer, hash };
  }

  private render(
    po: NonNullable<Awaited<ReturnType<PoDocumentService['load']>>>,
    plant: {
      name: string;
      address: string | null;
      gstin: string | null;
      stateCode?: string;
    } | null,
    tax: ReturnType<typeof computeDocTax>,
    paymentTerms: PaymentTerms | null,
    opts: {
      watermark?: string;
      deterministic?: boolean;
      logo?: Buffer | string | null;
      /** Admin-defined fields the tenant marked printable. */
      customFields?: { label: string; value: string }[];
    },
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        // Bottom margin 0 disables pdfkit's implicit page breaks — this layout
        // paginates itself so rows never split across a page edge.
        margins: { top: MARGIN, bottom: 0, left: MARGIN, right: MARGIN },
        bufferPages: true,
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

      // ── Grid primitives ───────────────────────────────────────────────
      const fragOpts = (f: Frag, w: number) => ({
        width: w - PAD * 2,
        align: f.align ?? ('left' as const),
        lineGap: 1,
      });
      const applyFont = (f: Frag): void => {
        doc
          .font(f.bold ? BOLD : REG)
          .fontSize(f.size ?? 8)
          .fillColor(f.color ?? '#000');
      };
      const cellHeight = (c: Cell): number =>
        c.frags.reduce((h, f) => {
          if (!f.text) return h + (f.gap ?? 0);
          applyFont(f);
          return h + doc.heightOfString(f.text, fragOpts(f, c.w)) + (f.gap ?? 0);
        }, PAD * 2);

      let y = MARGIN;

      const drawRow = (cells: Cell[], minH = 0): void => {
        const h = cells.reduce((m, c) => Math.max(m, cellHeight(c)), minH);
        let x = X0;
        for (const c of cells) {
          if (c.fill) doc.rect(x, y, c.w, h).fillColor(c.fill).fill();
          doc.lineWidth(0.5).strokeColor(BORDER).rect(x, y, c.w, h).stroke();
          let cy = y + PAD;
          for (const f of c.frags) {
            if (f.text) {
              applyFont(f);
              doc.text(f.text, x + PAD, cy, fragOpts(f, c.w));
              cy += doc.heightOfString(f.text, fragOpts(f, c.w));
            }
            cy += f.gap ?? 0;
          }
          x += c.w;
        }
        y += h;
      };

      /** Page-break guard: `onBreak` redraws whatever header the block needs. */
      const ensure = (needed: number, onBreak?: () => void): void => {
        if (y + needed <= BOTTOM) return;
        doc.addPage();
        y = MARGIN;
        onBreak?.();
      };

      const cell = (w: number, frags: Frag[], fill?: string): Cell => ({
        w,
        frags,
        fill,
      });
      const label = (text: string): Frag => ({ text, size: 7.5, color: MUTED });
      const value = (text: string, bold = false): Frag => ({ text, bold });

      // ── Derived values ────────────────────────────────────────────────
      const money = (v: Decimal | string): string => groupIndian(v);
      const currency = po.currency || 'INR';
      const issueDate = po.issuedAt ?? po.createdAt;
      const vendorState = stateOfGstin(po.vendor.gstin);
      const contact = po.vendor.contacts?.[0] ?? null;
      const addr = po.deliveryAddress as {
        label?: string | null;
        line1?: string | null;
        line2?: string | null;
        city?: string | null;
        stateCode?: string | null;
        pincode?: string | null;
      } | null;

      const deliveryLines = addr
        ? [
            addr.label,
            addr.line1,
            addr.line2,
            [addr.city, addr.pincode].filter(Boolean).join(' '),
            addr.stateCode ? formatGstState(addr.stateCode) : null,
          ]
            .map((s) => (s ?? '').trim())
            .filter(Boolean)
        : [po.deliveryAddr ?? plant?.name ?? '—'];

      const billingLines = [
        po.tenant.name,
        plant?.name ?? null,
        plant?.address ?? null,
        plant?.gstin ? `GSTIN: ${plant.gstin}` : null,
        plant?.stateCode ? `State: ${formatGstState(plant.stateCode)}` : null,
      ]
        .map((s) => (s ?? '').trim())
        .filter(Boolean);

      // Goods sent somewhere other than the billing branch are a bill-to /
      // ship-to supply: the place of supply stays the billing registration
      // (IGST Act s.10(1)(b)), and the vendor's invoice has to say so.
      const shipToElsewhere =
        !!addr?.line1 &&
        (!plant?.address ||
          !addr.line1.toLowerCase().includes(plant.address.toLowerCase()));

      const paymentLabel =
        paymentTerms?.label ??
        `${paymentTerms?.kind ?? 'NET_30'}${
          paymentTerms?.days ? ` (${paymentTerms.days} days)` : ''
        }`;

      // ── Company header ────────────────────────────────────────────────
      const orgName = po.tenant.name.toUpperCase();
      // Address and GSTIN both come from the billing branch — a company has one
      // registration per state, not one overall.
      const orgLine = [
        plant?.address ?? null,
        plant?.gstin ? `GSTIN: ${plant.gstin}` : null,
      ]
        .filter(Boolean)
        .join('  ·  ');

      // With a logo the letterhead is a compact left band (logo beside the
      // name); without one the name centres on its own. A missing or unreadable
      // image must never fail a PO download, so the draw is best-effort.
      let logoDrawn = false;
      if (opts.logo) {
        try {
          doc.image(opts.logo, X0, y, { fit: [104, 38] });
          logoDrawn = true;
        } catch {
          // Fall through to the text-only letterhead.
        }
      }

      const textX = logoDrawn ? X0 + 116 : X0;
      const textW = CONTENT_W - (textX - X0);
      const align = logoDrawn ? ('left' as const) : ('center' as const);
      let textY = y + (logoDrawn ? 2 : 0);

      doc.font(BOLD).fontSize(15).fillColor('#000');
      doc.text(orgName, textX, textY, { width: textW, align });
      textY += doc.heightOfString(orgName, { width: textW });
      if (orgLine) {
        doc.font(REG).fontSize(7.5).fillColor(MUTED);
        doc.text(orgLine, textX, textY + 1, { width: textW, align });
        textY += doc.heightOfString(orgLine, { width: textW }) + 1;
      }
      y = Math.max(textY, logoDrawn ? y + 38 : y) + 8;

      // ── Title bar ─────────────────────────────────────────────────────
      drawRow(
        [
          cell(
            CONTENT_W,
            [{ text: 'PURCHASE ORDER', bold: true, size: 13, align: 'center' }],
            HEAD_FILL,
          ),
        ],
        22,
      );

      // ── "To" block + order identifiers ────────────────────────────────
      const toW = CONTENT_W * 0.52;
      const idW = (CONTENT_W - toW) / 2;
      drawRow(
        [
          cell(toW, [
            label('To'),
            value(po.vendor.legalEntityName ?? po.vendor.name, true),
            ...(contact?.name ? [value(contact.name)] : []),
            ...(contact?.phone ? [value(`Tel: ${contact.phone}`)] : []),
            ...(contact?.email ? [value(contact.email)] : []),
          ]),
          cell(idW, [label('Vendor code'), value(po.vendor.code || '—', true)]),
          cell(idW, [
            label('Against requisition'),
            value(po.requisition?.number ?? '—', true),
          ]),
        ],
        52,
      );

      // ── Particulars grid ──────────────────────────────────────────────
      const labW = 108;
      const valW = CONTENT_W / 2 - labW;
      const kv = (lLab: string, lVal: string, rLab: string, rVal: string): void =>
        drawRow(
          [
            cell(labW, [label(lLab)], SOFT_FILL),
            cell(valW, [value(lVal)]),
            cell(labW, [label(rLab)], SOFT_FILL),
            cell(valW, [value(rVal)]),
          ],
          15,
        );

      kv('GSTIN of vendor', po.vendor.gstin ?? '—', 'Purchase order no.', po.number);
      kv(
        'State code of vendor',
        vendorState ? formatGstState(vendorState) : '—',
        'Date',
        fmtDate(issueDate),
      );
      kv(
        'PAN of vendor',
        po.vendor.businessPan ?? po.vendor.pan ?? '—',
        'PO type',
        `${po.poType}${po.isSpotBuy ? ' (spot buy)' : ''}`,
      );
      kv(
        'MSME',
        po.vendor.isMsme ? `Yes · ${po.vendor.udyamNumber ?? 'Udyam registered'}` : 'No',
        'Currency',
        currency,
      );
      kv(
        // The registration this order is billed under, not the tenant-level
        // field: with a GSTIN per state, only the billing branch's number is
        // the right one to print.
        'GSTIN of company',
        plant?.gstin ?? '—',
        'Total order value',
        `${currency} ${money(tax.total)}`,
      );
      kv(
        'Payment terms',
        paymentLabel,
        'Expected delivery',
        fmtDate(po.expectedDeliveryDate ?? po.expectedAt),
      );
      kv(
        'Incoterm',
        po.deliveryTerms ?? 'DDP',
        'Tax treatment',
        taxKindLabel(tax.taxKind),
      );
      // The buyer's PAN — vendors need it to claim credit for the TDS deducted
      // against this order. Paired with the branch, so the document says in one
      // row who is buying and under which registration.
      kv('PAN of company', po.tenant.pan ?? '—', 'Billing branch', plant?.name ?? '—');

      // ── Addresses ─────────────────────────────────────────────────────
      const halfW = CONTENT_W / 2;
      drawRow(
        [
          cell(halfW, [label('Bill to (GST registration)')], SOFT_FILL),
          cell(halfW, [label('Ship to / delivery address')], SOFT_FILL),
        ],
        15,
      );
      drawRow(
        [
          cell(
            halfW,
            billingLines.map((t, i) => value(t, i === 0)),
          ),
          cell(halfW, [
            ...deliveryLines.map((t, i) => value(t, i === 0)),
            {
              text: `Expected: ${fmtDate(po.expectedDeliveryDate ?? po.expectedAt)}`,
              size: 7.5,
              color: MUTED,
            },
            ...(shipToElsewhere
              ? [
                  {
                    text: 'Bill-to / ship-to supply — place of supply is the billing registration above (IGST Act s.10(1)(b)).',
                    size: 7,
                    color: MUTED,
                  },
                ]
              : []),
          ]),
        ],
        46,
      );

      // ── Item table ────────────────────────────────────────────────────
      const wSr = 30;
      const wHsn = 48;
      const wUom = 32;
      const wQty = 50;
      const wRate = 62;
      const wTaxPct = 34;
      const wTotal = 72;
      const wDesc = CONTENT_W - (wSr + wHsn + wUom + wQty + wRate + wTaxPct + wTotal);

      const head = (text: string, w: number, align?: Frag['align']): Cell =>
        cell(w, [{ text, bold: true, size: 7.5, align }], HEAD_FILL);
      const itemHeader = (): void =>
        drawRow(
          [
            head('Sr. no', wSr),
            head('HSN code', wHsn),
            head('Description', wDesc),
            head('UOM', wUom),
            head('Quantity', wQty, 'right'),
            head('Unit price', wRate, 'right'),
            head('Tax %', wTaxPct, 'right'),
            head('Total value', wTotal, 'right'),
          ],
          16,
        );

      ensure(60);
      itemHeader();

      let qtySum = new Decimal(0);
      for (const l of po.lines) {
        const taxable = new Decimal(l.qtyOrdered.toString())
          .times(l.unitPrice.toString())
          .times(new Decimal(1).minus(l.discountPct.toString()));
        qtySum = qtySum.plus(l.qtyOrdered.toString());
        const discount = new Decimal(l.discountPct.toString());
        const cells = [
          cell(wSr, [{ text: String(l.lineNo), align: 'center' }]),
          cell(wHsn, [{ text: l.hsnCode ?? '—' }]),
          cell(wDesc, [
            value(l.itemDesc),
            ...(discount.gt(0)
              ? [
                  {
                    text: `Discount ${discount.times(100).toDecimalPlaces(2).toString()}%`,
                    size: 7,
                    color: MUTED,
                  },
                ]
              : []),
          ]),
          cell(wUom, [{ text: l.uom }]),
          cell(wQty, [{ text: qtyText(l.qtyOrdered), align: 'right' }]),
          cell(wRate, [{ text: money(l.unitPrice.toString()), align: 'right' }]),
          cell(wTaxPct, [
            {
              text: new Decimal(l.taxRate.toString()).times(100).toFixed(2),
              align: 'right',
            },
          ]),
          cell(wTotal, [{ text: money(taxable), align: 'right' }]),
        ];
        ensure(
          cells.reduce((m, c) => Math.max(m, cellHeight(c)), 16),
          itemHeader,
        );
        drawRow(cells, 16);
      }

      // Sub-total strip: the item column values are net of tax, so this ties
      // straight into the tax block below.
      ensure(80);
      drawRow(
        [
          cell(
            wSr + wHsn + wDesc + wUom,
            [{ text: 'SUB - TOTAL', bold: true, align: 'right' }],
            HEAD_FILL,
          ),
          cell(wQty, [{ text: qtyText(qtySum), bold: true, align: 'right' }], HEAD_FILL),
          cell(wRate + wTaxPct, [{ text: '' }], HEAD_FILL),
          cell(
            wTotal,
            [{ text: money(tax.subtotal), bold: true, align: 'right' }],
            HEAD_FILL,
          ),
        ],
        16,
      );

      // ── Tax summary ───────────────────────────────────────────────────
      const wTaxDesc = wSr + wHsn + wDesc + wUom + wQty;
      const wTaxRate = wRate + wTaxPct;
      drawRow(
        [
          cell(wTaxDesc, [{ text: 'Description', bold: true, size: 7.5 }], SOFT_FILL),
          cell(
            wTaxRate,
            [{ text: 'Percentage', bold: true, size: 7.5, align: 'right' }],
            SOFT_FILL,
          ),
          cell(
            wTotal,
            [{ text: 'Total value', bold: true, size: 7.5, align: 'right' }],
            SOFT_FILL,
          ),
        ],
        15,
      );

      const taxRow = (desc: string, pct: string, amount: string): void =>
        drawRow(
          [
            cell(wTaxDesc, [{ text: desc }]),
            cell(wTaxRate, [{ text: pct, align: 'right' }]),
            cell(wTotal, [{ text: amount, align: 'right' }]),
          ],
          15,
        );

      // Group taxable value by rate so a mixed-rate order shows one line per
      // slab, the way a GST-compliant order is expected to read.
      const byRate = new Map<string, Decimal>();
      for (const l of po.lines) {
        const rate = new Decimal(l.taxRate.toString());
        const taxable = new Decimal(l.qtyOrdered.toString())
          .times(l.unitPrice.toString())
          .times(new Decimal(1).minus(l.discountPct.toString()));
        const key = rate.toFixed(4);
        byRate.set(key, (byRate.get(key) ?? new Decimal(0)).plus(taxable));
      }
      const slabs = [...byRate.entries()]
        .map(([rate, taxable]) => ({ rate: new Decimal(rate), taxable }))
        .sort((a, b) => a.rate.comparedTo(b.rate));

      if (tax.taxKind === 'CGST_SGST') {
        for (const s of slabs) {
          const half = s.taxable.times(s.rate).dividedBy(2);
          taxRow('IN: Central GST', s.rate.times(50).toFixed(2), money(half));
          taxRow('IN: State GST', s.rate.times(50).toFixed(2), money(half));
        }
      } else if (tax.taxKind === 'IGST') {
        for (const s of slabs) {
          taxRow(
            'IN: Integrated GST',
            s.rate.times(100).toFixed(2),
            money(s.taxable.times(s.rate)),
          );
        }
      } else {
        taxRow(`Tax (${taxKindLabel(tax.taxKind)})`, '—', money(tax.taxAmount));
      }

      drawRow(
        [
          cell(wTaxDesc, [{ text: 'Total order value', bold: true }], HEAD_FILL),
          cell(wTaxRate, [{ text: '' }], HEAD_FILL),
          cell(
            wTotal,
            [{ text: money(tax.total), bold: true, align: 'right' }],
            HEAD_FILL,
          ),
        ],
        16,
      );

      // ── Amount in words ───────────────────────────────────────────────
      const wWordsLab = 150;
      drawRow(
        [
          cell(wWordsLab, [
            { text: 'Total order value (in words)', bold: true, size: 7.5 },
          ]),
          cell(CONTENT_W - wWordsLab - wTotal, [
            { text: amountInWords(tax.total, currency) },
          ]),
          cell(wTotal, [{ text: money(tax.total), bold: true, align: 'right' }]),
        ],
        16,
      );

      // ── Admin-defined fields marked printable ─────────────────────────
      if (opts.customFields && opts.customFields.length > 0) {
        ensure(40);
        drawRow(
          [
            cell(
              CONTENT_W,
              [{ text: 'Additional details', bold: true, size: 9 }],
              HEAD_FILL,
            ),
          ],
          16,
        );
        const labW2 = 150;
        for (const f of opts.customFields) {
          const cells = [
            cell(labW2, [label(f.label)], SOFT_FILL),
            cell(CONTENT_W - labW2, [value(f.value)]),
          ];
          ensure(cells.reduce((m, c) => Math.max(m, cellHeight(c)), 15));
          drawRow(cells, 15);
        }
      }

      // ── Conditions ────────────────────────────────────────────────────
      const termsHeader = (): void =>
        drawRow(
          [
            cell(
              CONTENT_W,
              [{ text: 'Terms & conditions', bold: true, size: 9 }],
              HEAD_FILL,
            ),
          ],
          16,
        );
      ensure(50);
      termsHeader();

      // Terms chosen for this order (library clauses + any special conditions),
      // already ordered. DEFAULT_TERMS is the floor for POs raised before terms
      // selection existed, or where the clause library is still empty — a PO
      // must never go out to a vendor with no conditions on it at all.
      const clauses: Frag[][] =
        po.terms.length > 0
          ? po.terms.map((t, i) => [
              { text: `${i + 1}. ${t.title}`, bold: true, size: 7.5 },
              { text: t.contentText, size: 7.5, color: '#333' },
            ])
          : defaultTerms(gstStateName(plant?.stateCode)).map((t, i) => [
              { text: `${i + 1}. ${t}`, size: 7.5, color: '#333' },
            ]);

      for (const frags of clauses) {
        const c = cell(CONTENT_W, frags);
        ensure(cellHeight(c), termsHeader);
        drawRow([c], 14);
      }

      // ── Acknowledgement + signatory ───────────────────────────────────
      ensure(94);
      drawRow(
        [
          cell(halfW, [
            {
              text: 'This purchase order is acknowledged with all the terms and conditions under which it is issued.',
              size: 7.5,
              color: '#333',
              gap: 4,
            },
            value(`For ${po.vendor.name}`, true),
            { text: '', gap: 22 },
            { text: 'By', size: 7.5, color: MUTED },
            { text: 'Title', size: 7.5, color: MUTED },
            { text: 'Order acknowledgement date', size: 7.5, color: MUTED },
          ]),
          cell(halfW, [
            {
              text: `For ${po.tenant.name}`,
              bold: true,
              align: 'center',
              gap: 32,
            },
            { text: 'Authorised signatory · Procurement', align: 'center' },
            {
              text: '(Digital signature placeholder)',
              size: 7,
              color: MUTED,
              align: 'center',
            },
          ]),
        ],
        92,
      );

      // ── Footers + watermark, on every page ────────────────────────────
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i += 1) {
        doc.switchToPage(range.start + i);

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

        const fy = PAGE_H - MARGIN - 14;
        doc
          .lineWidth(0.5)
          .strokeColor('#bbbbbb')
          .moveTo(X0, fy - 5)
          .lineTo(X1, fy - 5)
          .stroke();
        doc.font(REG).fontSize(7).fillColor(MUTED);
        doc.text(`${po.number} · ${po.tenant.name} · Confidential`, X0, fy, {
          width: CONTENT_W * 0.7,
        });
        doc.text(`Page ${i + 1} of ${range.count}`, X0, fy, {
          width: CONTENT_W,
          align: 'right',
        });
      }

      doc.end();
    });
  }

  // Type helper so `render`'s `po` param is well-typed.
  private load(poId: string) {
    return this.prisma.client.purchaseOrder.findUnique({
      where: { id: poId },
      include: {
        billToPlant: true,
        vendor: {
          include: {
            contacts: { orderBy: { isPrimary: 'desc' }, take: 1 },
          },
        },
        lines: { orderBy: { lineNo: 'asc' } },
        terms: { orderBy: { orderNo: 'asc' } },
        requisition: { include: { plant: true } },
        tenant: true,
      },
    });
  }
}
