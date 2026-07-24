-- CreateEnum
CREATE TYPE "NonCatalogReason" AS ENUM ('NEW_PRODUCT', 'EMERGENCY', 'ONE_OFF_SPEND', 'OTHER');

-- CreateEnum
CREATE TYPE "RequisitionPriority" AS ENUM ('LOW', 'STANDARD', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "BudgetPeriodType" AS ENUM ('ANNUAL', 'QUARTERLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "BudgetRolloverPolicy" AS ENUM ('NONE', 'FULL', 'CAPPED');

-- CreateEnum
CREATE TYPE "BudgetCommitmentSource" AS ENUM ('PR', 'PO', 'SPOT_BUY');

-- CreateEnum
CREATE TYPE "BudgetCommitmentStatus" AS ENUM ('COMMITTED', 'PARTIALLY_TRANSFERRED', 'TRANSFERRED', 'RELEASED', 'CONSUMED');

-- CreateEnum
CREATE TYPE "BudgetAdjustmentType" AS ENUM ('TRANSFER_IN', 'TRANSFER_OUT', 'INCREASE', 'DECREASE');

-- CreateEnum
CREATE TYPE "PoType" AS ENUM ('STANDARD', 'SPOT_BUY', 'BLANKET', 'AMENDMENT');

-- CreateEnum
CREATE TYPE "CommentSource" AS ENUM ('BUYER', 'VENDOR');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PoStatus" ADD VALUE 'AWAITING_APPROVAL';
ALTER TYPE "PoStatus" ADD VALUE 'ACKNOWLEDGED';
ALTER TYPE "PoStatus" ADD VALUE 'PARTIALLY_INVOICED';
ALTER TYPE "PoStatus" ADD VALUE 'INVOICED';
ALTER TYPE "PoStatus" ADD VALUE 'ON_HOLD';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RequisitionStatus" ADD VALUE 'BUDGET_BREACH_HELD';
ALTER TYPE "RequisitionStatus" ADD VALUE 'AWAITING_APPROVAL';
ALTER TYPE "RequisitionStatus" ADD VALUE 'PARTIALLY_ISSUED';
ALTER TYPE "RequisitionStatus" ADD VALUE 'FULLY_ISSUED';
ALTER TYPE "RequisitionStatus" ADD VALUE 'WITHDRAWN';
ALTER TYPE "RequisitionStatus" ADD VALUE 'CLOSED';

-- AlterTable
ALTER TABLE "Delegation" ALTER COLUMN "document_types" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "acknowledged_at" TIMESTAMPTZ(6),
ADD COLUMN     "acknowledged_by" TEXT,
ADD COLUMN     "actual_delivery_date" TIMESTAMPTZ(6),
ADD COLUMN     "approval_matrix_snapshot" JSONB,
ADD COLUMN     "cancel_reason" TEXT,
ADD COLUMN     "cancelled_at" TIMESTAMPTZ(6),
ADD COLUMN     "created_by" TEXT,
ADD COLUMN     "delivery_address" JSONB,
ADD COLUMN     "delivery_terms" TEXT,
ADD COLUMN     "expected_delivery_date" TIMESTAMPTZ(6),
ADD COLUMN     "hold_reason" TEXT,
ADD COLUMN     "is_amendment_of" TEXT,
ADD COLUMN     "is_spot_buy" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "issued_by" TEXT,
ADD COLUMN     "payment_terms_snapshot" JSONB,
ADD COLUMN     "pdf_generated_hash" TEXT,
ADD COLUMN     "pdf_s3_key" TEXT,
ADD COLUMN     "po_type" "PoType" NOT NULL DEFAULT 'STANDARD';

-- AlterTable
ALTER TABLE "PurchaseOrderLine" ADD COLUMN     "delivery_date_line" TIMESTAMPTZ(6),
ADD COLUMN     "discount_pct" DECIMAL(6,4) NOT NULL DEFAULT 0,
ADD COLUMN     "hsn_code" TEXT,
ADD COLUMN     "item_id" TEXT,
ADD COLUMN     "line_total" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "pr_line_id" TEXT,
ADD COLUMN     "qty_cancelled" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "qty_invoiced" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Requisition" ADD COLUMN     "budget_breach_detail" JSONB,
ADD COLUMN     "business_justification" TEXT,
ADD COLUMN     "delivery_location" TEXT,
ADD COLUMN     "priority" "RequisitionPriority" NOT NULL DEFAULT 'STANDARD',
ADD COLUMN     "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "title" TEXT;

-- AlterTable
ALTER TABLE "RequisitionLine" ADD COLUMN     "discount_pct" DECIMAL(6,4) NOT NULL DEFAULT 0,
ADD COLUMN     "hsn_code" TEXT,
ADD COLUMN     "is_import_duty" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "is_reverse_charge" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "item_id" TEXT,
ADD COLUMN     "line_total" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "preferred_vendor_id" TEXT,
ADD COLUMN     "qty_issued" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "reason_code" "NonCatalogReason",
ADD COLUMN     "sku_code" TEXT,
ADD COLUMN     "sub_category" TEXT,
ADD COLUMN     "tax_amount" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "enforce_item_master" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "spot_buy_ceiling" DECIMAL(18,4) NOT NULL DEFAULT 50000;

-- CreateTable
CREATE TABLE "RequisitionComment" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requisition_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequisitionComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderComment" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "po_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "source" "CommentSource" NOT NULL DEFAULT 'BUYER',
    "is_query" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrderComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Item" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "sku_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "subcategory" TEXT,
    "hsn_code" TEXT NOT NULL,
    "gst_rate" DECIMAL(6,4) NOT NULL,
    "primary_uom" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_capex" BOOLEAN NOT NULL DEFAULT false,
    "default_gl_account" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemUomConversion" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "item_id" TEXT NOT NULL,
    "from_uom" TEXT NOT NULL,
    "to_uom" TEXT NOT NULL,
    "factor" DECIMAL(18,6) NOT NULL,

    CONSTRAINT "ItemUomConversion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemVendorPricing" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "item_id" TEXT NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "uom" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "valid_to" TIMESTAMPTZ(6),
    "contract_id" TEXT,
    "is_preferred" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ItemVendorPricing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "cost_center_id" TEXT NOT NULL,
    "period_type" "BudgetPeriodType" NOT NULL DEFAULT 'ANNUAL',
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "allocated_amount" DECIMAL(18,4) NOT NULL,
    "opening_balance" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "committed_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "consumed_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "rollover_policy" "BudgetRolloverPolicy" NOT NULL DEFAULT 'NONE',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetCommitment" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "budget_id" TEXT NOT NULL,
    "cost_center_id" TEXT NOT NULL,
    "source_type" "BudgetCommitmentSource" NOT NULL,
    "source_id" TEXT NOT NULL,
    "requisition_id" TEXT,
    "po_id" TEXT,
    "amount" DECIMAL(18,4) NOT NULL,
    "status" "BudgetCommitmentStatus" NOT NULL DEFAULT 'COMMITTED',
    "committed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committed_by" TEXT NOT NULL,
    "released_at" TIMESTAMPTZ(6),
    "release_reason" TEXT,

    CONSTRAINT "BudgetCommitment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetAdjustment" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "budget_id" TEXT NOT NULL,
    "adjustment_type" "BudgetAdjustmentType" NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "reason" TEXT NOT NULL,
    "related_budget_id" TEXT,
    "approved_by" TEXT NOT NULL,
    "approved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BudgetAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RequisitionComment_tenant_id_idx" ON "RequisitionComment"("tenant_id");

-- CreateIndex
CREATE INDEX "RequisitionComment_requisition_id_idx" ON "RequisitionComment"("requisition_id");

-- CreateIndex
CREATE INDEX "PurchaseOrderComment_tenant_id_idx" ON "PurchaseOrderComment"("tenant_id");

-- CreateIndex
CREATE INDEX "PurchaseOrderComment_po_id_idx" ON "PurchaseOrderComment"("po_id");

-- CreateIndex
CREATE INDEX "Item_tenant_id_idx" ON "Item"("tenant_id");

-- CreateIndex
CREATE INDEX "Item_tenant_id_category_idx" ON "Item"("tenant_id", "category");

-- CreateIndex
CREATE INDEX "Item_tenant_id_is_active_idx" ON "Item"("tenant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "Item_tenant_id_sku_code_key" ON "Item"("tenant_id", "sku_code");

-- CreateIndex
CREATE INDEX "ItemUomConversion_tenant_id_idx" ON "ItemUomConversion"("tenant_id");

-- CreateIndex
CREATE INDEX "ItemUomConversion_item_id_idx" ON "ItemUomConversion"("item_id");

-- CreateIndex
CREATE INDEX "ItemVendorPricing_tenant_id_idx" ON "ItemVendorPricing"("tenant_id");

-- CreateIndex
CREATE INDEX "ItemVendorPricing_item_id_idx" ON "ItemVendorPricing"("item_id");

-- CreateIndex
CREATE INDEX "ItemVendorPricing_vendor_id_idx" ON "ItemVendorPricing"("vendor_id");

-- CreateIndex
CREATE INDEX "Budget_tenant_id_idx" ON "Budget"("tenant_id");

-- CreateIndex
CREATE INDEX "Budget_tenant_id_cost_center_id_is_active_idx" ON "Budget"("tenant_id", "cost_center_id", "is_active");

-- CreateIndex
CREATE INDEX "BudgetCommitment_tenant_id_idx" ON "BudgetCommitment"("tenant_id");

-- CreateIndex
CREATE INDEX "BudgetCommitment_budget_id_idx" ON "BudgetCommitment"("budget_id");

-- CreateIndex
CREATE INDEX "BudgetCommitment_tenant_id_source_type_source_id_idx" ON "BudgetCommitment"("tenant_id", "source_type", "source_id");

-- CreateIndex
CREATE INDEX "BudgetAdjustment_tenant_id_idx" ON "BudgetAdjustment"("tenant_id");

-- CreateIndex
CREATE INDEX "BudgetAdjustment_budget_id_idx" ON "BudgetAdjustment"("budget_id");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_item_id_idx" ON "PurchaseOrderLine"("item_id");

-- CreateIndex
CREATE INDEX "RequisitionLine_item_id_idx" ON "RequisitionLine"("item_id");

-- AddForeignKey
ALTER TABLE "RequisitionLine" ADD CONSTRAINT "RequisitionLine_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "Item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequisitionComment" ADD CONSTRAINT "RequisitionComment_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "Requisition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "Item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderComment" ADD CONSTRAINT "PurchaseOrderComment_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemUomConversion" ADD CONSTRAINT "ItemUomConversion_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemVendorPricing" ADD CONSTRAINT "ItemVendorPricing_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemVendorPricing" ADD CONSTRAINT "ItemVendorPricing_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetCommitment" ADD CONSTRAINT "BudgetCommitment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetCommitment" ADD CONSTRAINT "BudgetCommitment_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "Budget"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetCommitment" ADD CONSTRAINT "BudgetCommitment_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "Requisition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetCommitment" ADD CONSTRAINT "BudgetCommitment_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetAdjustment" ADD CONSTRAINT "BudgetAdjustment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetAdjustment" ADD CONSTRAINT "BudgetAdjustment_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "Budget"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
