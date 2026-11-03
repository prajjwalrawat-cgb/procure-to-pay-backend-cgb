-- Default checker for PO amendments: a single Finance Officer step.
--
-- Separate from the migration that adds the PO_AMENDMENT enum value, since
-- Postgres refuses a new enum value inside the transaction that added it.
-- Only tenants without a PO_AMENDMENT matrix get one, so an admin's own
-- matrix is never overwritten. Editable later under Approvals → Matrices.
INSERT INTO "ApprovalMatrix" (
  "id", "tenant_id", "documentType", "name", "priority", "isActive", "version",
  "conditions", "steps", "createdAt"
)
SELECT
  'amx_' || upper(replace(gen_random_uuid()::text, '-', '')),
  t."id",
  'PO_AMENDMENT',
  'PO amendment — finance officer',
  1,
  true,
  1,
  '{"all": []}'::jsonb,
  '[{"step_no": 1, "name": "Finance officer", "role": "FINANCE_OFFICER", "scope": "tenant", "sla_hours": 24}]'::jsonb,
  CURRENT_TIMESTAMP
FROM "Tenant" t
WHERE NOT EXISTS (
  SELECT 1 FROM "ApprovalMatrix" m
  WHERE m."tenant_id" = t."id" AND m."documentType" = 'PO_AMENDMENT'
);
