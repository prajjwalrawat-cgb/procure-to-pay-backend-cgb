-- audit-only: minimal second tenant "Raychem Industries" for RLS isolation proof.
-- Run as the DB OWNER (procureflow), which bypasses RLS. Idempotent.
-- NOT part of the product seed set; created solely to prove tenant-general isolation
-- (Slices 0-7 audit, Part A / A10-A11). Removing this row + its vendor fully reverts.
DO $$
DECLARE tid uuid;
BEGIN
  SELECT id INTO tid FROM "Tenant" WHERE name = 'Raychem Industries';
  IF tid IS NULL THEN
    INSERT INTO "Tenant"(name) VALUES ('Raychem Industries') RETURNING id INTO tid;
    RAISE NOTICE 'created Raychem tenant %', tid;
  ELSE
    RAISE NOTICE 'Raychem tenant already exists %', tid;
  END IF;

  INSERT INTO "Vendor"(id, tenant_id, code, name, "updatedAt")
  VALUES ('vendor_raychem_audit_0001', tid, 'RAY-V001', 'Raychem Audit Supplier', now())
  ON CONFLICT (id) DO NOTHING;
END $$;

SELECT id, name FROM "Tenant" ORDER BY name;
