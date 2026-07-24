import { describe, expect, it } from 'vitest';

import { Money, serializeMoney } from './money';

describe('Money', () => {
  it('adds without floating-point error', () => {
    expect(Money.of('0.1').add('0.2').toString()).toBe('0.3000');
  });

  it('subtracts and multiplies with fixed precision', () => {
    expect(Money.of('100').subtract('0.5').toString()).toBe('99.5000');
    expect(Money.of('12.5').multiply('4').toString()).toBe('50.0000');
  });

  it('computes percentages (TDS 194Q style)', () => {
    // 0.1% of 5,000,000 = 5000
    expect(Money.of('5000000').percent('0.1').toString()).toBe('5000.0000');
  });

  it('serializes to a 4-dp string', () => {
    expect(serializeMoney(1234.5)).toBe('1234.5000');
    expect(Money.zero().toString()).toBe('0.0000');
  });

  it('compares amounts', () => {
    expect(Money.of('10').gt('5')).toBe(true);
    expect(Money.of('5').gte('5')).toBe(true);
    expect(Money.of('-1').isNegative()).toBe(true);
    expect(Money.zero().isZero()).toBe(true);
  });

  it('formats INR with lakh grouping', () => {
    expect(Money.of('123456').toINR()).toBe('₹1,23,456.00');
    expect(Money.of('1000').toINR()).toBe('₹1,000.00');
    expect(Money.of('12345678').toINR(0)).toBe('₹1,23,45,678');
    expect(Money.of('-500').toINR()).toBe('-₹500.00');
  });
});
