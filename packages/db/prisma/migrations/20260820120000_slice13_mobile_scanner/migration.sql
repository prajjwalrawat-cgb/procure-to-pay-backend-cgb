-- =============================================================================
-- Slice 13 - Mobile Scanner (ADR-037)
--
-- Scan-driven warehouse operations for the PWA on the floor. Additive only:
-- the Slice 12 immutable ledger keeps its shape and its insert-only trigger,
-- and every stock consequence of a scan is still a plain INSERT into
-- "StockLedgerEntry". ScanEvent is an audit trail beside the ledger, never a
-- replacement for it - drop every scan row and the on-hand numbers are
-- unchanged.
--
-- Four things this migration adds to existing tables:
--   Product.barcode                 the value the scanner resolves against
--   Product.requires_batch_tracking forces batch+expiry capture on receive
--   Location.barcode                the bin label (a bin is a leaf Location)
--   StockLedgerEntry.batch_number   per-consignment batch, for FEFO
--   StockLedgerEntry.expiry_date    per-consignment expiry, for FEFO
--
-- RLS policies for the five new tables are applied by
-- prisma/security/01-rls.sql via `pnpm security:apply` (run AFTER this migration).
-- =============================================================================

-- AlterEnum
-- Two new movement types for the bin-to-bin transfer's two legs. Postgres 12+
-- permits ADD VALUE inside a transaction as long as the new value is not *used*
-- in the same transaction; nothing below writes a transfer row, so this is safe.
ALTER TYPE "StockTxnType" ADD VALUE 'TRANSFER_OUT';
ALTER TYPE "StockTxnType" ADD VALUE 'TRANSFER_IN';

-- CreateEnum
CREATE TYPE "ScanType" AS ENUM ('RECEIVE', 'PUTAWAY', 'PICK', 'CYCLE_COUNT', 'TRANSFER');

-- CreateEnum
CREATE TYPE "CycleCountStatus" AS ENUM ('IN_PROGRESS', 'PENDING_REVIEW', 'APPROVED');

-- CreateEnum
CREATE TYPE "PickListStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'PICKED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "barcode" TEXT,
                      ADD COLUMN "requires_batch_tracking" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Location" ADD COLUMN "barcode" TEXT;

-- AlterTable
ALTER TABLE "StockLedgerEntry" ADD COLUMN "batch_number" TEXT,
                                ADD COLUMN "expiry_date" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "ScanEvent" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" TEXT NOT NULL,
    "scan_type" "ScanType" NOT NULL,
    "barcode_raw" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "location_id" TEXT,
    "bin_id" TEXT,
    "device_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "gps_lat" DOUBLE PRECISION,
    "gps_lng" DOUBLE PRECISION,
    "ledger_entry_id" TEXT,
    "session_id" TEXT,
    "client_uuid" TEXT NOT NULL,
    "client_timestamp" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "synced_at" TIMESTAMPTZ(6),

    CONSTRAINT "ScanEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CycleCountSession" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "location_id" TEXT NOT NULL,
    "status" "CycleCountStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "counted_by_id" TEXT NOT NULL,
    "approved_by_id" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "approved_at" TIMESTAMPTZ(6),
    "notes" TEXT,

    CONSTRAINT "CycleCountSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CycleCountVariance" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "expected_qty" INTEGER NOT NULL,
    "counted_qty" INTEGER NOT NULL,
    "delta_qty" INTEGER NOT NULL,
    "ledger_entry_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CycleCountVariance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PickList" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_ref" TEXT NOT NULL,
    "platform" TEXT,
    "status" "PickListStatus" NOT NULL DEFAULT 'OPEN',
    "customer_name" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "PickList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PickListLine" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "pick_list_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "qty_required" INTEGER NOT NULL,
    "qty_picked" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PickListLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Postgres treats NULLs as distinct in a unique index, so the many legacy rows
-- with no barcode coexist happily under this constraint.
CREATE UNIQUE INDEX "Product_tenant_id_barcode_key" ON "Product"("tenant_id", "barcode");

-- CreateIndex
CREATE UNIQUE INDEX "Location_tenant_id_barcode_key" ON "Location"("tenant_id", "barcode");

-- CreateIndex
-- FEFO allocation reads this: every batch of a product at one location, oldest
-- expiry first.
CREATE INDEX "StockLedgerEntry_product_id_location_id_expiry_date_idx"
  ON "StockLedgerEntry"("product_id", "location_id", "expiry_date");

-- CreateIndex
CREATE UNIQUE INDEX "ScanEvent_tenant_id_client_uuid_key" ON "ScanEvent"("tenant_id", "client_uuid");

-- CreateIndex
CREATE INDEX "ScanEvent_tenant_id_idx" ON "ScanEvent"("tenant_id");

-- CreateIndex
CREATE INDEX "ScanEvent_product_id_created_at_idx" ON "ScanEvent"("product_id", "created_at");

-- CreateIndex
CREATE INDEX "ScanEvent_device_id_synced_at_idx" ON "ScanEvent"("device_id", "synced_at");

-- CreateIndex
CREATE INDEX "ScanEvent_session_id_idx" ON "ScanEvent"("session_id");

-- CreateIndex
CREATE INDEX "CycleCountSession_tenant_id_idx" ON "CycleCountSession"("tenant_id");

-- CreateIndex
CREATE INDEX "CycleCountSession_tenant_id_status_idx" ON "CycleCountSession"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "CycleCountSession_location_id_started_at_idx" ON "CycleCountSession"("location_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "CycleCountVariance_session_id_product_id_key" ON "CycleCountVariance"("session_id", "product_id");

-- CreateIndex
CREATE INDEX "CycleCountVariance_tenant_id_idx" ON "CycleCountVariance"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "PickList_tenant_id_order_ref_key" ON "PickList"("tenant_id", "order_ref");

-- CreateIndex
CREATE INDEX "PickList_tenant_id_idx" ON "PickList"("tenant_id");

-- CreateIndex
CREATE INDEX "PickList_tenant_id_status_idx" ON "PickList"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PickListLine_pick_list_id_product_id_key" ON "PickListLine"("pick_list_id", "product_id");

-- CreateIndex
CREATE INDEX "PickListLine_tenant_id_idx" ON "PickListLine"("tenant_id");

-- AddForeignKey
ALTER TABLE "ScanEvent" ADD CONSTRAINT "ScanEvent_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanEvent" ADD CONSTRAINT "ScanEvent_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanEvent" ADD CONSTRAINT "ScanEvent_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanEvent" ADD CONSTRAINT "ScanEvent_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanEvent" ADD CONSTRAINT "ScanEvent_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "StockLedgerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanEvent" ADD CONSTRAINT "ScanEvent_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "CycleCountSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CycleCountSession" ADD CONSTRAINT "CycleCountSession_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CycleCountSession" ADD CONSTRAINT "CycleCountSession_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CycleCountVariance" ADD CONSTRAINT "CycleCountVariance_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CycleCountVariance" ADD CONSTRAINT "CycleCountVariance_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "CycleCountSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CycleCountVariance" ADD CONSTRAINT "CycleCountVariance_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickList" ADD CONSTRAINT "PickList_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickListLine" ADD CONSTRAINT "PickListLine_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickListLine" ADD CONSTRAINT "PickListLine_pick_list_id_fkey" FOREIGN KEY ("pick_list_id") REFERENCES "PickList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickListLine" ADD CONSTRAINT "PickListLine_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
