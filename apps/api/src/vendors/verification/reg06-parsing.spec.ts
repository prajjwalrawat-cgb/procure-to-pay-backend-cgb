import { describe, expect, it } from 'vitest';

import { parseKycText } from './kyc-extraction.provider';

/**
 * A real REG-06 (a Delhi proprietorship), as its text layer flattens: one run of
 * "<row number> <label> <value>" with no dependable line breaks. Every quirk
 * that broke the first pass is in here — the row numbers that trailed into the
 * legal name, and the five-part address that swallowed city, district and state.
 */
const REG06 =
  'Goods and Services Tax Government of India Form GST REG-06 [See Rule 10(1)] ' +
  'Registration Certificate Registration Number : 07BIMPY7581H1ZD ' +
  '1. Legal Name ARJUN YADAV ' +
  '2. Trade Name, if any ARJUN ENTERPRISES ' +
  '3. Additional trade names, if any ' +
  '4. Constitution of Business Proprietorship ' +
  '5. Address of Principal Place of Business ' +
  'Floor No.: FIRST FLOOR RIGHT SIDE ' +
  'Building No./Flat No.: L-2/911 ' +
  'Name Of Premises/Building: Yadav Shopping Complex ' +
  'Road/Street: NEAR SHANI BAZAR ROAD ' +
  'Locality/Sub Locality: Sangam Vihar ' +
  'City/Town/Village: New Delhi ' +
  'District: South Delhi State: Delhi PIN Code: 110062 ' +
  '6. Date of Liability 7. Period of Validity From 03/01/2024 To Not Applicable ' +
  '8. Type of Registration Regular 9. Particulars of Approving Delhi ' +
  'Signature Name Chhotey Singh Designation Sales Tax Officer Class II / AVATO ' +
  'Jurisdictional Office Delhi Date of issue of Certificate 03/01/2024';

describe('a real GST REG-06', () => {
  const parsed = parseKycText(REG06, 'GST_CERT');

  it('reads the GSTIN', () => {
    expect(parsed.gstin).toBe('07BIMPY7581H1ZD');
  });

  it('does not carry the next row number into the legal name', () => {
    expect(parsed.legalName).toBe('ARJUN YADAV');
  });

  it('keeps the trade name separate from the legal name', () => {
    expect(parsed.tradeName).toBe('ARJUN ENTERPRISES');
  });

  it('reads the constitution', () => {
    expect(parsed.constitution).toBe('Proprietorship');
  });

  it('assembles the street address without its sub-labels', () => {
    expect(parsed.addressLine1).toBe(
      'FIRST FLOOR RIGHT SIDE, L-2/911, Yadav Shopping Complex, ' +
        'NEAR SHANI BAZAR ROAD, Sangam Vihar',
    );
  });

  it('puts the city in the city field rather than the address', () => {
    expect(parsed.city).toBe('New Delhi');
    expect(parsed.addressLine1).not.toContain('New Delhi');
    expect(parsed.addressLine1).not.toContain('South Delhi');
    expect(parsed.addressLine1).not.toContain('110062');
  });

  it('reads the pincode from its own label', () => {
    expect(parsed.pincode).toBe('110062');
  });
});
