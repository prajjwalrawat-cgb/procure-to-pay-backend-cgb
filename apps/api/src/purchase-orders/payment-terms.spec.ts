import { PAYMENT_TERM_KINDS, PAYMENT_TERM_LABELS } from '@procureflow/shared';
import { describe, expect, it } from 'vitest';

/**
 * The catalogue a buyer picks from. A kind with no label would print to a
 * vendor as a raw enum, so every kind must carry wording.
 */
describe('payment terms', () => {
  it('offers the terms buyers asked for', () => {
    expect(PAYMENT_TERM_KINDS).toContain('ADVANCE');
    expect(PAYMENT_TERM_KINDS).toContain('DELIVERY_7');
    expect(PAYMENT_TERM_KINDS).toContain('DELIVERY_15');
  });

  it('gives every kind printable wording', () => {
    for (const kind of PAYMENT_TERM_KINDS) {
      expect(PAYMENT_TERM_LABELS[kind]).toBeTruthy();
      expect(PAYMENT_TERM_LABELS[kind]).not.toMatch(/_/);
    }
  });

  it('keeps the existing kinds, so historic orders still resolve', () => {
    for (const kind of ['NET_30', 'NET_45', 'NET_60', 'MSME_45', 'MILESTONE'] as const) {
      expect(PAYMENT_TERM_KINDS).toContain(kind);
    }
  });
});
