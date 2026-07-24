-- Bootstrap the non-superuser application role.
-- RLS is only enforced for roles WITHOUT the BYPASSRLS attribute and that are
-- not the table owner. The migrate/seed owner (`procureflow`) owns the tables;
-- the runtime app connects as `procureflow_app`, which RLS policies gate.
-- Master Context §3 rule #1, §4.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'procureflow_app') THEN
    CREATE ROLE procureflow_app LOGIN PASSWORD 'procureflow_app_pw';
  END IF;
END
$$;

-- Allow the app role to use the schema and operate on current + future tables.
GRANT CONNECT ON DATABASE procureflow TO procureflow_app;
GRANT USAGE ON SCHEMA public TO procureflow_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO procureflow_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO procureflow_app;
