/**
 * LandedCostNormaliser (Slice 6 §6, ADR-019) — pure, no DB writes.
 *
 * Normalises a quote line quoted in an arbitrary currency + INCOTERM to a
 * common landed-at-Lumshnong INR unit price so vendors are compared
 * apples-to-apples. The cost buildup follows the INCOTERM ladder:
 *
 *   EXW → outbound handling + freight + insurance + duty + inbound handling
 *   FOB → freight + insurance + duty + inbound handling
 *   CIF → duty + inbound handling
 *   DDP → no adjustment (already landed)
 *
 * Duty is levied on the CIF-equivalent assessable value (goods + any freight +
 * insurance that had to be added to reach a CIF basis). Returns a full
 * breakdown for traceability in the comparison matrix and award PDF.
 */

import Decimal from 'decimal.js';

import type { Incoterm } from '../constants/status';
import {
  HANDLING_RATE_PER_TONNE,
  INSURANCE_PCT,
  lookupDuty,
  lookupFreight,
  type DutyRate,
  type FreightRate,
} from './reference-data';

export class MissingExchangeRateError extends Error {
  constructor(public readonly currency: string) {
    super(`No RBI reference rate seeded for currency ${currency}.`);
    this.name = 'MissingExchangeRateError';
  }
}

export class MissingFreightRateError extends Error {
  constructor(public readonly originState: string) {
    super(`No freight rate seeded for origin state ${originState}.`);
    this.name = 'MissingFreightRateError';
  }
}

export class InvalidHsnError extends Error {
  constructor(public readonly hsnCode: string | null | undefined) {
    super(`No import-duty rate found for HSN ${hsnCode ?? '(none)'}.`);
    this.name = 'InvalidHsnError';
  }
}

export interface NormaliseLineInput {
  unitPriceNative: string;
  currency: string;
  incoterm: Incoterm;
  /** GST state code of the INCOTERM origin, or 'FOREIGN' for imports. */
  originState: string;
  hsnCode?: string | null;
  /** Unit weight (kg) used for per-tonne freight + handling. Default 0. */
  unitWeightKg?: string;
  freightMode?: FreightRate['mode'];
}

export interface NormaliseContext {
  /** Currency → INR reference rate. */
  exchangeRates: Record<string, string>;
  targetCurrency?: string;
  targetIncoterm?: Incoterm;
  destinationState?: string;
}

export interface LandedCostBreakdown {
  goodsInr: string;
  exchangeRate: string;
  outboundHandling: string;
  freight: string;
  insurance: string;
  dutyBase: string;
  dutyPct: string;
  duty: string;
  inboundHandling: string;
  unitPriceInrLanded: string;
}

export interface LandedCostResult {
  unitPriceInrLanded: string;
  breakdown: LandedCostBreakdown;
}

const ZERO = new Decimal(0);

function tonnes(unitWeightKg: string | undefined): Decimal {
  return new Decimal(unitWeightKg ?? '0').dividedBy(1000);
}

/**
 * Normalise one quote line to landed-at-destination INR.
 * @throws MissingExchangeRateError when the currency has no seeded rate.
 * @throws MissingFreightRateError when freight is required but no rate matches.
 * @throws InvalidHsnError when duty is required but the HSN resolves nothing.
 */
export function normalise(
  line: NormaliseLineInput,
  ctx: NormaliseContext,
): LandedCostResult {
  const rateStr = ctx.exchangeRates[line.currency];
  if (rateStr === undefined) throw new MissingExchangeRateError(line.currency);
  const rate = new Decimal(rateStr);

  const goodsInr = new Decimal(line.unitPriceNative).times(rate);
  const wtTonnes = tonnes(line.unitWeightKg);
  const handlingPerTonne = new Decimal(HANDLING_RATE_PER_TONNE);
  const handlingUnit = handlingPerTonne.times(wtTonnes);

  const addsFreight = line.incoterm === 'EXW' || line.incoterm === 'FOB';
  const addsInsurance = addsFreight;
  const addsDuty = line.incoterm !== 'DDP';
  const outboundHandling = line.incoterm === 'EXW' ? handlingUnit : ZERO;
  const inboundHandling = line.incoterm === 'DDP' ? ZERO : handlingUnit;

  let freight = ZERO;
  if (addsFreight && wtTonnes.greaterThan(0)) {
    const fr = lookupFreight(line.originState, line.freightMode ?? 'ROAD');
    if (!fr) throw new MissingFreightRateError(line.originState);
    freight = new Decimal(fr.ratePerTonne).times(wtTonnes);
  }

  const insurance = addsInsurance ? goodsInr.times(INSURANCE_PCT) : ZERO;

  // Duty is on the CIF-equivalent assessable value.
  let dutyBase = ZERO;
  let dutyPct = ZERO;
  let duty = ZERO;
  if (addsDuty) {
    const dutyRate = lookupDuty(line.hsnCode);
    if (!dutyRate) throw new InvalidHsnError(line.hsnCode);
    dutyPct = new Decimal(dutyRate.dutyPct);
    dutyBase = goodsInr.plus(freight).plus(insurance);
    duty = dutyBase.times(dutyPct);
  }

  const landed = goodsInr
    .plus(outboundHandling)
    .plus(freight)
    .plus(insurance)
    .plus(duty)
    .plus(inboundHandling);

  return {
    unitPriceInrLanded: landed.toFixed(4),
    breakdown: {
      goodsInr: goodsInr.toFixed(4),
      exchangeRate: rate.toFixed(4),
      outboundHandling: outboundHandling.toFixed(4),
      freight: freight.toFixed(4),
      insurance: insurance.toFixed(4),
      dutyBase: dutyBase.toFixed(4),
      dutyPct: dutyPct.toFixed(4),
      duty: duty.toFixed(4),
      inboundHandling: inboundHandling.toFixed(4),
      unitPriceInrLanded: landed.toFixed(4),
    },
  };
}

/** Convenience: resolve the duty row a line would attract (for UI/preview). */
export function dutyFor(hsnCode: string | null | undefined): DutyRate | null {
  return lookupDuty(hsnCode);
}
