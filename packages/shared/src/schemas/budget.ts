import { z } from 'zod';

import type { BudgetCommitmentStatus, BudgetPeriodType } from '../constants/status';

/** Result of a budget availability check (Slice 4). Pure read-model. */
export interface BudgetCheckResult {
  available: boolean;
  budgetId: string | null;
  costCenterId: string;
  allocated: string;
  committed: string;
  consumed: string;
  remaining: string;
  /** Amount by which this request would exceed the remaining budget, if any. */
  wouldBreachBy: string | null;
  period: { type: BudgetPeriodType; start: string; end: string } | null;
  currency: string;
}

export interface BudgetUtilization {
  budgetId: string;
  allocated: string;
  committed: string;
  consumed: string;
  remaining: string;
  committedPct: number;
  consumedPct: number;
  currency: string;
}

export interface BudgetCommitmentView {
  id: string;
  sourceType: 'PR' | 'PO' | 'SPOT_BUY';
  sourceId: string;
  amount: string;
  status: BudgetCommitmentStatus;
  committedAt: string;
  releasedAt: string | null;
}

export const BudgetAvailabilityQuerySchema = z.object({
  amount: z
    .string()
    .regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string')
    .default('0'),
  asOf: z.string().datetime().nullish(),
});
export type BudgetAvailabilityQuery = z.infer<typeof BudgetAvailabilityQuerySchema>;
