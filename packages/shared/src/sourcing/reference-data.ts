/**
 * Pure reference data for landed-cost normalisation (Slice 6, ADR-019).
 *
 * Sources:
 *  • Import duty by HSN — CBIC Customs Tariff 2025-26 (BCD + Social Welfare
 *    Surcharge, effective ad-valorem shown as a single blended %). Values are
 *    representative and MUST be re-verified against the live tariff each FY;
 *    real integration is deferred (see ADR-019 "expected update cadence").
 *  • Freight (₹/tonne) — industry-standard full-truck-load road rates to the
 *    Lumshnong plant (Meghalaya, state code 17), sampled from published
 *    aggregator benchmarks; static seed, real freight-aggregator integration
 *    (Cogoport/Freightwalla) is a later slice.
 *  • RBI reference exchange rates — RBI reference rate card as of the demo
 *    date 2026-07-15. Slice 6 uses the rate at quote-open time (ADR-019).
 *
 * All monetary values are strings (Master Context §3 rule #4) — the normaliser
 * parses them through decimal.js. No DB access; unit-tested in isolation.
 */

import type { Incoterm } from '../constants/status';

/** The demo tenant's single plant is Lumshnong (Meghalaya). */
export const DESTINATION_PLANT_STATE = '17'; // Meghalaya

/** RBI reference exchange rates → INR, as of 2026-07-15 (ADR-019). */
export const RBI_REFERENCE_RATES: Record<string, string> = {
  INR: '1',
  USD: '86.4200',
  EUR: '94.1500',
  JPY: '0.5820',
};

export const RBI_REFERENCE_DATE = '2026-07-15';

export interface FreightRate {
  /** GST state code of the quote's INCOTERM origin. */
  originState: string;
  /** Destination plant state code. */
  destinationState: string;
  mode: 'ROAD' | 'RAIL' | 'SEA';
  /** ₹ per tonne, string. */
  ratePerTonne: string;
}

/**
 * Freight matrix → ₹/tonne to Lumshnong (Meghalaya, 17). Origin keyed by the
 * GST state code of the vendor's dispatch point. ROAD is the default mode.
 */
export const FREIGHT_MATRIX: FreightRate[] = [
  { originState: '24', destinationState: '17', mode: 'ROAD', ratePerTonne: '4200' }, // Gujarat (Surat)
  { originState: '27', destinationState: '17', mode: 'ROAD', ratePerTonne: '3900' }, // Maharashtra
  { originState: '33', destinationState: '17', mode: 'ROAD', ratePerTonne: '3600' }, // Tamil Nadu (Chennai)
  { originState: '19', destinationState: '17', mode: 'ROAD', ratePerTonne: '1450' }, // West Bengal (Kolkata)
  { originState: '22', destinationState: '17', mode: 'ROAD', ratePerTonne: '2600' }, // Chhattisgarh (Bhilai)
  { originState: '08', destinationState: '17', mode: 'ROAD', ratePerTonne: '3100' }, // Rajasthan
  { originState: '17', destinationState: '17', mode: 'ROAD', ratePerTonne: '350' }, // Meghalaya (local)
  { originState: '18', destinationState: '17', mode: 'ROAD', ratePerTonne: '900' }, // Assam (Guwahati)
  { originState: '37', destinationState: '17', mode: 'SEA', ratePerTonne: '2800' }, // Andhra (Vizag) sea+road
  { originState: 'FOREIGN', destinationState: '17', mode: 'SEA', ratePerTonne: '3400' }, // any foreign port → Vizag → Lumshnong
];

/**
 * Handling + insurance rates applied on top of freight per INCOTERM step.
 * ₹/tonne flat handling; insurance as a fraction of goods value.
 */
export const HANDLING_RATE_PER_TONNE = '250'; // inbound/outbound handling, ₹/tonne
export const INSURANCE_PCT = '0.0035'; // 0.35% of goods value

export interface DutyRate {
  /** HSN chapter or 4/8-digit prefix. Longest prefix wins. */
  hsnPrefix: string;
  /** Blended effective ad-valorem import duty, as a fraction. */
  dutyPct: string;
  description: string;
}

/** Import-duty lookup by HSN prefix (CBIC tariff, blended BCD+SWS). */
export const DUTY_LOOKUP: DutyRate[] = [
  { hsnPrefix: '7325', dutyPct: '0.1925', description: 'Cast articles of iron or steel' },
  {
    hsnPrefix: '8474',
    dutyPct: '0.0770',
    description: 'Machinery for crushing/grinding, parts',
  },
  {
    hsnPrefix: '7208',
    dutyPct: '0.1540',
    description: 'Flat-rolled iron/non-alloy steel',
  },
  {
    hsnPrefix: '84',
    dutyPct: '0.0770',
    description: 'Machinery & mechanical appliances (default)',
  },
  {
    hsnPrefix: '73',
    dutyPct: '0.1540',
    description: 'Articles of iron or steel (default)',
  },
  {
    hsnPrefix: '25',
    dutyPct: '0.0550',
    description: 'Mineral products (gypsum, cement)',
  },
];

/** Longest-prefix duty lookup. Returns null for a domestic (no-duty) line. */
export function lookupDuty(hsnCode: string | null | undefined): DutyRate | null {
  if (!hsnCode) return null;
  const normalised = hsnCode.replace(/\s/g, '');
  const matches = DUTY_LOOKUP.filter((d) => normalised.startsWith(d.hsnPrefix)).sort(
    (a, b) => b.hsnPrefix.length - a.hsnPrefix.length,
  );
  return matches[0] ?? null;
}

/** Freight lookup for an origin state + mode, falling back to ROAD. */
export function lookupFreight(
  originState: string,
  mode: FreightRate['mode'] = 'ROAD',
): FreightRate | null {
  return (
    FREIGHT_MATRIX.find((f) => f.originState === originState && f.mode === mode) ??
    FREIGHT_MATRIX.find((f) => f.originState === originState) ??
    null
  );
}

/** INCOTERM cost-buildup ladder (Master Context §9 / Slice 6 §6). */
export const INCOTERM_ADDS: Record<
  Incoterm,
  Array<'freight' | 'insurance' | 'duty' | 'handling'>
> = {
  EXW: ['handling', 'freight', 'insurance', 'duty'],
  FOB: ['freight', 'insurance', 'duty'],
  CIF: ['duty'],
  DDP: [],
};
