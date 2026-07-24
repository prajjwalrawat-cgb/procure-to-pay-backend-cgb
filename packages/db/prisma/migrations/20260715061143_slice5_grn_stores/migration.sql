-- CreateEnum
CREATE TYPE "GrnStatus" AS ENUM ('DRAFT', 'PENDING_QC', 'POSTED', 'HOLD', 'REVERSED');

-- CreateEnum
CREATE TYPE "GrnReceiptType" AS ENUM ('FULL', 'PARTIAL', 'OVER_RECEIPT', 'RETURN_RECEIPT');

-- CreateEnum
CREATE TYPE "GrnPackingCondition" AS ENUM ('OK', 'DAMAGED_PACKING', 'WET', 'TAMPERED');

-- CreateEnum
CREATE TYPE "QcSampleType" AS ENUM ('ROUTINE', 'AQL', 'DESTRUCTIVE');

-- CreateEnum
CREATE TYPE "QcSampleResult" AS ENUM ('PASS', 'FAIL', 'CONDITIONAL_PASS');

-- CreateEnum
CREATE TYPE "QcDefectSeverity" AS ENUM ('NONE', 'MINOR', 'MAJOR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "GrnAttachmentType" AS ENUM ('DELIVERY_CHALLAN', 'INVOICE_COPY', 'COA', 'PACKING_PHOTO', 'DAMAGE_PHOTO', 'LAB_REPORT');

-- CreateEnum
CREATE TYPE "RmaReasonCode" AS ENUM ('DAMAGED', 'WRONG_ITEM', 'QUALITY_FAIL', 'OVER_SUPPLY');

-- CreateEnum
CREATE TYPE "RmaStatus" AS ENUM ('DRAFT', 'ISSUED', 'PICKED_UP', 'CREDIT_NOTE_RECEIVED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReturnFreightBorneBy" AS ENUM ('VENDOR', 'BUYER');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('GRN_RECEIPT', 'RMA_ISSUE', 'ADJUSTMENT', 'CONSUMPTION');

-- CreateEnum
CREATE TYPE "InventoryValuationMethod" AS ENUM ('WEIGHTED_AVERAGE', 'FIFO');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "GrnQcStatus" ADD VALUE 'NOT_STARTED';
ALTER TYPE "GrnQcStatus" ADD VALUE 'IN_PROGRESS';
ALTER TYPE "GrnQcStatus" ADD VALUE 'CONDITIONAL_PASS';
ALTER TYPE "GrnQcStatus" ADD VALUE 'WAIVED';

-- AlterTable
ALTER TABLE "GoodsReceiptNote" ADD COLUMN     "created_by" TEXT,
ADD COLUMN     "driver_name" TEXT,
ADD COLUMN     "driver_phone_last4" TEXT,
ADD COLUMN     "eway_bill_no" TEXT,
ADD COLUMN     "eway_bill_valid_until" TIMESTAMPTZ(6),
ADD COLUMN     "gate_entry_ref" TEXT,
ADD COLUMN     "gross_weight_kg" DECIMAL(18,4),
ADD COLUMN     "net_weight_kg" DECIMAL(18,4),
ADD COLUMN     "packing_condition" "GrnPackingCondition" NOT NULL DEFAULT 'OK',
ADD COLUMN     "posted_at" TIMESTAMPTZ(6),
ADD COLUMN     "posted_by" TEXT,
ADD COLUMN     "receipt_type" "GrnReceiptType" NOT NULL DEFAULT 'FULL',
ADD COLUMN     "requires_plant_head_signoff" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reversal_reason" TEXT,
ADD COLUMN     "reversed_at" TIMESTAMPTZ(6),
ADD COLUMN     "reversed_by" TEXT,
ADD COLUMN     "status" "GrnStatus" NOT NULL DEFAULT 'DRAFT',
ADD COLUMN     "tare_weight_kg" DECIMAL(18,4),
ADD COLUMN     "transporter" TEXT,
ADD COLUMN     "unloading_location" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "variance_flags" JSONB,
ADD COLUMN     "vehicle_no" TEXT,
ADD COLUMN     "weighbridge_slip_no" TEXT;

-- AlterTable
ALTER TABLE "GrnLine" ADD COLUMN     "batch_number" TEXT,
ADD COLUMN     "bin_code" TEXT,
ADD COLUMN     "expiry_date" TIMESTAMPTZ(6),
ADD COLUMN     "gl_stock_account" TEXT,
ADD COLUMN     "lot_number" TEXT,
ADD COLUMN     "manufacturing_date" TIMESTAMPTZ(6),
ADD COLUMN     "qty_received" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "qty_short" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "serial_numbers" TEXT[],
ADD COLUMN     "storage_location" TEXT,
ADD COLUMN     "unit_landed_cost" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "uom_conversion_factor" DECIMAL(18,6) NOT NULL DEFAULT 1,
ADD COLUMN     "uom_received" TEXT,
ADD COLUMN     "variance_flags" JSONB,
ALTER COLUMN "qtyAccepted" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "aql_level" TEXT,
ADD COLUMN     "qc_parameters" JSONB,
ADD COLUMN     "requires_batch" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requires_coa" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requires_qc" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requires_serial" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sampling_plan_ref" TEXT,
ADD COLUMN     "stock_gl_account" TEXT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "inventory_valuation_method" "InventoryValuationMethod" NOT NULL DEFAULT 'WEIGHTED_AVERAGE',
ADD COLUMN     "over_receipt_tolerance_pct" DECIMAL(6,4) NOT NULL DEFAULT 0.02;

-- CreateTable
CREATE TABLE "GrnQcSample" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "grn_line_id" TEXT NOT NULL,
    "sample_type" "QcSampleType" NOT NULL DEFAULT 'AQL',
    "sample_size" INTEGER NOT NULL,
    "sample_plan_ref" TEXT,
    "inspected_by" TEXT NOT NULL,
    "inspected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "parameters_measured" JSONB NOT NULL,
    "parameters_spec" JSONB NOT NULL,
    "result" "QcSampleResult" NOT NULL,
    "defects_found" TEXT[],
    "defect_severity" "QcDefectSeverity" NOT NULL DEFAULT 'NONE',
    "certificate_of_analysis_s3" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrnQcSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrnAttachment" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "grn_id" TEXT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "doc_type" "GrnAttachmentType" NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_by" TEXT NOT NULL,

    CONSTRAINT "GrnAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnMaterialAuth" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "grn_id" TEXT NOT NULL,
    "po_id" TEXT NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "reason_code" "RmaReasonCode" NOT NULL,
    "reason_notes" TEXT,
    "total_return_value" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "RmaStatus" NOT NULL DEFAULT 'DRAFT',
    "return_freight_borne_by" "ReturnFreightBorneBy" NOT NULL DEFAULT 'VENDOR',
    "issued_at" TIMESTAMPTZ(6),
    "picked_up_at" TIMESTAMPTZ(6),
    "pickup_scheduled_at" TIMESTAMPTZ(6),
    "credit_note_ref" TEXT,
    "credit_note_amount" DECIMAL(18,4),
    "credit_note_s3_key" TEXT,
    "vehicle_out_no" TEXT,
    "gate_pass_out_no" TEXT,
    "pdf_s3_key" TEXT,
    "pdf_generated_hash" TEXT,
    "created_by" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReturnMaterialAuth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnMaterialAuthLine" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rma_id" TEXT NOT NULL,
    "grn_line_id" TEXT NOT NULL,
    "qty_returned" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "return_reason_detail" TEXT,

    CONSTRAINT "ReturnMaterialAuthLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLedger" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "item_id" TEXT,
    "item_desc" TEXT NOT NULL,
    "cost_center_id" TEXT,
    "plant_id" TEXT,
    "movement_type" "StockMovementType" NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "qty_delta" DECIMAL(18,4) NOT NULL,
    "unit_landed_cost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "balance_qty_after" DECIMAL(18,4) NOT NULL,
    "balance_value_after" DECIMAL(18,4) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" TEXT NOT NULL,

    CONSTRAINT "StockLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GrnQcSample_tenant_id_idx" ON "GrnQcSample"("tenant_id");

-- CreateIndex
CREATE INDEX "GrnQcSample_grn_line_id_idx" ON "GrnQcSample"("grn_line_id");

-- CreateIndex
CREATE INDEX "GrnAttachment_tenant_id_idx" ON "GrnAttachment"("tenant_id");

-- CreateIndex
CREATE INDEX "GrnAttachment_grn_id_idx" ON "GrnAttachment"("grn_id");

-- CreateIndex
CREATE INDEX "ReturnMaterialAuth_tenant_id_idx" ON "ReturnMaterialAuth"("tenant_id");

-- CreateIndex
CREATE INDEX "ReturnMaterialAuth_tenant_id_status_idx" ON "ReturnMaterialAuth"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "ReturnMaterialAuth_grn_id_idx" ON "ReturnMaterialAuth"("grn_id");

-- CreateIndex
CREATE INDEX "ReturnMaterialAuth_vendor_id_idx" ON "ReturnMaterialAuth"("vendor_id");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnMaterialAuth_tenant_id_number_key" ON "ReturnMaterialAuth"("tenant_id", "number");

-- CreateIndex
CREATE INDEX "ReturnMaterialAuthLine_tenant_id_idx" ON "ReturnMaterialAuthLine"("tenant_id");

-- CreateIndex
CREATE INDEX "ReturnMaterialAuthLine_rma_id_idx" ON "ReturnMaterialAuthLine"("rma_id");

-- CreateIndex
CREATE INDEX "ReturnMaterialAuthLine_grn_line_id_idx" ON "ReturnMaterialAuthLine"("grn_line_id");

-- CreateIndex
CREATE INDEX "StockLedger_tenant_id_idx" ON "StockLedger"("tenant_id");

-- CreateIndex
CREATE INDEX "StockLedger_tenant_id_item_id_plant_id_idx" ON "StockLedger"("tenant_id", "item_id", "plant_id");

-- CreateIndex
CREATE INDEX "StockLedger_tenant_id_source_type_source_id_idx" ON "StockLedger"("tenant_id", "source_type", "source_id");

-- CreateIndex
CREATE INDEX "GoodsReceiptNote_tenant_id_status_idx" ON "GoodsReceiptNote"("tenant_id", "status");

-- AddForeignKey
ALTER TABLE "GrnQcSample" ADD CONSTRAINT "GrnQcSample_grn_line_id_fkey" FOREIGN KEY ("grn_line_id") REFERENCES "GrnLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrnAttachment" ADD CONSTRAINT "GrnAttachment_grn_id_fkey" FOREIGN KEY ("grn_id") REFERENCES "GoodsReceiptNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnMaterialAuth" ADD CONSTRAINT "ReturnMaterialAuth_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnMaterialAuth" ADD CONSTRAINT "ReturnMaterialAuth_grn_id_fkey" FOREIGN KEY ("grn_id") REFERENCES "GoodsReceiptNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnMaterialAuth" ADD CONSTRAINT "ReturnMaterialAuth_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnMaterialAuthLine" ADD CONSTRAINT "ReturnMaterialAuthLine_rma_id_fkey" FOREIGN KEY ("rma_id") REFERENCES "ReturnMaterialAuth"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnMaterialAuthLine" ADD CONSTRAINT "ReturnMaterialAuthLine_grn_line_id_fkey" FOREIGN KEY ("grn_line_id") REFERENCES "GrnLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLedger" ADD CONSTRAINT "StockLedger_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLedger" ADD CONSTRAINT "StockLedger_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "Item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLedger" ADD CONSTRAINT "StockLedger_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "Plant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLedger" ADD CONSTRAINT "StockLedger_cost_center_id_fkey" FOREIGN KEY ("cost_center_id") REFERENCES "CostCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;
