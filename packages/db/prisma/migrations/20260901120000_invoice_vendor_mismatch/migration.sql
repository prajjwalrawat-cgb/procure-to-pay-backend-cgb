-- Is the invoice even from the company the order was raised with?
--
-- Nothing asked. Quantity, rate, tax, unit, dates and totals can every one of
-- them be correct on a document issued by a different supplier — which is what
-- a misfiled attachment looks like, and what invoice fraud looks like.
--
-- The OCR service has always returned the supplier name printed on the page;
-- the adapter discarded it. This column keeps it so the matcher can compare.

ALTER TYPE "ExceptionType" ADD VALUE IF NOT EXISTS 'VENDOR_MISMATCH';

ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "ocr_vendor_name" TEXT;
