import { Injectable } from '@nestjs/common';
import type {
  QcMeasuredMap,
  QcParameterEvaluation,
  QcParameterSpec,
  QcParameterSpecMap,
  QcRangeSpec,
  QcSampleEvaluation,
  QcTargetSpec,
} from '@procureflow/shared';

/**
 * QcParameterEvaluator (Slice 5) — pure evaluation of measured QC readings
 * against item-master spec ranges. Handles range specs, target ± tolerance,
 * and boolean specs; a spec parameter with no measured value fails safely.
 * No I/O; fully unit-tested.
 */
@Injectable()
export class QcParameterEvaluator {
  /** Evaluate a single measured value against its spec. */
  evaluateParameter(
    parameter: string,
    measured: number | boolean | undefined,
    spec: QcParameterSpec,
  ): QcParameterEvaluation {
    if (measured === undefined || measured === null) {
      return {
        parameter,
        measured: null,
        spec,
        result: 'FAIL',
        message: `No measurement recorded for "${parameter}".`,
      };
    }

    if (spec.kind === 'BOOLEAN') {
      const value = Boolean(measured);
      const pass = value === spec.mustBe;
      return {
        parameter,
        measured: value,
        spec,
        result: pass ? 'PASS' : 'FAIL',
        message: pass
          ? `${parameter} = ${value} (required ${spec.mustBe}).`
          : `${parameter} = ${value} but ${spec.mustBe} required.`,
      };
    }

    if (typeof measured !== 'number' || Number.isNaN(measured)) {
      return {
        parameter,
        measured: null,
        spec,
        result: 'FAIL',
        message: `Measurement for "${parameter}" is not a number.`,
      };
    }

    const { min, max, unit } = this.bounds(spec as QcRangeSpec | QcTargetSpec);
    const pass = measured >= min && measured <= max;
    const deviationPct = this.deviationPct(measured, min, max);
    const u = unit ? ` ${unit}` : '';
    return {
      parameter,
      measured,
      spec,
      result: pass ? 'PASS' : 'FAIL',
      deviationPct,
      message: pass
        ? `${parameter} = ${measured}${u} within [${min}, ${max}].`
        : `${parameter} = ${measured}${u} outside [${min}, ${max}] (${deviationPct > 0 ? '+' : ''}${deviationPct.toFixed(2)}%).`,
    };
  }

  /**
   * Evaluate a full sample. Result is FAIL if any parameter fails or is
   * missing; CONDITIONAL_PASS if all parameters pass but minor defects were
   * recorded; PASS otherwise.
   */
  evaluateSample(
    specMap: QcParameterSpecMap,
    measuredMap: QcMeasuredMap,
    opts: { conditionalDefects?: string[] } = {},
  ): QcSampleEvaluation {
    const parameters: QcParameterEvaluation[] = [];
    const missing: string[] = [];

    for (const [name, spec] of Object.entries(specMap)) {
      const measured = measuredMap[name];
      if (measured === undefined || measured === null) missing.push(name);
      parameters.push(this.evaluateParameter(name, measured, spec));
    }

    const anyFail = parameters.some((p) => p.result === 'FAIL');
    if (anyFail) return { result: 'FAIL', parameters, missing };
    if ((opts.conditionalDefects?.length ?? 0) > 0) {
      return { result: 'CONDITIONAL_PASS', parameters, missing };
    }
    return { result: 'PASS', parameters, missing };
  }

  private bounds(spec: QcRangeSpec | QcTargetSpec): {
    min: number;
    max: number;
    unit?: string;
  } {
    if (spec.kind === 'RANGE') return { min: spec.min, max: spec.max, unit: spec.unit };
    return {
      min: spec.target - spec.tolerance,
      max: spec.target + spec.tolerance,
      unit: spec.unit,
    };
  }

  /** Signed deviation from the nearest violated bound, as a % of that bound. */
  private deviationPct(measured: number, min: number, max: number): number {
    if (measured < min) {
      return min === 0 ? measured - min : ((measured - min) / Math.abs(min)) * 100;
    }
    if (measured > max) {
      return max === 0 ? measured - max : ((measured - max) / Math.abs(max)) * 100;
    }
    return 0;
  }
}
