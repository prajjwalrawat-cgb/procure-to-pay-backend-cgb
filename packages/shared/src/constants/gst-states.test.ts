import { describe, expect, it } from 'vitest';

import {
  formatGstState,
  GST_STATES,
  gstStateName,
  SELECTABLE_GST_STATES,
} from './gst-states';
import { determineTaxKind } from '../tax/tax';

describe('GST state codes', () => {
  it('has no duplicate codes', () => {
    const codes = GST_STATES.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('uses 2-digit codes throughout, since that is what a GSTIN carries', () => {
    for (const s of GST_STATES) expect(s.code).toMatch(/^[0-9]{2}$/);
  });

  it('covers the codes the seeds and tax engine already rely on', () => {
    // '17' Meghalaya is the default plant state in po-document.service.ts.
    expect(gstStateName('17')).toBe('Meghalaya');
    expect(gstStateName('07')).toBe('Delhi');
    expect(gstStateName('27')).toBe('Maharashtra');
    expect(gstStateName('33')).toBe('Tamil Nadu');
  });

  it('agrees with the state code embedded in a GSTIN', () => {
    const gstin = '07AFMFS3755D1ZS';
    expect(gstStateName(gstin.slice(0, 2))).toBe('Delhi');
    // Same state as the plant → CGST+SGST; the picker's value is what decides this.
    expect(determineTaxKind({ plantStateCode: '07', vendorGstin: gstin })).toBe(
      'CGST_SGST',
    );
    expect(determineTaxKind({ plantStateCode: '17', vendorGstin: gstin })).toBe('IGST');
  });

  it('hides retired codes from pickers but still resolves their names', () => {
    expect(SELECTABLE_GST_STATES.some((s) => s.code === '28')).toBe(false);
    expect(gstStateName('28')).toBe('Andhra Pradesh (undivided)');
  });

  it('formats unknown codes without inventing a name', () => {
    expect(formatGstState('07')).toBe('07 — Delhi');
    expect(formatGstState('AB')).toBe('AB');
    expect(formatGstState(null)).toBe('—');
  });
});
