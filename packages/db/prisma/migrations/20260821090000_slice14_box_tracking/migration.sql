-- =============================================================================
-- PROPOSED — Slice 14: physical box tracking (ADR-038)
--
-- Draft. Not applied to any database.
--
-- Additive to Slice 12/13. The ledger keeps its shape, its insert-only trigger
-- and its grain; box contents are DERIVED from it via the new box_id column,
-- never stored as a quantity anywhere.
--
-- Hierarchy: Warehouse -> Rack -> Section uses the existing Location tree
-- (`parent_id`), now labelled by `kind`. A Box is NOT part of that tree — it
-- moves, and a moving Location node would rewrite the history of every ledger
-- row pointing at it.
--
-- RLS for the two new tables is applied by prisma/security/01-rls.sql via
-- `pnpm security:apply` (run AFTER this migration).
-- =============================================================================

-- CreateEnum
CREATE TYPE "LocationKind" AS ENUM ('WAREHOUSE', 'RACK', 'SECTION', 'DOCK', 'OTHER');

-- AlterTable
-- Defaults to OTHER: the migrated legacy rows are free text and classifying
-- them is a data exercise, not something a migration should guess at.
ALTER TABLE "Location" ADD COLUMN "kind" "LocationKind" NOT NULL DEFAULT 'OTHER';

-- AlterTable
ALTER TABLE "StockLedgerEntry" ADD COLUMN "box_id" TEXT;

-- AlterTable
ALTER TABLE "ScanEvent" ADD COLUMN "box_id" TEXT;

-- CreateTable
CREATE TABLE "Box" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "barcode" TEXT NOT NULL,
    "location_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Box_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoxMove" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "box_id" TEXT NOT NULL,
    "from_location_id" TEXT,
    "to_location_id" TEXT NOT NULL,
    "entries_posted" INTEGER NOT NULL DEFAULT 0,
    "moved_by_id" TEXT NOT NULL,
    "moved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoxMove_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Box_tenant_id_code_key" ON "Box"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Box_tenant_id_barcode_key" ON "Box"("tenant_id", "barcode");

-- CreateIndex
CREATE INDEX "Box_tenant_id_idx" ON "Box"("tenant_id");

-- CreateIndex
CREATE INDEX "Box_location_id_idx" ON "Box"("location_id");

-- CreateIndex
CREATE INDEX "BoxMove_tenant_id_idx" ON "BoxMove"("tenant_id");

-- CreateIndex
CREATE INDEX "BoxMove_box_id_moved_at_idx" ON "BoxMove"("box_id", "moved_at");

-- CreateIndex
-- "What is in this box" — the contents aggregate.
CREATE INDEX "StockLedgerEntry_box_id_product_id_idx"
  ON "StockLedgerEntry"("box_id", "product_id");

-- CreateIndex
-- "Where is this product" — the reverse lookup.
CREATE INDEX "StockLedgerEntry_product_id_box_id_idx"
  ON "StockLedgerEntry"("product_id", "box_id");

-- CreateIndex
CREATE INDEX "Location_tenant_id_kind_idx" ON "Location"("tenant_id", "kind");

-- CreateIndex
CREATE INDEX "ScanEvent_box_id_idx" ON "ScanEvent"("box_id");

-- AddForeignKey
ALTER TABLE "Box" ADD CONSTRAINT "Box_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Box" ADD CONSTRAINT "Box_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoxMove" ADD CONSTRAINT "BoxMove_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoxMove" ADD CONSTRAINT "BoxMove_box_id_fkey" FOREIGN KEY ("box_id") REFERENCES "Box"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoxMove" ADD CONSTRAINT "BoxMove_from_location_id_fkey" FOREIGN KEY ("from_location_id") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoxMove" ADD CONSTRAINT "BoxMove_to_location_id_fkey" FOREIGN KEY ("to_location_id") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLedgerEntry" ADD CONSTRAINT "StockLedgerEntry_box_id_fkey" FOREIGN KEY ("box_id") REFERENCES "Box"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanEvent" ADD CONSTRAINT "ScanEvent_box_id_fkey" FOREIGN KEY ("box_id") REFERENCES "Box"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── immutability ────────────────────────────────────────────────────────────
-- `box_id` is part of the movement record: which box the stock went into is as
-- factual as how many units moved. Without adding it here, the one column that
-- decides where boxed stock physically lives would be the only quantity-bearing
-- field on the row that could be rewritten after the fact.
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
  OR NEW."box_id"        IS DISTINCT FROM OLD."box_id"
  OR NEW."txn_type"      IS DISTINCT FROM OLD."txn_type"
  OR NEW."qty"           IS DISTINCT FROM OLD."qty"
  OR NEW."direction"     IS DISTINCT FROM OLD."direction"
  OR NEW."damage_qty"    IS DISTINCT FROM OLD."damage_qty"
  OR NEW."batch_number"  IS DISTINCT FROM OLD."batch_number"
  OR NEW."expiry_date"   IS DISTINCT FROM OLD."expiry_date"
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

-- ── box_contents ────────────────────────────────────────────────────────────
-- "What is in this box", derived. No stored quantity anywhere: this is the same
-- SUM(qty * direction) rule the rest of the module uses, so a box's contents can
-- never disagree with the ledger that produced them.
--
-- security_invoker so the underlying RLS policy on StockLedgerEntry applies —
-- a plain view would run as its owner and bypass tenant isolation entirely.
CREATE OR REPLACE VIEW box_contents AS
SELECT
  e."tenant_id",
  e."box_id",
  e."product_id",
  e."batch_number",
  e."expiry_date",
  COALESCE(SUM(e."qty" * e."direction"), 0)::bigint AS qty
FROM "StockLedgerEntry" e
WHERE e."box_id" IS NOT NULL
GROUP BY e."tenant_id", e."box_id", e."product_id", e."batch_number", e."expiry_date"
HAVING COALESCE(SUM(e."qty" * e."direction"), 0) > 0;

DO $$
BEGIN
  EXECUTE 'ALTER VIEW box_contents SET (security_invoker = on)';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'box_contents: security_invoker unsupported on this server; relying on service-layer tenant filtering.';
END
$$;
