import { describe, expect, it } from 'vitest';

import { SamplingPlanService } from './sampling-plan.service';

const svc = new SamplingPlanService();

/**
 * Scenarios cross-checked against the published MIL-STD-105E / ISO 2859-1
 * single-sampling tables (ADR-015).
 */
describe('SamplingPlanService.computeSampleSize', () => {
  it('lot 7800 @ level S-3 → code F → sample 20 (the demo case)', () => {
    expect(svc.computeSampleSize(7800, '2.5', 'S3')).toBe(20);
  });

  it('level II lot 50 → code D → sample 8', () => {
    expect(svc.computeSampleSize(50, '2.5', 'II')).toBe(8);
  });

  it('level II lot 200 → code G → sample 32', () => {
    expect(svc.computeSampleSize(200, '2.5', 'II')).toBe(32);
  });

  it('level II lot 500 → code H → sample 50', () => {
    expect(svc.computeSampleSize(500, '2.5', 'II')).toBe(50);
  });

  it('level II lot 1000 → code J → sample 80', () => {
    expect(svc.computeSampleSize(1000, '2.5', 'II')).toBe(80);
  });

  it('resolves a ↓ arrow to a larger sample (lot 90, AQL 2.5 → code E ↓ F)', () => {
    // E(13) has an arrow at AQL 2.5, so the plan drops to F(20).
    expect(svc.computeSampleSize(90, '2.5', 'II')).toBe(20);
  });

  it('Tightened keeps the Normal sample size for the same code letter', () => {
    expect(svc.computeSampleSize(7800, '2.5', 'S3', 'TIGHTENED')).toBe(20);
  });

  it('Reduced uses the smaller reduced sample size (code F → 8)', () => {
    expect(svc.computeSampleSize(7800, '2.5', 'S3', 'REDUCED')).toBe(8);
  });
});

describe('SamplingPlanService.computePlan (Ac/Re)', () => {
  it('F/2.5 Normal → Ac 1, Re 2', () => {
    const plan = svc.computePlan(7800, '2.5', 'S3');
    expect(plan.codeLetter).toBe('F');
    expect(plan.acceptNumber).toBe(1);
    expect(plan.rejectNumber).toBe(2);
  });

  it('G/2.5 Normal → Ac 2, Re 3', () => {
    const plan = svc.computePlan(200, '2.5', 'II');
    expect(plan.acceptNumber).toBe(2);
  });

  it('H/2.5 Normal → Ac 3', () => {
    expect(svc.computePlan(500, '2.5', 'II').acceptNumber).toBe(3);
  });

  it('J/2.5 Normal → Ac 5', () => {
    expect(svc.computePlan(1000, '2.5', 'II').acceptNumber).toBe(5);
  });

  it('D/2.5 Normal → Ac 0', () => {
    expect(svc.computePlan(50, '2.5', 'II').acceptNumber).toBe(0);
  });

  it('F/4.0 Normal → Ac 2; F/6.5 → Ac 3', () => {
    expect(svc.computePlan(7800, '4.0', 'S3').acceptNumber).toBe(2);
    expect(svc.computePlan(7800, '6.5', 'S3').acceptNumber).toBe(3);
  });

  it('Tightened F/2.5 is stricter-graded → Ac 2', () => {
    expect(svc.computePlan(7800, '2.5', 'S3', 'TIGHTENED').acceptNumber).toBe(2);
  });
});

describe('SamplingPlanService.evaluateAcceptance', () => {
  it('accepts when defects ≤ Ac (sample 20, 1 defect, AQL 2.5)', () => {
    const r = svc.evaluateAcceptance(20, 1, '2.5');
    expect(r.accept).toBe(true);
    expect(r.acceptNumber).toBe(1);
    expect(r.rejectNumber).toBe(2);
  });

  it('rejects when defects ≥ Re (sample 20, 2 defects, AQL 2.5)', () => {
    expect(svc.evaluateAcceptance(20, 2, '2.5').accept).toBe(false);
  });

  it('accepts 0 defects on sample 8 (AQL 2.5, Ac 0)', () => {
    expect(svc.evaluateAcceptance(8, 0, '2.5').accept).toBe(true);
    expect(svc.evaluateAcceptance(8, 1, '2.5').accept).toBe(false);
  });

  it('borderline: sample 80 accepts 5, rejects 6 (AQL 2.5)', () => {
    expect(svc.evaluateAcceptance(80, 5, '2.5').accept).toBe(true);
    expect(svc.evaluateAcceptance(80, 6, '2.5').accept).toBe(false);
  });

  it('AQL 1.0 sample 50 → Ac 1', () => {
    const r = svc.evaluateAcceptance(50, 1, '1.0');
    expect(r.acceptNumber).toBe(1);
    expect(r.accept).toBe(true);
  });
});
