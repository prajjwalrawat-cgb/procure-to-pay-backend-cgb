-- Multi-organisation workspaces: a person can hold one User row per tenant
-- (same email), and switch between them. Rows are linked only when the email
-- is verified on both — see "User".email_verified_at in schema.prisma.
ALTER TABLE "User" ADD COLUMN "email_verified_at" TIMESTAMPTZ(6);

-- Backfill: accounts that are already active predate verification tracking.
-- Until now every person belonged to exactly one tenant, so no cross-tenant
-- link could have been spoofed; treat existing active accounts as verified.
-- Pending invites (inactive) stay unverified until they are accepted.
UPDATE "User" SET "email_verified_at" = now() WHERE "isActive" = true;
