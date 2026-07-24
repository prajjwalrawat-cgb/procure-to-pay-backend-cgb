-- CreateEnum
CREATE TYPE "PaymentItemBankStatus" AS ENUM ('PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentSubmissionStatus" AS ENUM ('INTENT', 'SUBMITTED', 'CONFIRMED', 'FAILED');

-- AlterEnum
ALTER TYPE "PaymentRunStatus" ADD VALUE 'SUBMITTED_PENDING_BANK_CONFIRMATION';

-- AlterTable
ALTER TABLE "PaymentRunItem" ADD COLUMN     "bank_error_message" TEXT,
ADD COLUMN     "bank_status" "PaymentItemBankStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "bank_utr" TEXT;

-- CreateTable
CREATE TABLE "PaymentSubmissionIntent" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payment_run_id" TEXT NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" "PaymentSubmissionStatus" NOT NULL DEFAULT 'INTENT',
    "bank_batch_ref" TEXT,
    "file_hash" TEXT,
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "accepted_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "simulated" BOOLEAN NOT NULL DEFAULT true,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMPTZ(6),
    "confirmed_at" TIMESTAMPTZ(6),

    CONSTRAINT "PaymentSubmissionIntent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentSubmissionIntent_idempotency_key_key" ON "PaymentSubmissionIntent"("idempotency_key");

-- CreateIndex
CREATE INDEX "PaymentSubmissionIntent_tenant_id_idx" ON "PaymentSubmissionIntent"("tenant_id");

-- CreateIndex
CREATE INDEX "PaymentSubmissionIntent_payment_run_id_idx" ON "PaymentSubmissionIntent"("payment_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentSubmissionIntent_payment_run_id_attempt_no_key" ON "PaymentSubmissionIntent"("payment_run_id", "attempt_no");
