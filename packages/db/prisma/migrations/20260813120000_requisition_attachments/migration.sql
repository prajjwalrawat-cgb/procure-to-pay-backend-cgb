-- =============================================================================
-- Requisition attachments — replaces the stubbed "Attachments" wizard step.
--
-- Quotes, proforma invoices, specs and drawings that back a PR. The common SME
-- case is a vendor PI arriving over WhatsApp: the buyer uploads it here so the
-- price on the PR lines has evidence an approver can open.
--
-- A PROFORMA_INVOICE here is NOT a tax invoice — it stays on the PR and never
-- enters the Invoice / 3-way-match / payment path.
--
-- RLS for the new table is applied by prisma/security/01-rls.sql via
-- `pnpm security:apply` (run AFTER this migration).
-- =============================================================================

-- CreateEnum
CREATE TYPE "RequisitionAttachmentType" AS ENUM ('QUOTE', 'PROFORMA_INVOICE', 'SPECIFICATION', 'DRAWING', 'OTHER');

-- CreateTable
CREATE TABLE "RequisitionAttachment" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requisition_id" TEXT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "file_hash" TEXT NOT NULL,
    "doc_type" "RequisitionAttachmentType" NOT NULL DEFAULT 'OTHER',
    "note" TEXT,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_by" TEXT NOT NULL,

    CONSTRAINT "RequisitionAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RequisitionAttachment_tenant_id_idx" ON "RequisitionAttachment"("tenant_id");

-- CreateIndex
CREATE INDEX "RequisitionAttachment_requisition_id_idx" ON "RequisitionAttachment"("requisition_id");

-- AddForeignKey
ALTER TABLE "RequisitionAttachment" ADD CONSTRAINT "RequisitionAttachment_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "Requisition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
