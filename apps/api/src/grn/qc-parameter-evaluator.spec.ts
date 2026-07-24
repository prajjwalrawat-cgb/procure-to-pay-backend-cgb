import type { QcParameterSpecMap } from '@procureflow/shared';
import { describe, expect, it } from 'vitest';

import { QcParameterEvaluator } from './qc-parameter-evaluator';

const ev = new QcParameterEvaluator();

describe('QcParameterEvaluator.evaluateParameter', () => {
  it('RANGE: value inside bounds passes', () => {
    const r = ev.evaluateParameter('moisture', 2.8, { kind: 'RANGE', min: 0, max: 3 });
    expect(r.result).toBe('PASS');
  });

  it('RANGE: value above max fails with positive deviation', () => {
    const r = ev.evaluateParameter('moisture', 3.6, { kind: 'RANGE', min: 0, max: 3 });
    expect(r.result).toBe('FAIL');
    expect(r.deviationPct).toBeGreaterThan(0);
  });

  it('RANGE: value below min fails with negative deviation', () => {
    const r = ev.evaluateParameter('hardness', 55, { kind: 'RANGE', min: 58, max: 65 });
    expect(r.result).toBe('FAIL');
    expect(r.deviationPct).toBeLessThan(0);
  });

  it('RANGE: exact boundary passes (inclusive)', () => {
    expect(
      ev.evaluateParameter('hardness', 58, { kind: 'RANGE', min: 58, max: 65 }).result,
    ).toBe('PASS');
    expect(
      ev.evaluateParameter('hardness', 65, { kind: 'RANGE', min: 58, max: 65 }).result,
    ).toBe('PASS');
  });

  it('TARGET: within ± tolerance passes', () => {
    const r = ev.evaluateParameter('length', 100.4, {
      kind: 'TARGET',
      target: 100,
      tolerance: 0.5,
    });
    expect(r.result).toBe('PASS');
  });

  it('TARGET: outside tolerance fails', () => {
    const r = ev.evaluateParameter('length', 101, {
      kind: 'TARGET',
      target: 100,
      tolerance: 0.5,
    });
    expect(r.result).toBe('FAIL');
  });

  it('BOOLEAN: matches required value', () => {
    expect(
      ev.evaluateParameter('coa_present', true, { kind: 'BOOLEAN', mustBe: true }).result,
    ).toBe('PASS');
    expect(
      ev.evaluateParameter('coa_present', false, { kind: 'BOOLEAN', mustBe: true })
        .result,
    ).toBe('FAIL');
  });

  it('missing measurement fails safely', () => {
    const r = ev.evaluateParameter('moisture', undefined, {
      kind: 'RANGE',
      min: 0,
      max: 3,
    });
    expect(r.result).toBe('FAIL');
    expect(r.measured).toBeNull();
  });

  it('non-numeric measurement for a numeric spec fails', () => {
    const r = ev.evaluateParameter('moisture', Number.NaN as unknown as number, {
      kind: 'RANGE',
      min: 0,
      max: 3,
    });
    expect(r.result).toBe('FAIL');
  });

  it('negative-bound range near zero does not divide by zero', () => {
    const r = ev.evaluateParameter('tolerance', 3, {
      kind: 'RANGE',
      min: -2,
      max: 2,
    });
    expect(r.result).toBe('FAIL');
    expect(Number.isFinite(r.deviationPct ?? 0)).toBe(true);
  });
});

describe('QcParameterEvaluator.evaluateSample', () => {
  const grindingMedia: QcParameterSpecMap = {
    moisture: { kind: 'RANGE', min: 0, max: 3, unit: '%' },
    hardness: { kind: 'RANGE', min: 58, max: 65, unit: 'HRC' },
    density: { kind: 'RANGE', min: 7.6, max: 7.9, unit: 'g/cm³' },
  };

  it('all parameters pass → PASS', () => {
    const r = ev.evaluateSample(grindingMedia, {
      moisture: 2.8,
      hardness: 62,
      density: 7.75,
    });
    expect(r.result).toBe('PASS');
    expect(r.missing).toHaveLength(0);
  });

  it('one parameter fails → FAIL', () => {
    const r = ev.evaluateSample(grindingMedia, {
      moisture: 2.8,
      hardness: 70,
      density: 7.75,
    });
    expect(r.result).toBe('FAIL');
  });

  it('missing parameter → FAIL and reported in missing[]', () => {
    const r = ev.evaluateSample(grindingMedia, { moisture: 2.8, hardness: 62 });
    expect(r.result).toBe('FAIL');
    expect(r.missing).toContain('density');
  });

  it('all pass but minor defects recorded → CONDITIONAL_PASS', () => {
    const r = ev.evaluateSample(
      grindingMedia,
      { moisture: 2.8, hardness: 62, density: 7.75 },
      { conditionalDefects: ['2 drums dented'] },
    );
    expect(r.result).toBe('CONDITIONAL_PASS');
  });

  it('empty spec with no measurements → PASS (nothing to check)', () => {
    expect(ev.evaluateSample({}, {}).result).toBe('PASS');
  });
});
