-- =============================================================================
-- The company GSTIN moves to the branch that holds it.
--
-- `Tenant.gstin` predates multi-state registration and cannot be right for a
-- tenant registered in more than one state — there is no single "company
-- GSTIN", only one per registration. It is no longer written or read anywhere:
-- documents take the GSTIN from the branch they are billed under.
--
-- This copies the old value onto the tenant's default branch where that branch
-- has none, so nothing is lost, and leaves the column in place. Dropping it is
-- a separate migration deliberately: a column removed while the previous build
-- is still deployed takes that build down with it, so the drop belongs after
-- this release is out.
-- =============================================================================

UPDATE "Plant" p
SET "gstin" = t."gstin"
FROM "Tenant" t
WHERE p."tenant_id" = t."id"
  AND p."is_default"
  AND p."gstin" IS NULL
  AND t."gstin" IS NOT NULL;

COMMENT ON COLUMN "Tenant"."gstin" IS
  'DEPRECATED — superseded by Plant.gstin (one per state registration). Read by nothing; drop once the release carrying that change is deployed.';
