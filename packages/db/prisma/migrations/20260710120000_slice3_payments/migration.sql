-- Slice 3 — Payment runs.
-- Adds BankAccount + PaymentRecord tables, payment-run bank-file/columns, the
-- Invoice.paid_at posting timestamp, and the new PaymentRunStatus values used by
-- the composer → approval → bank-submission flow.

-- AlterEnum: new payment-run lifecycle states (append-only; PG15 allows ADD VALUE
-- in a transaction as long as the value is not used in the same transaction).
ALTER TYPE "PaymentRunStatus" ADD VALUE 'AWAITING_APPROVAL';
ALTER TYPE "PaymentRunStatus" ADD VALUE 'SUBMITTED_TO_BANK';
ALTER TYPE "PaymentRunStatus" ADD VALUE 'COMPLETED';
ALTER TYPE "PaymentRunStatus" ADD VALUE 'FAILED';

-- AlterTable: Invoice payment posting timestamp.
ALTER TABLE "Invoice" ADD COLUMN "paid_at" TIMESTAMPTZ(6);

-- AlterTable: PaymentRun bank-file + composer metadata.
ALTER TABLE "PaymentRun"
  ADD COLUMN "name" TEXT,
  ADD COLUMN "bank_account_id" TEXT,
  ADD COLUMN "bank_file_s3_key" TEXT,
  ADD COLUMN "bank_file_hash" TEXT,
  ADD COLUMN "preview_hash" TEXT;

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "bankName" TEXT NOT NULL,
    "account_no_last4" TEXT NOT NULL,
    "ifsc" TEXT NOT NULL,
    "holderName" TEXT NOT NULL,
    "format_key" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "daily_limit" DECIMAL(18,4),
    "upload_config" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRecord" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "payment_run_id" TEXT NOT NULL,
    "gross" DECIMAL(18,4) NOT NULL,
    "tds" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "net" DECIMAL(18,4) NOT NULL,
    "utr" TEXT NOT NULL,
    "is_stub" BOOLEAN NOT NULL DEFAULT true,
    "paid_at" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BankAccount_tenant_id_idx" ON "BankAccount"("tenant_id");

-- CreateIndex
CREATE INDEX "PaymentRecord_tenant_id_idx" ON "PaymentRecord"("tenant_id");

-- CreateIndex
CREATE INDEX "PaymentRecord_invoice_id_idx" ON "PaymentRecord"("invoice_id");

-- CreateIndex
CREATE INDEX "PaymentRecord_payment_run_id_idx" ON "PaymentRecord"("payment_run_id");

-- CreateIndex: prevent the same invoice appearing twice in one run.
CREATE UNIQUE INDEX "PaymentRunItem_payment_run_id_invoice_id_key" ON "PaymentRunItem"("payment_run_id", "invoice_id");

-- AddForeignKey
ALTER TABLE "PaymentRun" ADD CONSTRAINT "PaymentRun_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_payment_run_id_fkey" FOREIGN KEY ("payment_run_id") REFERENCES "PaymentRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
