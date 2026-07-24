import { describe, expect, it } from 'vitest';

import {
  computeSubmissionHash,
  shortHash,
  watermarkSeed,
  type QuoteSealInput,
} from './submission-hash';

const base: QuoteSealInput = {
  rfqId: 'rfq_1',
  invitationId: 'inv_1',
  vendorId: 'ven_1',
  quoteNo: 'Q-001',
  envelopeType: 'COMBINED',
  currency: 'INR',
  incoterm: 'DDP',
  validityDays: 30,
  paymentTermsOffered: 'NET_45',
  revisionNo: 0,
  lines: [
    {
      rfqLineId: 'rfql_1',
      qtyQuoted: '24',
      unitPriceNative: '22400',
      discountPct: '0',
      taxRate: '0.18',
      lineTotalNative: '634368',
      deliveryLeadDays: 42,
      specCompliance: 'PARTIAL',
      deviationNotes: 'Hardness 58-62 HRC',
    },
  ],
  attachmentHashes: ['abc', 'def'],
};

describe('computeSubmissionHash', () => {
  it('produces a 64-char hex digest', () => {
    const h = computeSubmissionHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic and order-independent for attachments', () => {
    const a = computeSubmissionHash(base);
    const b = computeSubmissionHash({ ...base, attachmentHashes: ['def', 'abc'] });
    expect(a).toBe(b);
  });

  it('changes when a price changes (tamper-evident)', () => {
    const a = computeSubmissionHash(base);
    const tampered = computeSubmissionHash({
      ...base,
      lines: [{ ...base.lines[0]!, unitPriceNative: '22300' }],
    });
    expect(a).not.toBe(tampered);
  });

  it('changes when revision number changes', () => {
    expect(computeSubmissionHash(base)).not.toBe(
      computeSubmissionHash({ ...base, revisionNo: 1 }),
    );
  });
});

describe('shortHash', () => {
  it('formats as first4…last4', () => {
    expect(
      shortHash('8f3a0000000000000000000000000000000000000000000000000000000c2e1a'),
    ).toBe('8f3a…2e1a');
  });
});

describe('watermarkSeed', () => {
  it('is deterministic per (rfq, invitation)', () => {
    expect(watermarkSeed('rfq_1', 'inv_1')).toBe(watermarkSeed('rfq_1', 'inv_1'));
    expect(watermarkSeed('rfq_1', 'inv_1')).not.toBe(watermarkSeed('rfq_1', 'inv_2'));
  });
});
