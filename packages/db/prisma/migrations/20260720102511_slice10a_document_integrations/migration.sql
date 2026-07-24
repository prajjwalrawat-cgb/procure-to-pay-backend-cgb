-- CreateEnum
CREATE TYPE "InvoiceAttachmentType" AS ENUM ('INVOICE_PDF', 'EMAIL_BODY', 'SUPPORTING');

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('OCR', 'GSP', 'EMAIL_INBOUND', 'PENNY_DROP', 'BANK', 'GSTN', 'PAN', 'UDYAM', 'MCA', 'SANCTIONS', 'ADVERSE_MEDIA', 'CREDIT_BUREAU', 'ISO_CERT', 'CAPTCHA');

-- CreateEnum
CREATE TYPE "InboundEmailStatus" AS ENUM ('RECEIVED', 'INVOICE_CREATED', 'PENDING_VENDOR_MATCH', 'DEAD_LETTER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InvoiceStatus" ADD VALUE 'OCR_LOW_CONFIDENCE';
ALTER TYPE "InvoiceStatus" ADD VALUE 'OCR_FAILED';
ALTER TYPE "InvoiceStatus" ADD VALUE 'PENDING_VENDOR_MATCH';

-- AlterTable
ALTER TABLE "InvoiceAttachment" ADD COLUMN     "doc_type" "InvoiceAttachmentType" NOT NULL DEFAULT 'INVOICE_PDF';

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "einvoice_turnover_threshold" DECIMAL(18,4) NOT NULL DEFAULT 50000000,
ADD COLUMN     "ocr_confidence_floor_pct" DECIMAL(5,2) NOT NULL DEFAULT 80;

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "email_domains" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "TenantIntegrationCredential" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "label" TEXT,
    "ciphertext" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_rotated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TenantIntegrationCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationUsageLog" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "operation" TEXT NOT NULL,
    "document_type" TEXT,
    "document_id" TEXT,
    "cost_micros" INTEGER NOT NULL DEFAULT 0,
    "outcome" TEXT NOT NULL DEFAULT 'OK',
    "simulated" BOOLEAN NOT NULL DEFAULT true,
    "latency_ms" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationUsageLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundEmail" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "from_email" TEXT NOT NULL,
    "from_domain" TEXT NOT NULL,
    "subject" TEXT,
    "status" "InboundEmailStatus" NOT NULL DEFAULT 'RECEIVED',
    "matched_vendor_id" TEXT,
    "invoice_id" TEXT,
    "body_s3_key" TEXT,
    "attachment_s3_key" TEXT,
    "attachment_name" TEXT,
    "dead_letter_reason" TEXT,
    "provider_message_id" TEXT,
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TenantIntegrationCredential_tenant_id_idx" ON "TenantIntegrationCredential"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "TenantIntegrationCredential_tenant_id_provider_key" ON "TenantIntegrationCredential"("tenant_id", "provider");

-- CreateIndex
CREATE INDEX "IntegrationUsageLog_tenant_id_idx" ON "IntegrationUsageLog"("tenant_id");

-- CreateIndex
CREATE INDEX "IntegrationUsageLog_tenant_id_provider_created_at_idx" ON "IntegrationUsageLog"("tenant_id", "provider", "created_at");

-- CreateIndex
CREATE INDEX "InboundEmail_tenant_id_idx" ON "InboundEmail"("tenant_id");

-- CreateIndex
CREATE INDEX "InboundEmail_tenant_id_status_idx" ON "InboundEmail"("tenant_id", "status");
