import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';

import {
  DUPLICATE_WINDOW_DAYS,
  duplicateWindowStart,
  lineFingerprint,
} from './duplicate-po';

const line = (itemDesc: string, qtyOrdered: string) => ({ itemDesc, qtyOrdered });

describe('lineFingerprint', () => {
  it('matches the same lines keyed in a different case', () => {
    // The pair that prompted this: PO-0504 was typed in caps, PO-0507 was not.
    expect(lineFingerprint([line('SLEEVES', '200')])).toBe(
      lineFingerprint([line('Sleeves', '200')]),
    );
  });

  it('matches through stray whitespace', () => {
    expect(lineFingerprint([line('  packaging   cover ', '200')])).toBe(
      lineFingerprint([line('packaging cover', '200')]),
    );
  });

  it('matches regardless of the order the lines were entered in', () => {
    const a = [line('Sleeves', '200'), line('mousepad', '200')];
    const b = [line('mousepad', '200'), line('Sleeves', '200')];
    expect(lineFingerprint(a)).toBe(lineFingerprint(b));
  });

  it('treats 200 and 200.0000 as the same quantity', () => {
    expect(lineFingerprint([line('Sleeves', '200')])).toBe(
      lineFingerprint([{ itemDesc: 'Sleeves', qtyOrdered: new Decimal('200.0000') }]),
    );
  });

  it('separates a differing quantity', () => {
    expect(lineFingerprint([line('Sleeves', '200')])).not.toBe(
      lineFingerprint([line('Sleeves', '250')]),
    );
  });

  it('separates an extra line', () => {
    expect(lineFingerprint([line('Sleeves', '200')])).not.toBe(
      lineFingerprint([line('Sleeves', '200'), line('labels', '50')]),
    );
  });

  it('does not let a description run into the quantity of the next line', () => {
    // Without a separator, ["ab", "1"] and ["a", "b1"] would collide.
    expect(lineFingerprint([line('ab', '1')])).not.toBe(
      lineFingerprint([line('a', 'b1')]),
    );
  });

  it('keeps genuinely different items apart', () => {
    expect(lineFingerprint([line('mousepad', '200')])).not.toBe(
      lineFingerprint([line('mouse pad pro', '200')]),
    );
  });
});

describe('duplicateWindowStart', () => {
  it('reaches back exactly the window', () => {
    const now = new Date('2026-09-04T00:00:00.000Z');
    const start = duplicateWindowStart(now);
    const days = (now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(DUPLICATE_WINDOW_DAYS);
  });
});
