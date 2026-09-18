-- Part-payments against an invoice.
--
-- An invoice was either unpaid or PAID in full: a payment run always paid the
-- whole grossAmount, and a payment record could only exist against a run. So a
-- half paid by direct transfer had nowhere to be recorded, and the next run
-- would have paid the full amount again.
--
-- Now an invoice can carry several payment records, each settling part of it,
-- and sits in PARTIALLY_PAID until they add up. A record may be MANUAL — paid
-- outside the app and entered by finance — in which case it has no run.

ALTER TYPE "InvoiceStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_PAID';

CREATE TYPE "PaymentRecordSource" AS ENUM ('PAYMENT_RUN', 'MANUAL');

ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "paid_amount" DECIMAL(18,4) NOT NULL DEFAULT 0;

ALTER TABLE "PaymentRecord" ALTER COLUMN "payment_run_id" DROP NOT NULL;
ALTER TABLE "PaymentRecord" ADD COLUMN "source" "PaymentRecordSource" NOT NULL DEFAULT 'PAYMENT_RUN';
ALTER TABLE "PaymentRecord" ADD COLUMN "mode" TEXT;
ALTER TABLE "PaymentRecord" ADD COLUMN "note" TEXT;
ALTER TABLE "PaymentRecord" ADD COLUMN "recorded_by_id" TEXT;

-- Every invoice already PAID was paid in full by a run.
UPDATE "Invoice" SET "paid_amount" = "grossAmount" WHERE "status" = 'PAID';
