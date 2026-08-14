-- =============================================================================
-- PO attachments + PO terms — the two tables a PR-less purchase order needs.
--
-- PurchaseOrderAttachment holds the offline vendor quote a spot buy is raised
-- against. With no PR behind the order there is nowhere else for that evidence
-- to live, and an approver signing a six-figure PO has to be able to open the
-- quote it was priced from. Buyer-side only — never exposed on the vendor
-- portal, since a quote comparison or an internal note must not leak back to
-- the supplier.
--
-- PurchaseOrderTerm holds the terms & conditions printed on the PDF: rows
-- copied out of ClauseLibrary at selection time, plus any special conditions
-- typed for this order alone. Copied rather than referenced so re-issuing an
-- old PO reproduces the wording that was actually agreed, the same snapshot
-- rule ContractClause follows; `library_clause_id` is provenance only and is
-- deliberately not a foreign key, so retiring a library clause cannot orphan
-- or rewrite a PO already sent to a vendor.
--
-- RLS for both tables is applied by prisma/security/01-rls.sql via
-- `pnpm security:apply` (run AFTER this migration).
-- =============================================================================

-- CreateEnum
CREATE TYPE "PoAttachmentType" AS ENUM ('QUOTE', 'PROFORMA_INVOICE', 'EMAIL_APPROVAL', 'SPECIFICATION', 'DRAWING', 'OTHER');

-- CreateTable
CREATE TABLE "PurchaseOrderAttachment" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "po_id" TEXT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "file_hash" TEXT NOT NULL,
    "doc_type" "PoAttachmentType" NOT NULL DEFAULT 'OTHER',
    "note" TEXT,
    "added_after_issue" BOOLEAN NOT NULL DEFAULT false,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_by" TEXT NOT NULL,

    CONSTRAINT "PurchaseOrderAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderTerm" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "po_id" TEXT NOT NULL,
    "clause_type" "ContractClauseType" NOT NULL,
    "title" TEXT NOT NULL,
    "content_text" TEXT NOT NULL,
    "is_from_library" BOOLEAN NOT NULL DEFAULT false,
    "library_clause_id" TEXT,
    "order_no" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrderTerm_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PurchaseOrderAttachment_tenant_id_idx" ON "PurchaseOrderAttachment"("tenant_id");

-- CreateIndex
CREATE INDEX "PurchaseOrderAttachment_po_id_idx" ON "PurchaseOrderAttachment"("po_id");

-- CreateIndex
CREATE INDEX "PurchaseOrderTerm_tenant_id_idx" ON "PurchaseOrderTerm"("tenant_id");

-- CreateIndex
CREATE INDEX "PurchaseOrderTerm_po_id_order_no_idx" ON "PurchaseOrderTerm"("po_id", "order_no");

-- AddForeignKey
ALTER TABLE "PurchaseOrderAttachment" ADD CONSTRAINT "PurchaseOrderAttachment_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderTerm" ADD CONSTRAINT "PurchaseOrderTerm_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
