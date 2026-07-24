import { describe, expect, it } from 'vitest';

import { ONBOARDING_STEP_SCHEMAS, SaveStepInputSchema } from './vendor-onboarding';

/**
 * Regression for the onboarding step-3 500: the wizard body must be validated
 * against the schema for its specific step, not the union of all step schemas.
 */
describe('onboarding step validation — per-step, not union', () => {
  // IFSC must be exactly 11 chars; this one is 9.
  const badStep3 = {
    bankName: 'Test Bank',
    accountNumber: '933833938383',
    ifsc: 'HDF43DKKD',
    holderName: 'Prajjwal',
  };

  it('the per-step schema rejects an invalid IFSC (→ clean 422, not a 500)', () => {
    expect(ONBOARDING_STEP_SCHEMAS[3].safeParse(badStep3).success).toBe(false);
  });

  it('the per-step schema accepts a valid step-3 body', () => {
    const r = ONBOARDING_STEP_SCHEMAS[3].safeParse({ ...badStep3, ifsc: 'HDFC0001234' });
    expect(r.success).toBe(true);
  });

  it('regression: the union silently mis-parses the bad body (why per-step is required)', () => {
    const r = SaveStepInputSchema.safeParse(badStep3);
    // The union "succeeds" by falling through to step-4 → { certifications: [] },
    // dropping bankName/accountNumber/ifsc — which is what caused the 500 downstream.
    expect(r.success).toBe(true);
    expect(r.success && 'accountNumber' in r.data).toBe(false);
  });
});
