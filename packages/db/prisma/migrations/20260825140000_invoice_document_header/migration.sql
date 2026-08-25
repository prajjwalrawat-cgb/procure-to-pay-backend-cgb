-- Keep what the document says about its own date and number.
--
-- `createFromUpload` — every PDF upload and every emailed invoice — stamped
-- `invoice_date` as the day of receipt and, from email intake,
-- `vendor_invoice_ref` as the message subject line. OCR then read the real
-- printed date and invoice number off the page and discarded both.
--
-- Consequences: the MSME clock ran from receipt rather than the invoice date,
-- and duplicate detection compared email subjects.

ALTER TYPE "ExceptionType" ADD VALUE IF NOT EXISTS 'DOCUMENT_MISMATCH';

ALTER TABLE "Invoice"
  ADD COLUMN IF NOT EXISTS "ocr_invoice_date" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "ocr_vendor_invoice_ref" TEXT,
  ADD COLUMN IF NOT EXISTS "header_awaiting_ocr" BOOLEAN NOT NULL DEFAULT false;

-- Existing rows keep header_awaiting_ocr = false. They are treated as asserted
-- rather than placeholder, which is wrong for the ones that came from upload or
-- email but is the safe direction: a re-run reports the disagreement for a human
-- instead of silently rewriting the date an MSME due date was computed from.
