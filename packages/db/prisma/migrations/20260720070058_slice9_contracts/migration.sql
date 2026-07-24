-- CreateEnum
CREATE TYPE "ContractType" AS ENUM ('RATE_CONTRACT', 'FRAMEWORK_AGREEMENT', 'BLANKET_PO', 'SERVICE_AGREEMENT');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('DRAFT', 'UNDER_NEGOTIATION', 'AWAITING_APPROVAL', 'APPROVED', 'ACTIVE', 'AWAITING_VENDOR_SIGNATURE', 'EXPIRING_SOON', 'EXPIRED', 'TERMINATED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "CommitmentPeriod" AS ENUM ('ANNUAL', 'CONTRACT_LIFETIME');

-- CreateEnum
CREATE TYPE "ContractClauseType" AS ENUM ('PAYMENT_TERMS', 'DELIVERY_SLA', 'QUALITY_STANDARD', 'PENALTY', 'FORCE_MAJEURE', 'CONFIDENTIALITY', 'IP', 'TERMINATION', 'LIABILITY', 'INSURANCE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "EscalationType" AS ENUM ('INDEXED', 'FIXED_STEP');

-- CreateEnum
CREATE TYPE "VolumeTrackingStatus" AS ENUM ('ON_TRACK', 'AT_RISK', 'SHORTFALL');

-- CreateEnum
CREATE TYPE "ContractDocType" AS ENUM ('EXECUTED_PDF', 'AMENDMENT', 'VENDOR_COUNTERSIGNED', 'SUPPORTING_ANNEXURE');

-- CreateEnum
CREATE TYPE "ContractRenewalAlertType" AS ENUM ('NOTICE_90D', 'NOTICE_60D', 'NOTICE_30D', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RenewalAlertAction" AS ENUM ('RENEWED', 'ALLOWED_TO_EXPIRE', 'TERMINATED_EARLY', 'UNDER_NEGOTIATION');

-- CreateEnum
CREATE TYPE "ContractAmendmentStatus" AS ENUM ('DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'REJECTED');

-- AlterEnum
ALTER TYPE "DocumentType" ADD VALUE 'CONTRACT_AMENDMENT';

-- AlterEnum
ALTER TYPE "PoType" ADD VALUE 'CONTRACT_CALLOFF';

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "contract_id" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrderLine" ADD COLUMN     "contract_line_id" TEXT;

-- CreateTable
CREATE TABLE "Contract" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "contract_type" "ContractType" NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "rfq_id" TEXT,
    "status" "ContractStatus" NOT NULL DEFAULT 'DRAFT',
    "validity_start" TIMESTAMPTZ(6) NOT NULL,
    "validity_end" TIMESTAMPTZ(6) NOT NULL,
    "auto_renew" BOOLEAN NOT NULL DEFAULT false,
    "renewal_notice_days" INTEGER NOT NULL DEFAULT 90,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "total_value_estimate" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "minimum_commitment_value" DECIMAL(18,4),
    "minimum_commitment_qty" DECIMAL(18,4),
    "commitment_uom" TEXT,
    "commitment_period" "CommitmentPeriod" NOT NULL DEFAULT 'ANNUAL',
    "payment_terms_snapshot" JSONB,
    "escalation_clause" JSONB,
    "termination_notice_days" INTEGER NOT NULL DEFAULT 30,
    "governing_law" TEXT,
    "dispute_resolution" TEXT,
    "require_vendor_countersign" BOOLEAN NOT NULL DEFAULT false,
    "skip_po_approval_within_contract" BOOLEAN NOT NULL DEFAULT true,
    "max_call_off_value" DECIMAL(18,4),
    "parent_contract_id" TEXT,
    "supersedes_contract_id" TEXT,
    "approval_matrix_snapshot" JSONB,
    "amendment_no" INTEGER NOT NULL DEFAULT 0,
    "pdf_s3_key" TEXT,
    "pdf_generated_hash" TEXT,
    "executed_at" TIMESTAMPTZ(6),
    "executed_by" TEXT,
    "vendor_signed_at" TIMESTAMPTZ(6),
    "terminated_at" TIMESTAMPTZ(6),
    "termination_reason" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractRateCard" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contract_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "item_id" TEXT,
    "item_desc" TEXT NOT NULL,
    "uom" TEXT NOT NULL,
    "rate_year" INTEGER NOT NULL DEFAULT 1,
    "unit_rate" DECIMAL(18,4) NOT NULL,
    "tax_rate" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "volume_band_min" DECIMAL(18,4),
    "volume_band_max" DECIMAL(18,4),
    "route_origin" TEXT,
    "route_destination" TEXT,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "effective_to" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ContractRateCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractClause" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contract_id" TEXT NOT NULL,
    "clause_type" "ContractClauseType" NOT NULL,
    "title" TEXT NOT NULL,
    "content_text" TEXT NOT NULL,
    "is_from_library" BOOLEAN NOT NULL DEFAULT false,
    "library_clause_id" TEXT,
    "order_no" INTEGER NOT NULL,
    "is_mandatory" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ContractClause_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClauseLibrary" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "clause_type" "ContractClauseType" NOT NULL,
    "title" TEXT NOT NULL,
    "content_text" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClauseLibrary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractDocument" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contract_id" TEXT NOT NULL,
    "doc_type" "ContractDocType" NOT NULL,
    "s3_key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "file_hash" TEXT,
    "mime_type" TEXT,
    "size_bytes" INTEGER,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_by" TEXT,

    CONSTRAINT "ContractDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractCallOff" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contract_id" TEXT NOT NULL,
    "po_id" TEXT NOT NULL,
    "rate_card_id_used" TEXT,
    "qty" DECIMAL(18,4) NOT NULL,
    "value" DECIMAL(18,4) NOT NULL,
    "called_off_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "called_off_by" TEXT,

    CONSTRAINT "ContractCallOff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractVolumeTracking" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contract_id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "committed_qty" DECIMAL(18,4),
    "actual_qty" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "committed_value" DECIMAL(18,4),
    "actual_value" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "shortfall_qty" DECIMAL(18,4),
    "shortfall_value" DECIMAL(18,4),
    "status" "VolumeTrackingStatus" NOT NULL DEFAULT 'ON_TRACK',
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ContractVolumeTracking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractAmendment" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contract_id" TEXT NOT NULL,
    "amendment_no" INTEGER NOT NULL,
    "status" "ContractAmendmentStatus" NOT NULL DEFAULT 'DRAFT',
    "change_summary" TEXT NOT NULL,
    "changed_fields" JSONB NOT NULL,
    "change_value" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "approval_matrix_snapshot" JSONB,
    "requested_by" TEXT,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMPTZ(6),
    "approved_by" TEXT,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ContractAmendment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractRenewalAlert" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contract_id" TEXT NOT NULL,
    "alert_type" "ContractRenewalAlertType" NOT NULL,
    "triggered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMPTZ(6),
    "acknowledged_by" TEXT,
    "action_taken" "RenewalAlertAction",

    CONSTRAINT "ContractRenewalAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Contract_tenant_id_idx" ON "Contract"("tenant_id");

-- CreateIndex
CREATE INDEX "Contract_tenant_id_status_idx" ON "Contract"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "Contract_tenant_id_validity_end_idx" ON "Contract"("tenant_id", "validity_end");

-- CreateIndex
CREATE INDEX "Contract_vendor_id_idx" ON "Contract"("vendor_id");

-- CreateIndex
CREATE UNIQUE INDEX "Contract_tenant_id_number_key" ON "Contract"("tenant_id", "number");

-- CreateIndex
CREATE INDEX "ContractRateCard_tenant_id_idx" ON "ContractRateCard"("tenant_id");

-- CreateIndex
CREATE INDEX "ContractRateCard_contract_id_idx" ON "ContractRateCard"("contract_id");

-- CreateIndex
CREATE INDEX "ContractClause_tenant_id_idx" ON "ContractClause"("tenant_id");

-- CreateIndex
CREATE INDEX "ContractClause_contract_id_idx" ON "ContractClause"("contract_id");

-- CreateIndex
CREATE INDEX "ClauseLibrary_tenant_id_idx" ON "ClauseLibrary"("tenant_id");

-- CreateIndex
CREATE INDEX "ClauseLibrary_tenant_id_clause_type_idx" ON "ClauseLibrary"("tenant_id", "clause_type");

-- CreateIndex
CREATE INDEX "ContractDocument_tenant_id_idx" ON "ContractDocument"("tenant_id");

-- CreateIndex
CREATE INDEX "ContractDocument_contract_id_idx" ON "ContractDocument"("contract_id");

-- CreateIndex
CREATE INDEX "ContractCallOff_tenant_id_idx" ON "ContractCallOff"("tenant_id");

-- CreateIndex
CREATE INDEX "ContractCallOff_contract_id_idx" ON "ContractCallOff"("contract_id");

-- CreateIndex
CREATE INDEX "ContractCallOff_po_id_idx" ON "ContractCallOff"("po_id");

-- CreateIndex
CREATE INDEX "ContractVolumeTracking_tenant_id_idx" ON "ContractVolumeTracking"("tenant_id");

-- CreateIndex
CREATE INDEX "ContractVolumeTracking_contract_id_idx" ON "ContractVolumeTracking"("contract_id");

-- CreateIndex
CREATE UNIQUE INDEX "ContractVolumeTracking_contract_id_period_key" ON "ContractVolumeTracking"("contract_id", "period");

-- CreateIndex
CREATE INDEX "ContractAmendment_tenant_id_idx" ON "ContractAmendment"("tenant_id");

-- CreateIndex
CREATE INDEX "ContractAmendment_contract_id_idx" ON "ContractAmendment"("contract_id");

-- CreateIndex
CREATE INDEX "ContractRenewalAlert_tenant_id_idx" ON "ContractRenewalAlert"("tenant_id");

-- CreateIndex
CREATE INDEX "ContractRenewalAlert_contract_id_idx" ON "ContractRenewalAlert"("contract_id");

-- CreateIndex
CREATE UNIQUE INDEX "ContractRenewalAlert_contract_id_alert_type_key" ON "ContractRenewalAlert"("contract_id", "alert_type");

-- CreateIndex
CREATE INDEX "PurchaseOrder_contract_id_idx" ON "PurchaseOrder"("contract_id");

-- AddForeignKey
ALTER TABLE "ContractRateCard" ADD CONSTRAINT "ContractRateCard_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractClause" ADD CONSTRAINT "ContractClause_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractDocument" ADD CONSTRAINT "ContractDocument_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractCallOff" ADD CONSTRAINT "ContractCallOff_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractVolumeTracking" ADD CONSTRAINT "ContractVolumeTracking_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractAmendment" ADD CONSTRAINT "ContractAmendment_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractRenewalAlert" ADD CONSTRAINT "ContractRenewalAlert_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;
