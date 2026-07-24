import type { BankFileInput, BankFormatKey } from '../types';

/**
 * Golden-file inputs (Slice 3). Each is rendered once by `generate-golden.ts`
 * into `golden/<name>.json` and committed; the golden test re-renders and asserts
 * byte-for-byte equality, so any change to a formatter's output fails CI.
 */
export interface GoldenFixture {
  name: string;
  formatKey: BankFormatKey;
  input: BankFileInput;
}

const META = {
  runNumber: 'PR-260614-01',
  cycleDate: '2026-06-14T00:00:00.000Z',
  tenantCode: 'STAR01',
  debitAccountLast4: '7890',
  debitIfsc: 'HDFC0000234',
  holderName: 'Star Cement Ltd',
};

function meta(over: Partial<typeof META>): typeof META {
  return { ...META, ...over };
}

const PATEL = {
  beneficiaryName: 'Patel Engineering',
  beneficiaryAccount: '50100234567890',
  ifsc: 'HDFC0000123',
  amount: '18900.0000',
  ref: 'INV-4408',
  narration: 'NEFT PR-260614-01',
};
const SAURA = {
  beneficiaryName: 'Saurashtra Refractories',
  beneficiaryAccount: '50200111222333',
  ifsc: 'SBIN0004321',
  amount: '12500.5000',
  ref: 'INV-4409',
  narration: 'NEFT',
};
const TATA = {
  beneficiaryName: 'Tata Steel Long Products',
  beneficiaryAccount: '911020055500123',
  ifsc: 'ICIC0000505',
  amount: '9999.9900',
  ref: 'INV-4410',
  narration: 'NEFT',
};
// Deliberately dirty fields — commas/pipes that must be sanitized out.
const VISHK = {
  beneficiaryName: 'Vishakha Plastics,Pvt Ltd',
  beneficiaryAccount: '50100999888777',
  ifsc: 'HDFC0000123',
  amount: '1000.0000',
  ref: 'INV-4411',
  narration: 'Urgent|NEFT',
};

const THREE = [
  { ...PATEL, amount: '100.0000', ref: 'INV-A' },
  { ...SAURA, amount: '250.2500', ref: 'INV-B' },
  { ...TATA, amount: '49.7500', ref: 'INV-C' },
];
const BIG = [
  { ...PATEL, amount: '1000000.0000', ref: 'INV-D' },
  { ...SAURA, amount: '2000000.0000', ref: 'INV-E' },
  { ...TATA, amount: '3000000.5000', ref: 'INV-F' },
  { ...VISHK, amount: '999999.5000', ref: 'INV-G' },
];

const CASES: Array<{ name: string; input: BankFileInput }> = [
  { name: 'single', input: { meta: META, payees: [PATEL] } },
  {
    name: 'two-payees',
    input: { meta: meta({ runNumber: 'PR-260614-02' }), payees: [SAURA, TATA] },
  },
  {
    name: 'sanitize',
    input: { meta: meta({ runNumber: 'PR-260614-03' }), payees: [VISHK] },
  },
  {
    name: 'three-payees',
    input: { meta: meta({ runNumber: 'PR-260614-04' }), payees: THREE },
  },
  {
    name: 'large-batch',
    input: { meta: meta({ runNumber: 'PR-260614-05' }), payees: BIG },
  },
];

const FORMATS: BankFormatKey[] = ['NEFT_BULK', 'ICICI_CINB', 'SBI_CINB'];

export const GOLDEN_FIXTURES: GoldenFixture[] = FORMATS.flatMap((formatKey) =>
  CASES.map((c) => ({ name: `${formatKey}-${c.name}`, formatKey, input: c.input })),
);
