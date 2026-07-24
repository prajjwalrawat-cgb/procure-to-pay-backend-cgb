/**
 * Slice 5 static seed data — item-master QC parameters & sampling plans.
 *
 * AQL defaults per category (ADR-015): industrial hardware = AQL 2.5, refractory
 * = AQL 1.0 (tightened), PPE = AQL 4.0. Grinding-media hardness testing is
 * semi-destructive, so it uses special inspection level S-3 (smaller samples).
 *
 * Note the demo split: GM-FSB-25 (Patel 8T) requires full QC; GM-FSB-40 (Bhilai
 * 4T) is a fast-path receipt (no QC / no COA) so both flows are exercised.
 */

export interface QcRangeSpec {
  kind: 'RANGE';
  min: number;
  max: number;
  unit?: string;
}
export type ItemQcParameterMap = Record<string, QcRangeSpec>;

export interface ItemQcSpec {
  sku: string;
  requiresQc: boolean;
  requiresCoa?: boolean;
  requiresBatch?: boolean;
  requiresSerial?: boolean;
  aqlLevel: string;
  samplingPlanRef: string;
  qcParameters?: ItemQcParameterMap;
  stockGlAccount?: string;
}

export const SLICE5_ITEM_QC: ItemQcSpec[] = [
  // Grinding media — hero QC path (Patel 25mm). Special level S-3.
  {
    sku: 'GM-FSB-25',
    requiresQc: true,
    requiresCoa: true,
    requiresBatch: true,
    aqlLevel: '2.5',
    samplingPlanRef: 'AQL 2.5 · Normal · S-3 · MIL-STD-105E',
    qcParameters: {
      moisture: { kind: 'RANGE', min: 0, max: 3, unit: '%' },
      hardness: { kind: 'RANGE', min: 58, max: 65, unit: 'HRC' },
      density: { kind: 'RANGE', min: 7.6, max: 7.9, unit: 'g/cm³' },
    },
  },
  // Grinding media — fast path (Bhilai 40mm): no QC, no COA.
  {
    sku: 'GM-FSB-40',
    requiresQc: false,
    requiresCoa: false,
    requiresBatch: true,
    aqlLevel: '2.5',
    samplingPlanRef: 'AQL 2.5 · Normal · S-3 · MIL-STD-105E',
  },
  {
    sku: 'GM-CYL-22',
    requiresQc: true,
    requiresCoa: true,
    aqlLevel: '2.5',
    samplingPlanRef: 'AQL 2.5 · Normal · S-3 · MIL-STD-105E',
    qcParameters: {
      moisture: { kind: 'RANGE', min: 0, max: 3, unit: '%' },
      hardness: { kind: 'RANGE', min: 58, max: 65, unit: 'HRC' },
    },
  },
  // Refractory bricks — tightened AQL 1.0.
  {
    sku: 'RB-MAG-C',
    requiresQc: true,
    requiresCoa: true,
    aqlLevel: '1.0',
    samplingPlanRef: 'AQL 1.0 · Tightened · Level II · MIL-STD-105E',
    qcParameters: {
      cold_crushing_strength: { kind: 'RANGE', min: 40, max: 60, unit: 'MPa' },
      apparent_porosity: { kind: 'RANGE', min: 0, max: 22, unit: '%' },
      dimension_tolerance: { kind: 'RANGE', min: -2, max: 2, unit: 'mm' },
    },
  },
  {
    sku: 'RB-HAL-70',
    requiresQc: true,
    requiresCoa: true,
    aqlLevel: '1.0',
    samplingPlanRef: 'AQL 1.0 · Tightened · Level II · MIL-STD-105E',
    qcParameters: {
      cold_crushing_strength: { kind: 'RANGE', min: 40, max: 60, unit: 'MPa' },
      apparent_porosity: { kind: 'RANGE', min: 0, max: 24, unit: '%' },
    },
  },
  // Cement bags — PPE-class AQL 4.0.
  {
    sku: 'PK-BAG-50HDPE',
    requiresQc: true,
    aqlLevel: '4.0',
    samplingPlanRef: 'AQL 4.0 · Normal · Level II · MIL-STD-105E',
    qcParameters: {
      burst_strength: { kind: 'RANGE', min: 800, max: 100000, unit: 'kPa' },
      tear_resistance: { kind: 'RANGE', min: 40, max: 100000, unit: 'N' },
    },
  },
  // Fuel — coal grade A.
  {
    sku: 'CO-STEAM-A',
    requiresQc: true,
    requiresCoa: true,
    aqlLevel: '2.5',
    samplingPlanRef: 'AQL 2.5 · Normal · Level II · MIL-STD-105E',
    qcParameters: {
      calorific_value: { kind: 'RANGE', min: 10500, max: 100000, unit: 'kcal/kg' },
      moisture: { kind: 'RANGE', min: 0, max: 8, unit: '%' },
      ash: { kind: 'RANGE', min: 0, max: 15, unit: '%' },
    },
  },
  // Safety PPE — AQL 4.0, no parametric spec (attribute inspection).
  {
    sku: 'PP-HELMET',
    requiresQc: true,
    aqlLevel: '4.0',
    samplingPlanRef: 'AQL 4.0 · Normal · Level II · MIL-STD-105E',
  },
  // Welding electrode / grease — fast-path MRO consumables (no QC).
  { sku: 'FT-WELD-ROD', requiresQc: false, aqlLevel: '2.5', samplingPlanRef: 'None' },
  { sku: 'MRO-GREASE-15', requiresQc: false, aqlLevel: '2.5', samplingPlanRef: 'None' },
];
