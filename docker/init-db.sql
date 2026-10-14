-- Local Postgres bootstrap: mirrors what Supabase provides out of the box so
-- `pnpm db:migrate` + security:apply run unchanged against a plain postgres:16.

-- pgcrypto lives in the `extensions` schema on Supabase; 01-rls.sql grants on it.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
ALTER DATABASE procureflow SET search_path = public, extensions;

-- Runtime app role: NOT the owner and NOT a superuser, so RLS is enforced.
CREATE ROLE procureflow_app LOGIN PASSWORD 'procureflow_app';
GRANT CONNECT ON DATABASE procureflow TO procureflow_app;
