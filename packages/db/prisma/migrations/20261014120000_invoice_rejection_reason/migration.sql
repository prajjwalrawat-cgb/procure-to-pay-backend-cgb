-- Buyer-side rejection before approval.
--
-- A duplicate or wrong invoice used to be rejectable only by routing it for
-- approval and having the approver reject it. Buyers can now reject it from the
-- exception queue directly; the reason is kept so the vendor sees what to fix.

ALTER TABLE "Invoice" ADD COLUMN "rejection_reason" TEXT;
