/**
 * AQL sampling-plan tables — MIL-STD-105E / ISO 2859-1 (single sampling).
 *
 * Source: MIL-STD-105E "Sampling Procedures and Tables for Inspection by
 * Attributes" (Table I — sample-size code letters; Table II-A/B/C — single
 * sampling plans for Normal / Tightened / Reduced inspection). ISO 2859-1 is
 * the equivalent international standard with identical numeric tables.
 *
 * Pure data + a small resolver — no I/O. Consumed by SamplingPlanService and
 * unit-tested against the published tables (ADR-015).
 *
 * Arrow convention (as printed in the standard): a cell may hold a numeric
 * acceptance number, or an arrow. `DOWN` = "use the first sampling plan below
 * the arrow" (a larger sample), `UP` = "use the first plan above the arrow"
 * (a smaller sample). Following the arrow changes BOTH the sample size and the
 * accept/reject numbers to that row's plan.
 */

export const AQL_LEVELS = ['0.65', '1.0', '1.5', '2.5', '4.0', '6.5', '10'] as const;
export type AqlLevel = (typeof AQL_LEVELS)[number];

export const INSPECTION_LEVELS = ['S1', 'S2', 'S3', 'S4', 'I', 'II', 'III'] as const;
export type InspectionLevel = (typeof INSPECTION_LEVELS)[number];

export const INSPECTION_SEVERITIES = ['NORMAL', 'TIGHTENED', 'REDUCED'] as const;
export type InspectionSeverity = (typeof INSPECTION_SEVERITIES)[number];

/** Sample-size code letters, smallest lot → largest. */
export const CODE_LETTERS = [
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'J',
  'K',
  'L',
  'M',
  'N',
  'P',
  'Q',
  'R',
] as const;
export type CodeLetter = (typeof CODE_LETTERS)[number];

/** MIL-STD-105E Table I — sample-size code letters by lot size & level. */
interface CodeRow {
  maxLot: number;
  letters: Record<InspectionLevel, CodeLetter>;
}
export const CODE_LETTER_TABLE: CodeRow[] = [
  {
    maxLot: 8,
    letters: { S1: 'A', S2: 'A', S3: 'A', S4: 'A', I: 'A', II: 'A', III: 'B' },
  },
  {
    maxLot: 15,
    letters: { S1: 'A', S2: 'A', S3: 'A', S4: 'A', I: 'A', II: 'B', III: 'C' },
  },
  {
    maxLot: 25,
    letters: { S1: 'A', S2: 'A', S3: 'B', S4: 'B', I: 'B', II: 'C', III: 'D' },
  },
  {
    maxLot: 50,
    letters: { S1: 'A', S2: 'B', S3: 'B', S4: 'C', I: 'C', II: 'D', III: 'E' },
  },
  {
    maxLot: 90,
    letters: { S1: 'B', S2: 'B', S3: 'C', S4: 'C', I: 'C', II: 'E', III: 'F' },
  },
  {
    maxLot: 150,
    letters: { S1: 'B', S2: 'B', S3: 'C', S4: 'D', I: 'D', II: 'F', III: 'G' },
  },
  {
    maxLot: 280,
    letters: { S1: 'B', S2: 'C', S3: 'D', S4: 'E', I: 'E', II: 'G', III: 'H' },
  },
  {
    maxLot: 500,
    letters: { S1: 'B', S2: 'C', S3: 'D', S4: 'E', I: 'F', II: 'H', III: 'J' },
  },
  {
    maxLot: 1200,
    letters: { S1: 'C', S2: 'C', S3: 'E', S4: 'F', I: 'G', II: 'J', III: 'K' },
  },
  {
    maxLot: 3200,
    letters: { S1: 'C', S2: 'D', S3: 'E', S4: 'G', I: 'H', II: 'K', III: 'L' },
  },
  {
    maxLot: 10000,
    letters: { S1: 'C', S2: 'D', S3: 'F', S4: 'G', I: 'J', II: 'L', III: 'M' },
  },
  {
    maxLot: 35000,
    letters: { S1: 'C', S2: 'D', S3: 'F', S4: 'H', I: 'K', II: 'M', III: 'N' },
  },
  {
    maxLot: 150000,
    letters: { S1: 'D', S2: 'E', S3: 'G', S4: 'J', I: 'L', II: 'N', III: 'P' },
  },
  {
    maxLot: 500000,
    letters: { S1: 'D', S2: 'E', S3: 'G', S4: 'J', I: 'M', II: 'P', III: 'Q' },
  },
  {
    maxLot: Number.POSITIVE_INFINITY,
    letters: { S1: 'D', S2: 'E', S3: 'H', S4: 'K', I: 'N', II: 'Q', III: 'R' },
  },
];

/** Normal & Tightened sample size by code letter (Table II-A / II-B). */
export const SAMPLE_SIZE_BY_LETTER: Record<CodeLetter, number> = {
  A: 2,
  B: 3,
  C: 5,
  D: 8,
  E: 13,
  F: 20,
  G: 32,
  H: 50,
  J: 80,
  K: 125,
  L: 200,
  M: 315,
  N: 500,
  P: 800,
  Q: 1250,
  R: 2000,
};

/** Reduced inspection uses smaller samples (Table II-C sample-size column). */
export const REDUCED_SAMPLE_SIZE_BY_LETTER: Record<CodeLetter, number> = {
  A: 2,
  B: 2,
  C: 2,
  D: 3,
  E: 5,
  F: 8,
  G: 13,
  H: 20,
  J: 32,
  K: 50,
  L: 80,
  M: 125,
  N: 200,
  P: 315,
  Q: 500,
  R: 800,
};

type Cell = number | 'DOWN' | 'UP';
type AcRow = Record<AqlLevel, Cell>;

const D: Cell = 'DOWN';
const U: Cell = 'UP';

/**
 * Table II-A — single sampling, NORMAL inspection. Acceptance numbers (Ac).
 * Rejection number is Ac+1. Columns follow {@link AQL_LEVELS}.
 * Verified anchors: F(20)/2.5 → Ac 1, G(32)/2.5 → Ac 2, H(50)/2.5 → Ac 3.
 */
export const AC_NORMAL: Record<CodeLetter, AcRow> = {
  A: { '0.65': D, '1.0': D, '1.5': D, '2.5': D, '4.0': D, '6.5': D, '10': 0 },
  B: { '0.65': D, '1.0': D, '1.5': D, '2.5': D, '4.0': D, '6.5': 0, '10': D },
  C: { '0.65': D, '1.0': D, '1.5': D, '2.5': D, '4.0': 0, '6.5': D, '10': 1 },
  D: { '0.65': D, '1.0': D, '1.5': D, '2.5': 0, '4.0': D, '6.5': 1, '10': 2 },
  E: { '0.65': D, '1.0': D, '1.5': 0, '2.5': D, '4.0': 1, '6.5': 2, '10': 3 },
  F: { '0.65': D, '1.0': 0, '1.5': D, '2.5': 1, '4.0': 2, '6.5': 3, '10': 5 },
  G: { '0.65': 0, '1.0': D, '1.5': 1, '2.5': 2, '4.0': 3, '6.5': 5, '10': 7 },
  H: { '0.65': D, '1.0': 1, '1.5': 2, '2.5': 3, '4.0': 5, '6.5': 7, '10': 10 },
  J: { '0.65': 1, '1.0': 2, '1.5': 3, '2.5': 5, '4.0': 7, '6.5': 10, '10': 14 },
  K: { '0.65': 2, '1.0': 3, '1.5': 5, '2.5': 7, '4.0': 10, '6.5': 14, '10': 21 },
  L: { '0.65': 3, '1.0': 5, '1.5': 7, '2.5': 10, '4.0': 14, '6.5': 21, '10': U },
  M: { '0.65': 5, '1.0': 7, '1.5': 10, '2.5': 14, '4.0': 21, '6.5': U, '10': U },
  N: { '0.65': 7, '1.0': 10, '1.5': 14, '2.5': 21, '4.0': U, '6.5': U, '10': U },
  P: { '0.65': 10, '1.0': 14, '1.5': 21, '2.5': U, '4.0': U, '6.5': U, '10': U },
  Q: { '0.65': 14, '1.0': 21, '1.5': U, '2.5': U, '4.0': U, '6.5': U, '10': U },
  R: { '0.65': 21, '1.0': U, '1.5': U, '2.5': U, '4.0': U, '6.5': U, '10': U },
};

/**
 * Table II-B — single sampling, TIGHTENED inspection. The acceptance diagonal
 * is one AQL column stricter than Normal (same sample sizes).
 */
export const AC_TIGHTENED: Record<CodeLetter, AcRow> = {
  A: { '0.65': D, '1.0': D, '1.5': D, '2.5': D, '4.0': D, '6.5': 0, '10': D },
  B: { '0.65': D, '1.0': D, '1.5': D, '2.5': D, '4.0': 0, '6.5': D, '10': 1 },
  C: { '0.65': D, '1.0': D, '1.5': D, '2.5': 0, '4.0': D, '6.5': 1, '10': 2 },
  D: { '0.65': D, '1.0': D, '1.5': 0, '2.5': D, '4.0': 1, '6.5': 2, '10': 3 },
  E: { '0.65': D, '1.0': 0, '1.5': D, '2.5': 1, '4.0': 2, '6.5': 3, '10': 5 },
  F: { '0.65': 0, '1.0': D, '1.5': 1, '2.5': 2, '4.0': 3, '6.5': 5, '10': 8 },
  G: { '0.65': D, '1.0': 1, '1.5': 2, '2.5': 3, '4.0': 5, '6.5': 8, '10': 12 },
  H: { '0.65': 1, '1.0': 2, '1.5': 3, '2.5': 5, '4.0': 8, '6.5': 12, '10': 18 },
  J: { '0.65': 2, '1.0': 3, '1.5': 5, '2.5': 8, '4.0': 12, '6.5': 18, '10': U },
  K: { '0.65': 3, '1.0': 5, '1.5': 8, '2.5': 12, '4.0': 18, '6.5': U, '10': U },
  L: { '0.65': 5, '1.0': 8, '1.5': 12, '2.5': 18, '4.0': U, '6.5': U, '10': U },
  M: { '0.65': 8, '1.0': 12, '1.5': 18, '2.5': U, '4.0': U, '6.5': U, '10': U },
  N: { '0.65': 12, '1.0': 18, '1.5': U, '2.5': U, '4.0': U, '6.5': U, '10': U },
  P: { '0.65': 18, '1.0': U, '1.5': U, '2.5': U, '4.0': U, '6.5': U, '10': U },
  Q: { '0.65': U, '1.0': U, '1.5': U, '2.5': U, '4.0': U, '6.5': U, '10': U },
  R: { '0.65': U, '1.0': U, '1.5': U, '2.5': U, '4.0': U, '6.5': U, '10': U },
};

/**
 * Table II-C — single sampling, REDUCED inspection. Uses the reduced sample
 * sizes; the acceptance diagonal is one AQL column looser than Normal. (The
 * published table has a separate rejection column with a gap; ProcureFlow uses
 * Re = Ac+1 here — documented in ADR-015.)
 */
export const AC_REDUCED: Record<CodeLetter, AcRow> = {
  A: { '0.65': D, '1.0': D, '1.5': D, '2.5': D, '4.0': D, '6.5': D, '10': 0 },
  B: { '0.65': D, '1.0': D, '1.5': D, '2.5': D, '4.0': D, '6.5': 0, '10': 1 },
  C: { '0.65': D, '1.0': D, '1.5': D, '2.5': D, '4.0': 0, '6.5': 1, '10': 1 },
  D: { '0.65': D, '1.0': D, '1.5': D, '2.5': 0, '4.0': 1, '6.5': 1, '10': 2 },
  E: { '0.65': D, '1.0': D, '1.5': 0, '2.5': 1, '4.0': 1, '6.5': 2, '10': 3 },
  F: { '0.65': D, '1.0': 0, '1.5': 1, '2.5': 1, '4.0': 2, '6.5': 3, '10': 5 },
  G: { '0.65': 0, '1.0': 1, '1.5': 1, '2.5': 2, '4.0': 3, '6.5': 5, '10': 7 },
  H: { '0.65': 1, '1.0': 1, '1.5': 2, '2.5': 3, '4.0': 5, '6.5': 7, '10': 10 },
  J: { '0.65': 1, '1.0': 2, '1.5': 3, '2.5': 5, '4.0': 7, '6.5': 10, '10': 14 },
  K: { '0.65': 2, '1.0': 3, '1.5': 5, '2.5': 7, '4.0': 10, '6.5': 14, '10': 21 },
  L: { '0.65': 3, '1.0': 5, '1.5': 7, '2.5': 10, '4.0': 14, '6.5': 21, '10': U },
  M: { '0.65': 5, '1.0': 7, '1.5': 10, '2.5': 14, '4.0': 21, '6.5': U, '10': U },
  N: { '0.65': 7, '1.0': 10, '1.5': 14, '2.5': 21, '4.0': U, '6.5': U, '10': U },
  P: { '0.65': 10, '1.0': 14, '1.5': 21, '2.5': U, '4.0': U, '6.5': U, '10': U },
  Q: { '0.65': 14, '1.0': 21, '1.5': U, '2.5': U, '4.0': U, '6.5': U, '10': U },
  R: { '0.65': 21, '1.0': U, '1.5': U, '2.5': U, '4.0': U, '6.5': U, '10': U },
};

export interface SamplingPlan {
  codeLetter: CodeLetter;
  sampleSize: number;
  acceptNumber: number;
  rejectNumber: number;
  aqlLevel: AqlLevel;
  inspectionLevel: InspectionLevel;
  severity: InspectionSeverity;
}

function acTableFor(severity: InspectionSeverity): Record<CodeLetter, AcRow> {
  if (severity === 'TIGHTENED') return AC_TIGHTENED;
  if (severity === 'REDUCED') return AC_REDUCED;
  return AC_NORMAL;
}

function sizeTableFor(severity: InspectionSeverity): Record<CodeLetter, number> {
  return severity === 'REDUCED' ? REDUCED_SAMPLE_SIZE_BY_LETTER : SAMPLE_SIZE_BY_LETTER;
}

/** Code letter for a lot size at an inspection level (Table I). */
export function codeLetterFor(
  lotSize: number,
  level: InspectionLevel = 'II',
): CodeLetter {
  const row = CODE_LETTER_TABLE.find((r) => lotSize <= r.maxLot);
  // lotSize < 2 falls back to the smallest row; INFINITY row guarantees a match.
  return (row ?? CODE_LETTER_TABLE[CODE_LETTER_TABLE.length - 1]!).letters[level];
}

/**
 * Resolve a plan at (code letter, AQL) following the standard's arrows to the
 * first row that carries a numeric acceptance number.
 */
export function resolvePlan(
  letter: CodeLetter,
  aql: AqlLevel,
  severity: InspectionSeverity = 'NORMAL',
): SamplingPlan {
  const table = acTableFor(severity);
  const sizes = sizeTableFor(severity);
  let idx = CODE_LETTERS.indexOf(letter);
  for (let guard = 0; guard < CODE_LETTERS.length; guard += 1) {
    const current = CODE_LETTERS[idx]!;
    const cell = table[current][aql];
    if (cell === 'DOWN') {
      idx += 1;
    } else if (cell === 'UP') {
      idx -= 1;
    } else {
      return {
        codeLetter: current,
        sampleSize: sizes[current],
        acceptNumber: cell,
        rejectNumber: cell + 1,
        aqlLevel: aql,
        inspectionLevel: 'II',
        severity,
      };
    }
    if (idx < 0 || idx >= CODE_LETTERS.length) break;
  }
  throw new Error(
    `No acceptance number resolvable for code ${letter} at AQL ${aql} (${severity}).`,
  );
}

/** Reverse lookup: the code letter whose sample size equals `sampleSize`. */
export function letterForSampleSize(
  sampleSize: number,
  severity: InspectionSeverity = 'NORMAL',
): CodeLetter {
  const sizes = sizeTableFor(severity);
  const found = CODE_LETTERS.find((l) => sizes[l] === sampleSize);
  if (!found) throw new Error(`No code letter for sample size ${sampleSize}.`);
  return found;
}
