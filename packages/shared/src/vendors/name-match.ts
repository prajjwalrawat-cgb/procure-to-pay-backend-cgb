/**
 * NameMatchService (Slice 7 §5) — pure fuzzy name matching for penny-drop and
 * GSTIN/PAN cross-verification. Normalises Indian legal-name variations (Pvt Ltd
 * vs Private Limited, & Sons, punctuation, whitespace) then scores similarity
 * with Jaro-Winkler, Levenshtein, or a hybrid. No DB access; unit-tested against
 * 30+ real-world scenarios (ADR-021).
 */

import type { NameMatchAlgorithm } from '../constants/vendor-status';

/** Common legal-entity suffixes/qualifiers stripped before comparison. Order
 *  matters — longer phrases first so "PRIVATE LIMITED" is removed before "LIMITED". */
const SUFFIX_PATTERNS: RegExp[] = [
  /\bPRIVATE\s+LIMITED\b/g,
  /\bPUBLIC\s+LIMITED\b/g,
  /\bPVT\.?\s*LTD\.?\b/g,
  /\bP\.?\s*LTD\.?\b/g,
  /\bLIMITED\b/g,
  /\bLTD\.?\b/g,
  /\bLLP\b/g,
  /\bLLC\b/g,
  /\bINC\.?\b/g,
  /\bCORP\.?\b/g,
  /\bCO\.?\b/g,
  /\bAND\s+SONS\b/g,
  /\bAND\s+CO\b/g,
  /\bPROPRIETOR\b/g,
  /\bPROP\.?\b/g,
  /\bENTERPRISES?\b/g,
  /\bINDUSTRIES\b/g,
  /\bINDUSTRIAL\b/g,
  /\bTRADING\b/g,
];

/** Normalise a legal name: uppercase, strip suffixes + punctuation, collapse
 *  whitespace. Exposed so callers can preview what gets compared. */
export function normaliseName(input: string): string {
  let s = input.toUpperCase();
  s = s.replace(/[.,\-_/()]/g, ' ');
  s = s.replace(/&/g, ' AND '); // "& Sons"/"& Co" → "AND SONS"/"AND CO" for the suffix strip
  for (const pattern of SUFFIX_PATTERNS) s = s.replace(pattern, ' ');
  s = s.replace(/[^A-Z0-9 ]/g, ' '); // drop any residual punctuation
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Levenshtein edit distance between two strings. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] as number) + 1,
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] as number;
}

/** Levenshtein similarity normalised to 0..1 (1 = identical). */
export function levenshteinScore(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

/** Jaro similarity (0..1). */
export function jaro(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatches = new Array<boolean>(a.length).fill(false);
  const bMatches = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, b.length);
    for (let j = start; j < end; j += 1) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  const t = transpositions / 2;
  return (matches / a.length + matches / b.length + (matches - t) / matches) / 3;
}

/** Jaro-Winkler similarity (0..1) — boosts common-prefix matches. */
export function jaroWinkler(a: string, b: string, prefixScale = 0.1): number {
  const j = jaro(a, b);
  let prefix = 0;
  const maxPrefix = Math.min(4, a.length, b.length);
  while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix += 1;
  return j + prefix * prefixScale * (1 - j);
}

export interface NameMatchResult {
  score: number;
  algorithm: NameMatchAlgorithm;
  normalisedA: string;
  normalisedB: string;
}

/** Compare two names after normalisation, returning a 0..1 score. Hybrid takes
 *  the max of Jaro-Winkler and Levenshtein (most forgiving of the two). */
export function compare(
  a: string,
  b: string,
  algorithm: NameMatchAlgorithm = 'HYBRID',
): NameMatchResult {
  const na = normaliseName(a);
  const nb = normaliseName(b);
  let score: number;
  if (algorithm === 'JARO_WINKLER') score = jaroWinkler(na, nb);
  else if (algorithm === 'LEVENSHTEIN') score = levenshteinScore(na, nb);
  else score = Math.max(jaroWinkler(na, nb), levenshteinScore(na, nb));
  return {
    score: Math.round(score * 10000) / 10000,
    algorithm,
    normalisedA: na,
    normalisedB: nb,
  };
}

export interface AcceptanceResult {
  pass: boolean;
  score: number;
  threshold: number;
  recommendation: 'PASS' | 'FLAG';
}

/** Above threshold → PASS; below → FLAG (manual review). Default 0.85. */
export function assessAcceptance(score: number, threshold = 0.85): AcceptanceResult {
  const pass = score >= threshold;
  return { pass, score, threshold, recommendation: pass ? 'PASS' : 'FLAG' };
}
