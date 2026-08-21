-- =============================================================================
-- Slice 13 - keep product_stock_summary honest about bin transfers.
--
-- The Slice 12 view derives Total IN as "any inward row that isn't an
-- ADJUSTMENT" and Total Out as "any outward row". Bin-to-bin transfers post one
-- outward and one inward leg, so under the original definition every internal
-- shelf move would inflate BOTH columns on the Master Inventory Sheet while
-- leaving current_stock (correctly) unchanged. Total IN means "arrived from
-- outside the warehouse"; a transfer never did.
--
-- Separate migration from the enum addition on purpose: Postgres refuses to use
-- a new enum label in the same transaction that added it.
-- =============================================================================

CREATE OR REPLACE VIEW product_stock_summary AS
SELECT
  "tenant_id",
  "product_id",
  COALESCE(SUM(CASE WHEN "txn_type" = 'ADJUSTMENT' AND "remark" = 'opening-stock'
                    THEN "qty" * "direction" ELSE 0 END), 0)::bigint  AS opening_stock,
  COALESCE(SUM(CASE WHEN "direction" = 1
                     AND "txn_type" NOT IN ('ADJUSTMENT', 'TRANSFER_IN')
                    THEN "qty" ELSE 0 END), 0)::bigint                AS total_in,
  COALESCE(SUM(CASE WHEN "direction" = -1 AND "txn_type" <> 'TRANSFER_OUT'
                    THEN "qty" ELSE 0 END), 0)::bigint                AS total_out,
  COALESCE(SUM(CASE WHEN "txn_type" IN ('CUSTOMER_RETURN_IN', 'INTERNAL_RETURN', 'VENDOR_RETURN_OUT')
                    THEN "qty" ELSE 0 END), 0)::bigint                AS return_qty,
  COALESCE(SUM(CASE WHEN "txn_type" = 'DAMAGE_WRITE_OFF' THEN "qty" ELSE 0 END)
         + SUM(COALESCE("damage_qty", 0)), 0)::bigint                 AS damage_qty,
  COALESCE(SUM("qty" * "direction"), 0)::bigint                       AS current_stock,
  MAX("txn_date")                                                     AS last_movement_at
FROM "StockLedgerEntry"
GROUP BY "tenant_id", "product_id";

-- CREATE OR REPLACE preserves the existing security_invoker setting, but re-assert
-- it defensively - a view that silently reverts to owner rights bypasses RLS.
DO $$
BEGIN
  EXECUTE 'ALTER VIEW product_stock_summary SET (security_invoker = on)';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'product_stock_summary: security_invoker unsupported on this server; relying on service-layer tenant filtering.';
END
$$;
