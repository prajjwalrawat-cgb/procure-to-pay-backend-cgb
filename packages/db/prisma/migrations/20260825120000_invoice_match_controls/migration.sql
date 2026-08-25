-- Slice 15 — controls the three-way matcher never actually performed.
--
-- Until now an invoice could disagree with its purchase order on unit of
-- measure, predate the order it billed against, bill a cancelled order, or
-- carry a printed total that disagreed with its own line items, and the
-- matcher returned MATCHED. These are the enum values and the one column
-- those checks need.

ALTER TYPE "ExceptionType" ADD VALUE IF NOT EXISTS 'UOM_MISMATCH';
ALTER TYPE "ExceptionType" ADD VALUE IF NOT EXISTS 'DATE_SEQUENCE';
ALTER TYPE "ExceptionType" ADD VALUE IF NOT EXISTS 'PO_NOT_OPEN';
ALTER TYPE "ExceptionType" ADD VALUE IF NOT EXISTS 'AMOUNT_MISMATCH';
ALTER TYPE "ExceptionType" ADD VALUE IF NOT EXISTS 'VENDOR_BLOCKED';

-- The grand total as PRINTED on the document, straight from OCR. Deliberately
-- not derived from the line items: "gross_amount" is computed by summing them,
-- so it agrees with them by construction and can never contradict them. This
-- column is the only value that can. Null for every existing row and for any
-- document whose provider returns no total — the check then skips rather than
-- inventing agreement.
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "ocr_declared_total" DECIMAL(18,4);
