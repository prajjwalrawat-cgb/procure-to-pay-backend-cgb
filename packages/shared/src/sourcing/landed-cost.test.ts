import { describe, expect, it } from 'vitest';

import {
  InvalidHsnError,
  MissingExchangeRateError,
  MissingFreightRateError,
  normalise,
  type NormaliseContext,
} from './landed-cost';
import { RBI_REFERENCE_RATES } from './reference-data';

const ctx: NormaliseContext = { exchangeRates: RBI_REFERENCE_RATES };

describe('LandedCostNormaliser.normalise', () => {
  it('INR domestic DDP → no adjustment (landed == native)', () => {
    const r = normalise(
      {
        unitPriceNative: '22400',
        currency: 'INR',
        incoterm: 'DDP',
        originState: '22',
        hsnCode: '8474',
      },
      ctx,
    );
    expect(r.unitPriceInrLanded).toBe('22400.0000');
    expect(r.breakdown.duty).toBe('0.0000');
    expect(r.breakdown.freight).toBe('0.0000');
  });

  it('INR EXW adds handling + freight + insurance + duty', () => {
    const r = normalise(
      {
        unitPriceNative: '10000',
        currency: 'INR',
        incoterm: 'EXW',
        originState: '24', // Gujarat → Meghalaya 4200/tonne
        hsnCode: '8474', // 7.7%
        unitWeightKg: '1000', // 1 tonne
      },
      ctx,
    );
    // goods 10000; freight 4200; insurance 35; handling 250 (out) + 250 (in);
    // dutyBase = 10000+4200+35 = 14235; duty = 14235 * 0.077 = 1096.095
    expect(r.breakdown.freight).toBe('4200.0000');
    expect(r.breakdown.insurance).toBe('35.0000');
    expect(r.breakdown.outboundHandling).toBe('250.0000');
    expect(r.breakdown.inboundHandling).toBe('250.0000');
    expect(r.breakdown.duty).toBe('1096.0950');
    expect(r.unitPriceInrLanded).toBe('15831.0950');
  });

  it('USD FOB with freight + duty converts at RBI rate', () => {
    const r = normalise(
      {
        unitPriceNative: '100',
        currency: 'USD', // 86.42
        incoterm: 'FOB',
        originState: 'FOREIGN',
        hsnCode: '7325', // 19.25%
        unitWeightKg: '500', // 0.5 tonne, SEA 3400/tonne → 1700
        freightMode: 'SEA',
      },
      ctx,
    );
    expect(r.breakdown.goodsInr).toBe('8642.0000');
    expect(r.breakdown.freight).toBe('1700.0000');
    // insurance = 8642 * 0.0035 = 30.247
    expect(r.breakdown.insurance).toBe('30.2470');
    // dutyBase = 8642 + 1700 + 30.247 = 10372.247; duty = *0.1925 = 1996.6575
    expect(r.breakdown.duty).toBe('1996.6575');
    // no outbound handling (FOB); inbound handling = 250*0.5 = 125
    expect(r.breakdown.inboundHandling).toBe('125.0000');
  });

  it('EUR CIF adds duty only (freight/insurance already in CIF price)', () => {
    const r = normalise(
      {
        unitPriceNative: '200',
        currency: 'EUR',
        incoterm: 'CIF',
        originState: 'FOREIGN',
        hsnCode: '84',
        unitWeightKg: '1000',
      },
      ctx,
    );
    expect(r.breakdown.freight).toBe('0.0000');
    expect(r.breakdown.insurance).toBe('0.0000');
    // goods = 200 * 94.15 = 18830; dutyBase = 18830; duty = *0.077 = 1449.91
    expect(r.breakdown.dutyBase).toBe('18830.0000');
    expect(r.breakdown.duty).toBe('1449.9100');
    expect(r.breakdown.inboundHandling).toBe('250.0000');
  });

  it('JPY EXW full landed buildup', () => {
    const r = normalise(
      {
        unitPriceNative: '50000',
        currency: 'JPY', // 0.582
        incoterm: 'EXW',
        originState: 'FOREIGN',
        hsnCode: '73', // 15.4%
        unitWeightKg: '2000', // 2 tonnes SEA 3400 → 6800
        freightMode: 'SEA',
      },
      ctx,
    );
    expect(r.breakdown.goodsInr).toBe('29100.0000');
    expect(r.breakdown.freight).toBe('6800.0000');
    expect(Number(r.unitPriceInrLanded)).toBeGreaterThan(29100);
  });

  it('duty base differs: tax on landed (EXW) vs on FOB value', () => {
    const exw = normalise(
      {
        unitPriceNative: '100',
        currency: 'USD',
        incoterm: 'EXW',
        originState: 'FOREIGN',
        hsnCode: '7325',
        unitWeightKg: '1000',
        freightMode: 'SEA',
      },
      ctx,
    );
    const cif = normalise(
      {
        unitPriceNative: '100',
        currency: 'USD',
        incoterm: 'CIF',
        originState: 'FOREIGN',
        hsnCode: '7325',
        unitWeightKg: '1000',
        freightMode: 'SEA',
      },
      ctx,
    );
    // EXW duty base includes freight+insurance; CIF base is goods only → EXW duty > CIF duty
    expect(Number(exw.breakdown.duty)).toBeGreaterThan(Number(cif.breakdown.duty));
  });

  it('zero weight → no freight even when INCOTERM would add it', () => {
    const r = normalise(
      {
        unitPriceNative: '100',
        currency: 'USD',
        incoterm: 'FOB',
        originState: 'FOREIGN',
        hsnCode: '84',
      },
      ctx,
    );
    expect(r.breakdown.freight).toBe('0.0000');
  });

  it('throws on a missing exchange rate', () => {
    expect(() =>
      normalise(
        {
          unitPriceNative: '100',
          currency: 'GBP',
          incoterm: 'DDP',
          originState: 'FOREIGN',
        },
        ctx,
      ),
    ).toThrow(MissingExchangeRateError);
  });

  it('throws on an invalid HSN when duty is required', () => {
    expect(() =>
      normalise(
        {
          unitPriceNative: '100',
          currency: 'USD',
          incoterm: 'FOB',
          originState: 'FOREIGN',
          hsnCode: '9999',
          unitWeightKg: '10',
        },
        ctx,
      ),
    ).toThrow(InvalidHsnError);
  });

  it('throws on a missing freight rate when freight is required', () => {
    expect(() =>
      normalise(
        {
          unitPriceNative: '100',
          currency: 'INR',
          incoterm: 'FOB',
          originState: '99',
          hsnCode: '8474',
          unitWeightKg: '10',
        },
        ctx,
      ),
    ).toThrow(MissingFreightRateError);
  });

  it('DDP never adds duty regardless of HSN', () => {
    const r = normalise(
      {
        unitPriceNative: '5000',
        currency: 'INR',
        incoterm: 'DDP',
        originState: '19',
        hsnCode: '7325',
        unitWeightKg: '5000',
      },
      ctx,
    );
    expect(r.breakdown.duty).toBe('0.0000');
    expect(r.unitPriceInrLanded).toBe('5000.0000');
  });

  it('longest-prefix HSN wins (7325 over 73)', () => {
    const specific = normalise(
      {
        unitPriceNative: '1000',
        currency: 'INR',
        incoterm: 'FOB',
        originState: '19',
        hsnCode: '7325',
        unitWeightKg: '0',
      },
      ctx,
    );
    // 7325 → 19.25% ; freight 0 (weight 0); insurance 3.5; dutyBase 1003.5; duty 193.17
    expect(specific.breakdown.dutyPct).toBe('0.1925');
  });

  it('handles West Bengal road freight (Kolkata → Lumshnong)', () => {
    const r = normalise(
      {
        unitPriceNative: '1000',
        currency: 'INR',
        incoterm: 'FOB',
        originState: '19',
        hsnCode: '8474',
        unitWeightKg: '1000',
      },
      ctx,
    );
    expect(r.breakdown.freight).toBe('1450.0000');
  });

  it('local Meghalaya freight is cheapest', () => {
    const r = normalise(
      {
        unitPriceNative: '1000',
        currency: 'INR',
        incoterm: 'FOB',
        originState: '17',
        hsnCode: '8474',
        unitWeightKg: '1000',
      },
      ctx,
    );
    expect(r.breakdown.freight).toBe('350.0000');
  });

  it('is deterministic across calls', () => {
    const args = {
      unitPriceNative: '4200',
      currency: 'INR',
      incoterm: 'DDP' as const,
      originState: '22',
      hsnCode: '8474',
    };
    expect(normalise(args, ctx).unitPriceInrLanded).toBe(
      normalise(args, ctx).unitPriceInrLanded,
    );
  });

  it('CIF foreign JPY duty-only path', () => {
    const r = normalise(
      {
        unitPriceNative: '100000',
        currency: 'JPY',
        incoterm: 'CIF',
        originState: 'FOREIGN',
        hsnCode: '25',
        unitWeightKg: '10000',
      },
      ctx,
    );
    expect(r.breakdown.freight).toBe('0.0000');
    expect(r.breakdown.dutyPct).toBe('0.0550');
  });

  it('FOB Maharashtra road freight', () => {
    const r = normalise(
      {
        unitPriceNative: '1000',
        currency: 'INR',
        incoterm: 'FOB',
        originState: '27',
        hsnCode: '8474',
        unitWeightKg: '2000',
      },
      ctx,
    );
    expect(r.breakdown.freight).toBe('7800.0000');
  });

  it('handling scales with weight for EXW', () => {
    const r = normalise(
      {
        unitPriceNative: '1000',
        currency: 'INR',
        incoterm: 'EXW',
        originState: '17',
        hsnCode: '8474',
        unitWeightKg: '4000',
      },
      ctx,
    );
    // handling 250/tonne * 4 = 1000 each side
    expect(r.breakdown.outboundHandling).toBe('1000.0000');
    expect(r.breakdown.inboundHandling).toBe('1000.0000');
  });

  it('Rajasthan road freight buildup', () => {
    const r = normalise(
      {
        unitPriceNative: '2000',
        currency: 'INR',
        incoterm: 'EXW',
        originState: '08',
        hsnCode: '25',
        unitWeightKg: '1000',
      },
      ctx,
    );
    expect(r.breakdown.freight).toBe('3100.0000');
  });

  it('Tamil Nadu (Chennai) EXW → landed exceeds native', () => {
    const r = normalise(
      {
        unitPriceNative: '5000',
        currency: 'INR',
        incoterm: 'EXW',
        originState: '33',
        hsnCode: '8474',
        unitWeightKg: '1000',
      },
      ctx,
    );
    expect(Number(r.unitPriceInrLanded)).toBeGreaterThan(5000);
    expect(r.breakdown.freight).toBe('3600.0000');
  });
});
