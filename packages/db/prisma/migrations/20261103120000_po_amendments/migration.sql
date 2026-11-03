-- Maker-checker amendments for approved / issued purchase orders.
--
-- A buyer proposes new line prices or quantities with a reason; the change
-- routes through its own PO_AMENDMENT approval and is written onto the PO
-- lines only once approved.

-- AlterEnum
ALTER TYPE "DocumentType" ADD VALUE 'PO_AMENDMENT';

-- CreateEnum
CREATE TYPE "PoAmendmentStatus" AS ENUM ('AWAITING_APPROVAL', 'APPROVED', 'REJECTED', 'RETURNED');

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN "amendment_no" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PoAmendment" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "po_id" TEXT NOT NULL,
    "amendment_no" INTEGER NOT NULL,
    "status" "PoAmendmentStatus" NOT NULL DEFAULT 'AWAITING_APPROVAL',
    "reason" TEXT NOT NULL,
    "line_changes" JSONB NOT NULL,
    "before_total" DECIMAL(18,4) NOT NULL,
    "after_total" DECIMAL(18,4) NOT NULL,
    "approval_matrix_snapshot" JSONB,
    "requested_by" TEXT,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMPTZ(6),

    CONSTRAINT "PoAmendment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PoAmendment_tenant_id_idx" ON "PoAmendment"("tenant_id");

-- CreateIndex
CREATE INDEX "PoAmendment_po_id_idx" ON "PoAmendment"("po_id");

-- AddForeignKey
ALTER TABLE "PoAmendment" ADD CONSTRAINT "PoAmendment_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
