import { describe, expect, it } from 'vitest';

import {
  UNASSIGNED_LOCATION,
  canonicalLocation,
  extractInlineLocationQty,
  extractQty,
  extractRackOrCarton,
  parseLocations,
} from './legacy-location.parser';

/**
 * Every string in these tests is copied verbatim from the source workbook, so
 * the parser is pinned against the real data rather than idealised input.
 */

describe('canonicalLocation', () => {
  it('normalises the sheet own misspelling of Conference Room', () => {
    expect(canonicalLocation('Confrance Room')).toBe('Conference Room');
    expect(canonicalLocation('Confrance room')).toBe('Conference Room');
    expect(canonicalLocation('Conference Room')).toBe('Conference Room');
  });

  it('recognises Store in any case', () => {
    expect(canonicalLocation('Store')).toBe('Store');
    expect(canonicalLocation('store')).toBe('Store');
  });

  it('recognises the -B2 basement location', () => {
    expect(canonicalLocation('-B2')).toBe('-B2');
    expect(canonicalLocation(' -B2 ')).toBe('-B2');
  });

  it('returns null for blanks and N/A', () => {
    expect(canonicalLocation('')).toBeNull();
    expect(canonicalLocation('N/A')).toBeNull();
    expect(canonicalLocation('   ')).toBeNull();
  });

  it('returns null for an unrecognised place', () => {
    expect(canonicalLocation('Warehouse 7')).toBeNull();
  });
});

describe('extractQty', () => {
  it.each([
    ['Qty-750', 750],
    ['Qty.-200', 200],
    ['750pcs', 750],
    ['20 pcs', 20],
    ['01 Nos', 1],
    ['(238)', 238],
  ])('reads %s as %i', (input, expected) => {
    expect(extractQty(input)).toBe(expected);
  });

  it('reads "pic", the sheet own misspelling of pcs', () => {
    expect(extractQty('14 pic store me')).toBe(14);
  });

  it('returns null when no quantity is present', () => {
    expect(extractQty('Total Carton -6')).toBeNull();
    expect(extractQty('Almirah')).toBeNull();
  });
});

describe('extractInlineLocationQty', () => {
  it('reads a bare trailing quantity off a Location cell', () => {
    expect(extractInlineLocationQty('Confrance Room-600')).toBe(600);
    expect(extractInlineLocationQty('-B2-205')).toBe(205);
  });

  it('does not mistake the -B2 location itself for a quantity', () => {
    expect(extractInlineLocationQty('-B2')).toBeNull();
  });

  it('ignores single-digit suffixes so "Carton-3" is never read as a quantity', () => {
    expect(extractInlineLocationQty('Total Carton-3')).toBeNull();
  });

  it('only matches at the end of the fragment', () => {
    expect(extractInlineLocationQty('Room-600 and more text')).toBeNull();
  });
});

describe('extractRackOrCarton', () => {
  it.each([
    ['Total Carton -3, Qty-750', 'Carton-3'],
    ['carton no.-14 Qty.-200', 'Carton-14'],
    ['Rack-6', 'Rack-6'],
    ['R-8', 'Rack-8'],
    ['Rack-5  (Chaina Product Carton)', 'Rack-5'],
  ])('reads %s as %s', (input, expected) => {
    expect(extractRackOrCarton(input)).toBe(expected);
  });

  it('recognises the named storage spots the sheet uses', () => {
    expect(extractRackOrCarton('Almirah')).toBe('Almirah');
    expect(extractRackOrCarton('Big Suitcase')).toBe('Big Suitcase');
  });

  it('returns null when nothing is designated', () => {
    expect(extractRackOrCarton('')).toBeNull();
  });
});

describe('parseLocations — single location', () => {
  it('puts the whole quantity in the only named location', () => {
    const r = parseLocations('Store', 'Rack-6', 950);
    expect(r.needsReview).toBe(false);
    expect(r.placements).toEqual([
      { locationName: 'Store', rackOrCarton: 'Rack-6', qty: 950 },
    ]);
  });

  it('does not attempt to split a descriptive rack note', () => {
    // "Total Carton-4" describes packing, it is not a location split.
    const r = parseLocations('Confrance Room', 'Total Carton-4', 236);
    expect(r.needsReview).toBe(false);
    expect(r.placements[0]).toMatchObject({
      locationName: 'Conference Room',
      rackOrCarton: 'Carton-4',
      qty: 236,
    });
  });

  it('flags a row whose inline quantity disagrees with Current Stock', () => {
    const r = parseLocations('Confrance Room-600', '', 236);
    expect(r.needsReview).toBe(true);
    expect(r.reviewReason).toMatch(/says 600 but Current Stock is 236/);
  });
});

describe('parseLocations — multi-location splits', () => {
  it('resolves a parenthesised two-location split that adds up', () => {
    // Master Inventory Sheet row 3: Candle Holder.
    const r = parseLocations(
      'Confrance Room & Store',
      '(Confrance Room Me Toal Carton -3, Qty-750) (Store me Mandir ke samne carton no.-14 Qty.-200)',
      950,
    );
    expect(r.needsReview).toBe(false);
    expect(r.placements).toEqual([
      { locationName: 'Conference Room', rackOrCarton: 'Carton-3', qty: 750 },
      { locationName: 'Store', rackOrCarton: 'Carton-14', qty: 200 },
    ]);
  });

  it('resolves an "and"-separated split that adds up', () => {
    // Aura Decor Jasmine (Extra Large): 20 + 14 = 34.
    const r = parseLocations(
      'Confrance Room & Store',
      'Total Carton-1, 20 pcs cofrance me and 14 pic store me',
      34,
    );
    expect(r.needsReview).toBe(false);
    expect(r.placements.map((p) => p.qty)).toEqual([20, 14]);
  });

  it('flags a split whose parts do not reconcile with Current Stock', () => {
    const r = parseLocations(
      'Confrance Room & Store',
      '(Confrance Room Me Carton-3, Qty-750) (Store me Qty.-200)',
      1000, // 750 + 200 = 950, not 1000
    );
    expect(r.needsReview).toBe(true);
    expect(r.reviewReason).toMatch(/total 950 but Current Stock is 1000/);
  });

  it('never loses units when a split cannot be proven', () => {
    const r = parseLocations('Confrance Room & -B2', 'Total Carton-12 & 150pcs -B2 me hai', 400);
    expect(r.needsReview).toBe(true);
    // The full quantity still lands somewhere rather than being dropped.
    expect(r.placements.reduce((s, p) => s + (p.qty ?? 0), 0)).toBe(400);
  });

  it('flags when a location gets no attributable quantity', () => {
    const r = parseLocations('Confrance Room & Store', 'Total Carton -6', 805);
    expect(r.needsReview).toBe(true);
    expect(r.reviewReason).toMatch(/Could not attribute a quantity/);
  });
});

describe('parseLocations — unusable input', () => {
  it('parks an unrecognised location in Unassigned and flags it', () => {
    const r = parseLocations('Warehouse 7', '', 50);
    expect(r.placements[0]).toMatchObject({
      locationName: UNASSIGNED_LOCATION,
      qty: 50,
    });
    expect(r.needsReview).toBe(true);
    expect(r.reviewReason).toMatch(/Unrecognised location/);
  });

  it('parks a blank location in Unassigned and flags it', () => {
    const r = parseLocations('', '', 12);
    expect(r.placements[0]?.locationName).toBe(UNASSIGNED_LOCATION);
    expect(r.reviewReason).toMatch(/No location recorded/);
  });

  it('treats N/A as no location', () => {
    const r = parseLocations('N/A', '', 0);
    expect(r.placements[0]?.locationName).toBe(UNASSIGNED_LOCATION);
    expect(r.needsReview).toBe(true);
  });

  it('always returns at least one placement', () => {
    for (const [loc, rack, qty] of [
      ['', '', 0],
      ['???', 'nonsense', 5],
      ['Store', '', 0],
    ] as [string, string, number][]) {
      expect(parseLocations(loc, rack, qty).placements.length).toBeGreaterThan(0);
    }
  });
});
