import type { CommitmentPeriod, VolumeTrackingStatus } from '@procureflow/shared';
import Decimal from 'decimal.js';

/**
 * Pure contract domain logic (Slice 9). No DB, no Nest — unit-tested directly.
 */

/** On pace to hit ≥90% of the commitment → ON_TRACK; ≥70% → AT_RISK; else SHORTFALL. */
export const VOLUME_ON_TRACK_THRESHOLD = 0.9;
export const VOLUME_AT_RISK_THRESHOLD = 0.7;

/** Indian financial-year label (1 Apr–31 Mar) for a date, e.g. 'FY2026'. */
export function fyLabel(date: Date): string {
  const y = date.getUTCFullYear();
  const startYear = date.getUTCMonth() >= 3 ? y : y - 1; // month 3 === April
  return `FY${startYear}`;
}

/** Commitment-period bucket key: annual → the FY of `asOf`; lifetime → 'LIFETIME'. */
export function commitmentPeriodKey(period: CommitmentPeriod, asOf: Date): string {
  return period === 'ANNUAL' ? fyLabel(asOf) : 'LIFETIME';
}

export interface VolumeClassifyInput {
  committedQty: number | null;
  actualQty: number;
  /** Fraction of the commitment period elapsed, 0..1. */
  elapsedFraction: number;
}

export interface VolumeClassifyResult {
  status: VolumeTrackingStatus;
  pctOfCommitment: number | null;
  projectedPctOfCommitment: number | null;
}

/**
 * Classify take-or-pay commitment health. Projects year-end volume from the
 * current run-rate; a low projected fraction is the risk (under-commitment).
 */
export function classifyVolumeTracking(input: VolumeClassifyInput): VolumeClassifyResult {
  const { committedQty, actualQty, elapsedFraction } = input;
  if (!committedQty || committedQty <= 0) {
    return { status: 'ON_TRACK', pctOfCommitment: null, projectedPctOfCommitment: null };
  }
  const pct = actualQty / committedQty;
  // Too early in the period to extrapolate a meaningful run-rate.
  if (elapsedFraction <= 0.01) {
    return { status: 'ON_TRACK', pctOfCommitment: pct, projectedPctOfCommitment: null };
  }
  const projected = actualQty / elapsedFraction / committedQty;
  let status: VolumeTrackingStatus;
  if (projected >= VOLUME_ON_TRACK_THRESHOLD) status = 'ON_TRACK';
  else if (projected >= VOLUME_AT_RISK_THRESHOLD) status = 'AT_RISK';
  else status = 'SHORTFALL';
  return { status, pctOfCommitment: pct, projectedPctOfCommitment: projected };
}

export interface EscalationInput {
  currentRate: string;
  baseIndex: string;
  newIndex: string;
  /** Max permitted uplift %, e.g. '10' → rate can rise at most 10%. */
  capPct?: string | null;
}

export interface EscalationResult {
  proposedRate: string;
  upliftPct: string;
  capped: boolean;
}

/**
 * Basic indexed escalation: proposed = current × (newIndex / baseIndex), with the
 * uplift capped at `capPct` when configured. Linear index-ratio only — not a
 * derivatives-pricing engine (Slice 9 scope).
 */
export function computeEscalatedRate(input: EscalationInput): EscalationResult {
  const current = new Decimal(input.currentRate);
  const base = new Decimal(input.baseIndex);
  const next = new Decimal(input.newIndex);
  if (base.lessThanOrEqualTo(0)) {
    throw new Error('Base index value must be greater than zero.');
  }
  const ratio = next.dividedBy(base);
  let proposed = current.times(ratio);
  let uplift = proposed.minus(current).dividedBy(current).times(100);
  let capped = false;

  if (input.capPct != null && input.capPct !== '') {
    const cap = new Decimal(input.capPct);
    if (uplift.greaterThan(cap)) {
      proposed = current.times(cap.dividedBy(100).plus(1));
      uplift = cap;
      capped = true;
    }
  }
  return {
    proposedRate: proposed.toDecimalPlaces(4).toFixed(4),
    upliftPct: uplift.toDecimalPlaces(4).toFixed(4),
    capped,
  };
}

/**
 * Which renewal alert thresholds a contract has crossed given days-to-expiry.
 * Returns the alert types that should exist (idempotent set).
 */
export function crossedRenewalThresholds(
  daysToExpiry: number,
): ('NOTICE_90D' | 'NOTICE_60D' | 'NOTICE_30D' | 'EXPIRED')[] {
  const out: ('NOTICE_90D' | 'NOTICE_60D' | 'NOTICE_30D' | 'EXPIRED')[] = [];
  if (daysToExpiry < 0) out.push('EXPIRED');
  if (daysToExpiry <= 90) out.push('NOTICE_90D');
  if (daysToExpiry <= 60) out.push('NOTICE_60D');
  if (daysToExpiry <= 30) out.push('NOTICE_30D');
  return out;
}

/** Renewal-calendar bucket for a days-to-expiry value. */
export function renewalBucket(daysToExpiry: number): '90d' | '60d' | '30d' | 'expired' {
  if (daysToExpiry < 0) return 'expired';
  if (daysToExpiry <= 30) return '30d';
  if (daysToExpiry <= 60) return '60d';
  return '90d';
}

/** Whole days from `from` to `to` (UTC, floored). Negative when `to` is past. */
export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}
