-- CreateEnum
CREATE TYPE "ExceptionType" AS ENUM ('RATE_VARIANCE', 'QTY_VARIANCE', 'TAX_VARIANCE', 'UNAUTHORISED_LINE', 'PO_MISSING', 'GRN_MISSING', 'DUPLICATE', 'GSTIN_INACTIVE', 'GSTR2B_MISMATCH');

-- AlterEnum
BEGIN;
CREATE TYPE "InvoiceStatus_new" AS ENUM ('RECEIVED', 'OCR_PENDING', 'OCR_DONE', 'MATCH_EXCEPTION', 'AWAITING_APPROVAL', 'APPROVED', 'SCHEDULED', 'PAID', 'HELD', 'REJECTED');
ALTER TABLE "Invoice" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Invoice" ALTER COLUMN "status" TYPE "InvoiceStatus_new" USING ("status"::text::"InvoiceStatus_new");
ALTER TYPE "InvoiceStatus" RENAME TO "InvoiceStatus_old";
ALTER TYPE "InvoiceStatus_new" RENAME TO "InvoiceStatus";
DROP TYPE "InvoiceStatus_old";
ALTER TABLE "Invoice" ALTER COLUMN "status" SET DEFAULT 'RECEIVED';
COMMIT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "assigned_to_id" TEXT,
ADD COLUMN     "holdReason" TEXT,
ADD COLUMN     "ocr_job_id" TEXT;

-- AlterTable
ALTER TABLE "InvoiceException" DROP COLUMN "exceptionType",
ADD COLUMN     "exception_type" "ExceptionType" NOT NULL,
ADD COLUMN     "invoice_line_id" TEXT,
ADD COLUMN     "po_line_id" TEXT;

-- CreateTable
CREATE TABLE "TenantMatchConfig" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "priceVariancePct" DECIMAL(6,4) NOT NULL DEFAULT 0.005,
    "qtyVariancePct" DECIMAL(6,4) NOT NULL DEFAULT 0.02,
    "qtyVarianceAbs" DECIMAL(18,4) NOT NULL DEFAULT 1,
    "taxExact" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TenantMatchConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceComment" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantMatchConfig_tenant_id_key" ON "TenantMatchConfig"("tenant_id");

-- CreateIndex
CREATE INDEX "TenantMatchConfig_tenant_id_idx" ON "TenantMatchConfig"("tenant_id");

-- CreateIndex
CREATE INDEX "InvoiceComment_tenant_id_idx" ON "InvoiceComment"("tenant_id");

-- CreateIndex
CREATE INDEX "InvoiceComment_invoice_id_idx" ON "InvoiceComment"("invoice_id");

-- CreateIndex
CREATE INDEX "Invoice_tenant_id_assigned_to_id_idx" ON "Invoice"("tenant_id", "assigned_to_id");

-- CreateIndex
CREATE INDEX "InvoiceException_tenant_id_exception_type_idx" ON "InvoiceException"("tenant_id", "exception_type");

-- AddForeignKey
ALTER TABLE "TenantMatchConfig" ADD CONSTRAINT "TenantMatchConfig_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceComment" ADD CONSTRAINT "InvoiceComment_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

