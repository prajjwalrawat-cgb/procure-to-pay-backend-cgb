-- A rejected onboarding used to leave the vendor at UNDER_REVIEW, so the
-- dossier header read "Under review" beside a "Rejected" decision. Give the
-- vendor master a terminal state of its own.
--
-- On its own migration: Postgres refuses to use a newly added enum value in
-- the transaction that added it, and the backfill below needs it.
ALTER TYPE "VendorLifecycleStatus" ADD VALUE IF NOT EXISTS 'REJECTED';
