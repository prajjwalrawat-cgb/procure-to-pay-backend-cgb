import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import Decimal from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';

import { PrismaService } from '../prisma/prisma.service';
import { PoDocumentService } from './po-document.service';

const GOLDEN = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'db',
  'fixtures',
  'po-0481-golden.pdf',
);

/** A fixed PO-0481 payload (Patel Engineering) matching the Slice 1 seed shape. */
function po0481() {
  const line = (
    lineNo: number,
    desc: string,
    hsn: string,
    qty: string,
    price: string,
  ) => ({
    lineNo,
    itemDesc: desc,
    hsnCode: hsn,
    uom: lineNo === 3 ? 'nos' : 'tonne',
    qtyOrdered: new Decimal(qty),
    unitPrice: new Decimal(price),
    discountPct: new Decimal('0'),
    taxRate: new Decimal('0.18'),
  });
  return {
    id: 'po_0481',
    number: 'PO-0481',
    tenantId: 'ten_star',
    status: 'ISSUED',
    poType: 'STANDARD',
    createdAt: new Date('2026-06-20T00:00:00.000Z'),
    issuedAt: new Date('2026-06-22T00:00:00.000Z'),
    expectedDeliveryDate: new Date('2026-07-15T00:00:00.000Z'),
    deliveryAddr: 'Lumshnong plant, Meghalaya',
    deliveryAddress: null,
    deliveryTerms: 'DDP',
    paymentTermsSnapshot: { kind: 'MSME_45', days: 45, label: 'MSME Net 45' },
    vendor: {
      name: 'Patel Engineering',
      gstin: '24AABCP1234K1Z5',
      isMsme: true,
      udyamNumber: 'UDYAM-GJ-04-0089123',
    },
    tenant: { name: 'Star Cement Ltd', gstin: '17AAACS1234M1Z9' },
    requisition: {
      number: 'PR-1124',
      plant: {
        name: 'Lumshnong',
        address: 'Lumshnong, Meghalaya',
        stateCode: '17',
        gstin: null,
      },
    },
    lines: [
      line(1, 'Forged steel grinding balls 25mm', '7325', '8', '18900'),
      line(2, 'Cylpebs grinding media', '7325', '2', '10800'),
      line(3, 'EP2 lithium grease 15kg', '2710', '1', '8400'),
    ],
  };
}

function build() {
  const po = po0481();
  const client = {
    purchaseOrder: { findUnique: vi.fn().mockResolvedValue(po) },
    plant: { findFirst: vi.fn().mockResolvedValue(po.requisition.plant) },
  };
  const prisma = { client } as unknown as PrismaService;
  return new PoDocumentService(prisma);
}

describe('PoDocumentService', () => {
  it('renders a real binary PDF', async () => {
    const { buffer, hash } = await build().generate('po_0481');
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(1000);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is byte-stable in deterministic mode against the golden fixture', async () => {
    const { buffer } = await build().generate('po_0481', { deterministic: true });
    if (!existsSync(GOLDEN)) {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, buffer);
      // First run bootstraps the fixture; the regression is asserted thereafter.
    }
    const golden = readFileSync(GOLDEN);
    expect(buffer.equals(golden)).toBe(true);
  });

  it('adds a CANCELLED watermark when requested', async () => {
    const { buffer: plain } = await build().generate('po_0481', { deterministic: true });
    const { buffer: cancelled } = await build().generate('po_0481', {
      deterministic: true,
      watermark: 'CANCELLED',
    });
    // The watermark changes the byte stream (larger, different content).
    expect(cancelled.equals(plain)).toBe(false);
    expect(cancelled.length).toBeGreaterThan(1000);
  });
});
