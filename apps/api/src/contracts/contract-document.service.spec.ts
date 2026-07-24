import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import Decimal from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';

import { PrismaService } from '../prisma/prisma.service';
import { ContractDocumentService } from './contract-document.service';

const GOLDEN = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'db',
  'fixtures',
  'contract-coal-transport-golden.pdf',
);

/** A fixed coal-transport contract payload (matches the Slice 9 seed shape). */
function coalContract() {
  const start = new Date('2026-04-01T00:00:00.000Z');
  const end = new Date('2028-03-31T00:00:00.000Z');
  const rate = (
    lineNo: number,
    year: number,
    origin: string,
    dest: string,
    rate: string,
  ) => ({
    lineNo,
    itemId: null,
    itemDesc: `Coal haulage ${origin}→${dest}`,
    uom: 'tonne-km',
    rateYear: year,
    unitRate: new Decimal(rate),
    taxRate: new Decimal('0.05'),
    volumeBandMin: null,
    volumeBandMax: null,
    routeOrigin: origin,
    routeDest: dest,
    effectiveFrom: start,
    effectiveTo: end,
  });
  const clause = (
    clauseType: string,
    title: string,
    text: string,
    mandatory: boolean,
    order: number,
  ) => ({
    clauseType,
    title,
    contentText: text,
    isMandatory: mandatory,
    orderNo: order,
  });
  return {
    id: 'ct_coal',
    number: 'CT-2026-0001',
    title: 'Annual coal transport — Lumshnong routes',
    contractType: 'RATE_CONTRACT',
    category: 'Logistics',
    validityStart: start,
    validityEnd: end,
    commitmentPeriod: 'ANNUAL',
    commitmentUom: 'tonne-km',
    minimumCommitmentQty: new Decimal('240000'),
    minimumCommitmentValue: new Decimal('9000000'),
    paymentTermsSnapshot: { kind: 'NET_30' },
    tenant: { name: 'Star Cement Ltd', gstin: '17AAACS1234M1Z9' },
    vendor: {
      name: 'Northeast Logistics',
      gstin: '17AABCN1111Q1Z5',
      isMsme: false,
      udyamNumber: null,
    },
    rateCards: [
      rate(1, 1, 'Lumshnong', 'Guwahati depot', '2.85'),
      rate(2, 1, 'Lumshnong', 'Shillong yard', '2.40'),
      rate(1, 2, 'Lumshnong', 'Guwahati depot', '3.05'),
      rate(2, 2, 'Lumshnong', 'Shillong yard', '2.60'),
    ],
    clauses: [
      clause(
        'PAYMENT_TERMS',
        'Payment terms — Net 30',
        'Payment within 30 days.',
        true,
        0,
      ),
      clause('DELIVERY_SLA', 'Delivery SLA', 'OTIF ≥ 95% per quarter.', true, 1),
      clause('TERMINATION', 'Termination', '30 days notice.', true, 2),
    ],
  };
}

function build() {
  const client = {
    contract: { findUnique: vi.fn().mockResolvedValue(coalContract()) },
  };
  const prisma = { client } as unknown as PrismaService;
  return new ContractDocumentService(prisma);
}

describe('ContractDocumentService.generate', () => {
  it('produces a valid, hashable PDF', async () => {
    const { buffer, hash } = await build().generate('ct_coal');
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(1000);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is byte-stable against the golden fixture (deterministic mode)', async () => {
    const { buffer } = await build().generate('ct_coal', { deterministic: true });
    if (!existsSync(GOLDEN)) {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, buffer);
    }
    expect(buffer.equals(readFileSync(GOLDEN))).toBe(true);
  });

  it('a watermark changes the bytes', async () => {
    const plain = await build().generate('ct_coal', { deterministic: true });
    const marked = await build().generate('ct_coal', {
      deterministic: true,
      watermark: 'DRAFT',
    });
    expect(marked.buffer.equals(plain.buffer)).toBe(false);
  });
});
