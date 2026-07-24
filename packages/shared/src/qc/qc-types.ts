/**
 * QC parameter-evaluation types (Slice 5). An item's `qc_parameters` (from the
 * item master) describes each measurable/inspectable characteristic; the QC
 * officer records measured values; the pure QcParameterEvaluator compares them.
 * Numbers cross this boundary as `number` (measured lab values) — money/qty use
 * decimal strings elsewhere, but QC readings are physical measurements.
 */

export type QcSampleResult = 'PASS' | 'FAIL' | 'CONDITIONAL_PASS';

/** A range spec: measured value must be within [min, max] inclusive. */
export interface QcRangeSpec {
  kind: 'RANGE';
  min: number;
  max: number;
  unit?: string;
}

/** A target ± tolerance spec (absolute tolerance). */
export interface QcTargetSpec {
  kind: 'TARGET';
  target: number;
  tolerance: number;
  unit?: string;
}

/** A boolean spec: the characteristic must be present (or absent). */
export interface QcBooleanSpec {
  kind: 'BOOLEAN';
  mustBe: boolean;
}

export type QcParameterSpec = QcRangeSpec | QcTargetSpec | QcBooleanSpec;

/** Item-master QC parameter block: `{ [parameterName]: spec }`. */
export type QcParameterSpecMap = Record<string, QcParameterSpec>;

/** Measured values recorded by the inspector: `{ [parameterName]: value }`. */
export type QcMeasuredMap = Record<string, number | boolean>;

export interface QcParameterEvaluation {
  parameter: string;
  measured: number | boolean | null;
  spec: QcParameterSpec;
  result: 'PASS' | 'FAIL';
  /** Signed deviation from the nearest bound, as a % of the bound (numeric specs). */
  deviationPct?: number;
  message: string;
}

export interface QcSampleEvaluation {
  result: QcSampleResult;
  parameters: QcParameterEvaluation[];
  /** Parameters present in the spec but not measured — fail-safe. */
  missing: string[];
}
