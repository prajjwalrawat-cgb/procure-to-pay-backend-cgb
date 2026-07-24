import { z } from 'zod';

import { STOCK_MOVEMENT_TYPE } from '../constants/status';

// ── Query ─────────────────────────────────────────────────────────────────

export const StockMovementsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().nullish(),
  itemId: z.string().nullish(),
  plantId: z.string().nullish(),
  movementType: z.enum(STOCK_MOVEMENT_TYPE).nullish(),
  from: z.string().datetime().nullish(),
  to: z.string().datetime().nullish(),
});
export type StockMovementsQuery = z.infer<typeof StockMovementsQuerySchema>;

// ── Read models ────────────────────────────────────────────────────────────

export interface StockBalanceView {
  itemId: string | null;
  itemDesc: string;
  plantId: string | null;
  balanceQty: string;
  unitCost: string;
  balanceValue: string;
  valuationMethod: string;
}

export interface StockMovementView {
  id: string;
  itemId: string | null;
  itemDesc: string;
  movementType: string;
  sourceType: string;
  sourceId: string;
  qtyDelta: string;
  unitLandedCost: string;
  balanceQtyAfter: string;
  balanceValueAfter: string;
  recordedAt: string;
  recordedBy: string;
}

export interface StockMovementsResponse {
  items: StockMovementView[];
  nextCursor: string | null;
  totalEstimate: number;
}
