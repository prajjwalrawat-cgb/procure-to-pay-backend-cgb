import Decimal from 'decimal.js';

/**
 * Money in ProcureFlow is always Decimal (Master Context §3 rule #4).
 * Postgres stores `Decimal(18, 4)`; the API uses `Prisma.Decimal` (which is a
 * re-export of this same `decimal.js`), and the wire format is a *string* so no
 * precision is lost crossing JSON. Never use `number` for money.
 */

// 18 total digits, 4 fractional — matches the DB column precision.
Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_EVEN });

export type MoneyInput = string | number | Decimal;

export class Money {
  private readonly value: Decimal;

  private constructor(value: Decimal) {
    this.value = value;
  }

  static of(input: MoneyInput): Money {
    return new Money(new Decimal(input));
  }

  static zero(): Money {
    return new Money(new Decimal(0));
  }

  add(other: MoneyInput): Money {
    return new Money(this.value.plus(toDecimal(other)));
  }

  subtract(other: MoneyInput): Money {
    return new Money(this.value.minus(toDecimal(other)));
  }

  multiply(factor: MoneyInput): Money {
    return new Money(this.value.times(toDecimal(factor)));
  }

  /** Percentage of this amount, e.g. `.percent('0.1')` = 0.1%. */
  percent(pct: MoneyInput): Money {
    return new Money(this.value.times(toDecimal(pct)).dividedBy(100));
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  gt(other: MoneyInput): boolean {
    return this.value.greaterThan(toDecimal(other));
  }

  gte(other: MoneyInput): boolean {
    return this.value.greaterThanOrEqualTo(toDecimal(other));
  }

  /** Canonical serialization: fixed 4-dp string for the DB / wire. */
  toString(): string {
    return this.value.toFixed(4);
  }

  toDecimal(): Decimal {
    return this.value;
  }

  /** Human display for INR with grouping, e.g. "₹1,23,456.00" (Indian lakh grouping). */
  toINR(fractionDigits = 2): string {
    const fixed = this.value.toFixed(fractionDigits);
    const parts = fixed.split('.');
    const intPart = parts[0] ?? '0';
    const fracPart = parts[1];
    const sign = intPart.startsWith('-') ? '-' : '';
    const digits = intPart.replace('-', '');
    const grouped = groupIndianDigits(digits);
    const frac = fracPart ? `.${fracPart}` : '';
    return `${sign}₹${grouped}${frac}`;
  }
}

function toDecimal(input: MoneyInput): Decimal {
  return input instanceof Decimal ? input : new Decimal(input);
}

/** Indian digit grouping: last 3, then groups of 2 (12,34,56,789). */
function groupIndianDigits(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${grouped},${last3}`;
}

/** Serialize any Decimal-like money value to the canonical 4-dp string. */
export function serializeMoney(input: MoneyInput): string {
  return Money.of(input).toString();
}
