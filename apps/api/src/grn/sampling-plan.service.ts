import { Injectable } from '@nestjs/common';
import {
  codeLetterFor,
  letterForSampleSize,
  resolvePlan,
  type AqlLevel,
  type InspectionLevel,
  type InspectionSeverity,
  type SamplingPlan,
} from '@procureflow/shared';

export interface AcceptanceResult {
  sampleSize: number;
  acceptNumber: number;
  rejectNumber: number;
  defectsFound: number;
  accept: boolean;
}

/**
 * SamplingPlanService (Slice 5) — pure MIL-STD-105E / ISO 2859-1 sampling.
 * No I/O; all table data lives in `@procureflow/shared` (ADR-015). Deterministic
 * and unit-tested against the published tables.
 */
@Injectable()
export class SamplingPlanService {
  /**
   * Sample size for a lot at a given AQL, inspection level, and severity —
   * following the standard's arrows (which may change the sampled quantity).
   */
  computeSampleSize(
    lotSize: number,
    aqlLevel: AqlLevel,
    inspectionLevel: InspectionLevel = 'II',
    severity: InspectionSeverity = 'NORMAL',
  ): number {
    return this.computePlan(lotSize, aqlLevel, inspectionLevel, severity).sampleSize;
  }

  /** Full resolved plan (code letter, sample size, Ac, Re). */
  computePlan(
    lotSize: number,
    aqlLevel: AqlLevel,
    inspectionLevel: InspectionLevel = 'II',
    severity: InspectionSeverity = 'NORMAL',
  ): SamplingPlan {
    const letter = codeLetterFor(lotSize, inspectionLevel);
    const plan = resolvePlan(letter, aqlLevel, severity);
    return { ...plan, inspectionLevel };
  }

  /**
   * Accept/reject a lot given the number of defectives found in the sample.
   * `sampleSize` is the already-resolved sample size (as returned by
   * {@link computeSampleSize}); Ac/Re come from its code letter's plan.
   */
  evaluateAcceptance(
    sampleSize: number,
    defectsFound: number,
    aqlLevel: AqlLevel,
    severity: InspectionSeverity = 'NORMAL',
  ): AcceptanceResult {
    const letter = letterForSampleSize(sampleSize, severity);
    const plan = resolvePlan(letter, aqlLevel, severity);
    return {
      sampleSize: plan.sampleSize,
      acceptNumber: plan.acceptNumber,
      rejectNumber: plan.rejectNumber,
      defectsFound,
      accept: defectsFound <= plan.acceptNumber,
    };
  }
}
