/** Supported currencies. v1 is INR-only but the column exists tenant-wide. */
export const CURRENCIES = ['INR', 'USD', 'EUR'] as const;
export type CurrencyCode = (typeof CURRENCIES)[number];

export const DEFAULT_CURRENCY: CurrencyCode = 'INR';

/** India-specific defaults (Master Context §4 tenant provisioning, §9). */
export const INDIA_DEFAULTS = {
  MSME_PAYMENT_CAP_DAYS: 45,
  TDS_194Q_RATE: 0.001, // 0.1%
  TDS_194Q_THRESHOLD: 5_000_000, // ₹50L cumulative to same vendor in FY
  EWAY_BILL_THRESHOLD: 50_000, // ₹50K interstate goods movement
} as const;

/** 3-way match tolerances (Master Context §9), tenant-overridable later. */
export const MATCH_TOLERANCES = {
  PRICE_VARIANCE_PCT: 0.005, // ±0.5%
  QTY_VARIANCE_PCT: 0.02, // ±2%
  QTY_VARIANCE_ABS: 1, // or 1 unit, whichever greater
  TAX_VARIANCE: 0, // exact
} as const;
