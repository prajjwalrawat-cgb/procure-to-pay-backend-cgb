import { describe, expect, it } from 'vitest';

import {
  STOCK_TXN_TYPE,
  categoryPrefix,
  directionFor,
  formatProductCode,
} from './inventory-status';

describe('directionFor', () => {
  it('makes every inward type positive and every outward type negative', () => {
    expect(directionFor('VENDOR_INWARD', 10)).toBe(1);
    expect(directionFor('SAMPLE_INWARD', 10)).toBe(1);
    expect(directionFor('INTERNAL_RETURN', 10)).toBe(1);
    expect(directionFor('CUSTOMER_RETURN_IN', 10)).toBe(1);

    expect(directionFor('VENDOR_RETURN_OUT', 10)).toBe(-1);
    expect(directionFor('INTERNAL_ISSUE', 10)).toBe(-1);
    expect(directionFor('CUSTOMER_ORDER_OUT', 10)).toBe(-1);
    expect(directionFor('DAMAGE_WRITE_OFF', 10)).toBe(-1);
  });

  it('ignores the caller-supplied sign for non-ADJUSTMENT types', () => {
    // A caller must never be able to turn a receipt into a withdrawal.
    expect(directionFor('VENDOR_INWARD', -10)).toBe(1);
    expect(directionFor('CUSTOMER_ORDER_OUT', -10)).toBe(-1);
  });

  it('takes the sign from the quantity for ADJUSTMENT only', () => {
    expect(directionFor('ADJUSTMENT', 950)).toBe(1); // opening stock
    expect(directionFor('ADJUSTMENT', -12)).toBe(-1); // stock-count shortfall
    expect(directionFor('ADJUSTMENT', 0)).toBe(1);
  });

  it('covers every declared txn type', () => {
    for (const t of STOCK_TXN_TYPE) {
      expect([1, -1]).toContain(directionFor(t, 1));
    }
  });
});

describe('categoryPrefix', () => {
  it('uses the curated table for the categories seen in the source workbook', () => {
    expect(categoryPrefix('Home Decor')).toBe('HD');
    expect(categoryPrefix('home decor')).toBe('HD');
    expect(categoryPrefix('  Stationery ')).toBe('ST');
    expect(categoryPrefix('Rainwear')).toBe('RW');
    expect(categoryPrefix('Box')).toBe('BX');
  });

  it('maps the migration backfill category to UC', () => {
    expect(categoryPrefix('Uncategorized')).toBe('UC');
  });

  it('derives initials for unknown multi-word categories', () => {
    expect(categoryPrefix('Garden Furniture')).toBe('GF');
    expect(categoryPrefix('Personal Care Products')).toBe('PCP');
  });

  it('derives a padded prefix for unknown single-word categories', () => {
    expect(categoryPrefix('Toys')).toBe('TOY');
    expect(categoryPrefix('Ai')).toBe('AI');
  });

  it('never returns an empty prefix for junk input', () => {
    expect(categoryPrefix('')).toBe('UC');
    expect(categoryPrefix('   ')).toBe('UC');
    expect(categoryPrefix('!!!')).toBe('UC');
  });
});

describe('formatProductCode', () => {
  it('zero-pads the sequence to six digits', () => {
    expect(formatProductCode('HD', 123)).toBe('HD-000123');
    expect(formatProductCode('UC', 1)).toBe('UC-000001');
    expect(formatProductCode('ST', 625)).toBe('ST-000625');
  });

  it('does not truncate sequences beyond six digits', () => {
    expect(formatProductCode('HD', 1_234_567)).toBe('HD-1234567');
  });
});
