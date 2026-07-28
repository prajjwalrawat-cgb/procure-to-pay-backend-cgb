-- =============================================================================
-- Slice 12 - Inventory Management (ADR-036)
--
-- A native warehouse inventory module: product/location catalogue, ONE
-- insert-only immutable stock ledger, and a staged bulk-import pipeline.
--
-- Deliberately parallel to Slice 5's `StockLedger`, which stays untouched:
--   StockLedger      = financial ledger (Decimal qty, snapshot running balance,
--                      weighted-average/FIFO valuation, item + plant scoped)
--   StockLedgerEntry = physical warehouse ledger (integer pieces, product +
--                      location scoped, 9 movement types)
--
-- RLS policies for the five new tables are applied by
-- prisma/security/01-rls.sql via `pnpm security:apply` (run AFTER this migration).
-- =============================================================================

-- CreateEnum
CREATE TYPE "StockTxnType" AS ENUM ('VENDOR_INWARD', 'VENDOR_RETURN_OUT', 'SAMPLE_INWARD', 'INTERNAL_ISSUE', 'INTERNAL_RETURN', 'CUSTOMER_ORDER_OUT', 'CUSTOMER_RETURN_IN', 'DAMAGE_WRITE_OFF', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "IssueDept" AS ENUM ('PHOTOSHOOT', 'SALES', 'OTHER');

-- CreateEnum
CREATE TYPE "QcStatus" AS ENUM ('PENDING', 'OK', 'REJECTED');

-- CreateEnum
CREATE TYPE "ImportType" AS ENUM ('PRODUCT_MASTER', 'STOCK_LEDGER');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('PENDING', 'VALID', 'CREATED', 'UPDATED', 'ERROR', 'SKIPPED');

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "legacy_product_id" TEXT,
    "legacy_sku" TEXT,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "colour" TEXT,
    "image_url" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "reorder_point" INTEGER,
    "expiry_or_warranty_date" TIMESTAMPTZ(6),
    "remark" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "item_id" TEXT,
    "created_from_import_batch_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "rack_no" TEXT,
    "parent_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLedgerEntry" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "txn_type" "StockTxnType" NOT NULL,
    "qty" INTEGER NOT NULL,
    "direction" INTEGER NOT NULL,
    "vendor_id" TEXT,
    "purchase_order_id" TEXT,
    "invoice_id" TEXT,
    "grn_id" TEXT,
    "rma_id" TEXT,
    "grn_no" TEXT,
    "gate_pass_no" TEXT,
    "rate" DECIMAL(18,4),
    "tax_pct" DECIMAL(6,4),
    "qc_status" "QcStatus",
    "damage_qty" INTEGER DEFAULT 0,
    "issue_dept" "IssueDept",
    "issued_to_name" TEXT,
    "approved_by_id" TEXT,
    "balance_qty" INTEGER,
    "tentative_return_date" TIMESTAMPTZ(6),
    "issue_entry_id" TEXT,
    "platform" TEXT,
    "order_id" TEXT,
    "customer_name" TEXT,
    "courier_name" TEXT,
    "tracking_id" TEXT,
    "payment_mode" TEXT,
    "order_value" DECIMAL(18,4),
    "return_reason" TEXT,
    "product_condition" TEXT,
    "restock_decision" BOOLEAN,
    "correction_of_id" TEXT,
    "performed_by_id" TEXT NOT NULL,
    "remark" TEXT,
    "txn_date" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "import_batch_id" TEXT,
    "source_row_ref" TEXT,

    CONSTRAINT "StockLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "import_type" "ImportType" NOT NULL,
    "file_name" TEXT NOT NULL,
    "uploaded_by_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "success_rows" INTEGER NOT NULL DEFAULT 0,
    "error_rows" INTEGER NOT NULL DEFAULT 0,
    "skipped_rows" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRow" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "batch_id" TEXT NOT NULL,
    "row_number" INTEGER NOT NULL,
    "raw_data" JSONB NOT NULL,
    "status" "ImportRowStatus" NOT NULL DEFAULT 'PENDING',
    "product_id" TEXT,
    "ledger_entry_id" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Product_tenant_id_idx" ON "Product"("tenant_id");

-- CreateIndex
CREATE INDEX "Product_tenant_id_category_idx" ON "Product"("tenant_id", "category");

-- CreateIndex
CREATE INDEX "Product_tenant_id_active_idx" ON "Product"("tenant_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Product_tenant_id_code_key" ON "Product"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Product_tenant_id_name_colour_key" ON "Product"("tenant_id", "name", "colour");

-- CreateIndex
CREATE INDEX "Location_tenant_id_idx" ON "Location"("tenant_id");

-- CreateIndex
CREATE INDEX "Location_parent_id_idx" ON "Location"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "Location_tenant_id_name_rack_no_key" ON "Location"("tenant_id", "name", "rack_no");

-- CreateIndex
CREATE INDEX "StockLedgerEntry_tenant_id_idx" ON "StockLedgerEntry"("tenant_id");

-- CreateIndex
CREATE INDEX "StockLedgerEntry_product_id_location_id_idx" ON "StockLedgerEntry"("product_id", "location_id");

-- CreateIndex
CREATE INDEX "StockLedgerEntry_txn_type_txn_date_idx" ON "StockLedgerEntry"("txn_type", "txn_date");

-- CreateIndex
CREATE INDEX "StockLedgerEntry_tenant_id_txn_type_txn_date_idx" ON "StockLedgerEntry"("tenant_id", "txn_type", "txn_date");

-- CreateIndex
CREATE INDEX "StockLedgerEntry_tenant_id_order_id_idx" ON "StockLedgerEntry"("tenant_id", "order_id");

-- CreateIndex
CREATE INDEX "StockLedgerEntry_issue_entry_id_idx" ON "StockLedgerEntry"("issue_entry_id");

-- CreateIndex
CREATE INDEX "StockLedgerEntry_purchase_order_id_idx" ON "StockLedgerEntry"("purchase_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "StockLedgerEntry_import_batch_id_source_row_ref_key" ON "StockLedgerEntry"("import_batch_id", "source_row_ref");

-- CreateIndex
CREATE INDEX "ImportBatch_tenant_id_idx" ON "ImportBatch"("tenant_id");

-- CreateIndex
CREATE INDEX "ImportBatch_tenant_id_status_idx" ON "ImportBatch"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "ImportRow_batch_id_status_idx" ON "ImportRow"("batch_id", "status");

-- CreateIndex
CREATE INDEX "ImportRow_tenant_id_idx" ON "ImportRow"("tenant_id");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "Item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLedgerEntry" ADD CONSTRAINT "StockLedgerEntry_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLedgerEntry" ADD CONSTRAINT "StockLedgerEntry_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLedgerEntry" ADD CONSTRAINT "StockLedgerEntry_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLedgerEntry" ADD CONSTRAINT "StockLedgerEntry_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLedgerEntry" ADD CONSTRAINT "StockLedgerEntry_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLedgerEntry" ADD CONSTRAINT "StockLedgerEntry_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLedgerEntry" ADD CONSTRAINT "StockLedgerEntry_correction_of_id_fkey" FOREIGN KEY ("correction_of_id") REFERENCES "StockLedgerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLedgerEntry" ADD CONSTRAINT "StockLedgerEntry_issue_entry_id_fkey" FOREIGN KEY ("issue_entry_id") REFERENCES "StockLedgerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLedgerEntry" ADD CONSTRAINT "StockLedgerEntry_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "ImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: Slice 12 inventory policy knobs on Tenant.
ALTER TABLE "Tenant" ADD COLUMN "inventory_issue_approval_qty" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "Tenant" ADD COLUMN "inventory_issue_approval_value" DECIMAL(18,4) NOT NULL DEFAULT 25000;

-- ═══════════════════ Hand-written additions (not Prisma-generated) ═══════════

-- Postgres treats NULLs as distinct in a unique index, so
-- `Product_tenant_id_name_colour_key` would happily accept two rows with the
-- same name and a NULL colour. 533 of the 625 legacy rows have no colour, so
-- that hole is the common case, not an edge case. This partial index closes it
-- and keeps `(name, colour)` a genuine migration matching key.
CREATE UNIQUE INDEX "Product_tenant_id_name_null_colour_key"
  ON "Product" ("tenant_id", "name")
  WHERE "colour" IS NULL;

-- Ledger arithmetic invariants. `qty` is always positive; the sign lives in
-- `direction`, so SUM(qty * direction) is the one true current-stock query.
ALTER TABLE "StockLedgerEntry"
  ADD CONSTRAINT "StockLedgerEntry_qty_positive" CHECK ("qty" > 0);
ALTER TABLE "StockLedgerEntry"
  ADD CONSTRAINT "StockLedgerEntry_direction_sign" CHECK ("direction" IN (-1, 1));
ALTER TABLE "StockLedgerEntry"
  ADD CONSTRAINT "StockLedgerEntry_damage_qty_nonneg"
  CHECK ("damage_qty" IS NULL OR "damage_qty" >= 0);

-- ── Immutability (business rule 6) ───────────────────────────────────────────
-- The API exposes no update/delete route, but the guarantee belongs in the DB
-- too: a compromised app must not be able to rewrite stock history.
--
-- DELETE is blocked outright. UPDATE is blocked on every movement-defining
-- column, so quantities, direction, product, location, type, date and import
-- provenance can never be rewritten - mistakes are corrected with an offsetting
-- ADJUSTMENT entry linked via `correction_of_id`.
--
-- Three workflow columns stay mutable because the module's own design requires
-- post-insert transitions on them (they carry no stock arithmetic):
--   qc_status        PENDING -> OK/REJECTED   (business rule 2)
--   restock_decision NULL -> true/false       (business rule 5)
--   balance_qty      issue snapshot upkeep    (business rule 3; the authoritative
--                    open balance is always derived from linked INTERNAL_RETURN
--                    rows - see InventoryIssueService)
CREATE OR REPLACE FUNCTION stock_ledger_entry_immutable()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'StockLedgerEntry is insert-only: rows can never be deleted. Post an offsetting ADJUSTMENT entry with correction_of_id instead.';
  END IF;

  IF NEW."id"            IS DISTINCT FROM OLD."id"
  OR NEW."tenant_id"     IS DISTINCT FROM OLD."tenant_id"
  OR NEW."product_id"    IS DISTINCT FROM OLD."product_id"
  OR NEW."location_id"   IS DISTINCT FROM OLD."location_id"
  OR NEW."txn_type"      IS DISTINCT FROM OLD."txn_type"
  OR NEW."qty"           IS DISTINCT FROM OLD."qty"
  OR NEW."direction"     IS DISTINCT FROM OLD."direction"
  OR NEW."damage_qty"    IS DISTINCT FROM OLD."damage_qty"
  OR NEW."txn_date"      IS DISTINCT FROM OLD."txn_date"
  OR NEW."created_at"    IS DISTINCT FROM OLD."created_at"
  OR NEW."correction_of_id" IS DISTINCT FROM OLD."correction_of_id"
  OR NEW."import_batch_id"  IS DISTINCT FROM OLD."import_batch_id"
  OR NEW."source_row_ref"   IS DISTINCT FROM OLD."source_row_ref"
  OR NEW."performed_by_id"  IS DISTINCT FROM OLD."performed_by_id"
  THEN
    RAISE EXCEPTION
      'StockLedgerEntry movement columns are immutable. Post an offsetting ADJUSTMENT entry with correction_of_id instead.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS stock_ledger_entry_immutable_trg ON "StockLedgerEntry";
CREATE TRIGGER stock_ledger_entry_immutable_trg
  BEFORE UPDATE OR DELETE ON "StockLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_entry_immutable();

-- ── product_stock_summary ────────────────────────────────────────────────────
-- Every derived Master Inventory Sheet column (Opening Stock, IN, Total Out,
-- Return Qty., Damage Qty., Current Stock) as an aggregate over the immutable
-- ledger. Storing these as Product columns would let them drift out of sync,
-- which defeats the point of an insert-only design.
--
-- `tenant_id` is carried through and grouped so the view can never leak across
-- tenants, and `security_invoker` makes the view run with the *querying* role's
-- privileges so the underlying RLS policy on StockLedgerEntry applies (a plain
-- view would otherwise execute as its owner and bypass RLS entirely).
CREATE OR REPLACE VIEW product_stock_summary AS
SELECT
  "tenant_id",
  "product_id",
  COALESCE(SUM(CASE WHEN "txn_type" = 'ADJUSTMENT' AND "remark" = 'opening-stock'
                    THEN "qty" * "direction" ELSE 0 END), 0)::bigint  AS opening_stock,
  COALESCE(SUM(CASE WHEN "direction" = 1 AND "txn_type" <> 'ADJUSTMENT'
                    THEN "qty" ELSE 0 END), 0)::bigint                AS total_in,
  COALESCE(SUM(CASE WHEN "direction" = -1
                    THEN "qty" ELSE 0 END), 0)::bigint                AS total_out,
  COALESCE(SUM(CASE WHEN "txn_type" IN ('CUSTOMER_RETURN_IN', 'INTERNAL_RETURN', 'VENDOR_RETURN_OUT')
                    THEN "qty" ELSE 0 END), 0)::bigint                AS return_qty,
  COALESCE(SUM(CASE WHEN "txn_type" = 'DAMAGE_WRITE_OFF' THEN "qty" ELSE 0 END)
         + SUM(COALESCE("damage_qty", 0)), 0)::bigint                 AS damage_qty,
  COALESCE(SUM("qty" * "direction"), 0)::bigint                       AS current_stock,
  MAX("txn_date")                                                     AS last_movement_at
FROM "StockLedgerEntry"
GROUP BY "tenant_id", "product_id";

-- security_invoker needs Postgres 15+. Supabase runs 15/16, but degrade to a
-- notice rather than failing the migration on an older server - the service
-- layer filters by tenant_id on every read regardless.
DO $$
BEGIN
  EXECUTE 'ALTER VIEW product_stock_summary SET (security_invoker = on)';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'product_stock_summary: security_invoker unsupported on this server; relying on service-layer tenant filtering.';
END
$$;
