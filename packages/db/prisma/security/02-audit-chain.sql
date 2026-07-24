-- =============================================================================
-- Tamper-evident, append-only audit log — Master Context §3 rule #3.
--
--   • UPDATE and DELETE are REVOKED (append-only).
--   • A BEFORE INSERT trigger chains each row's hash to the previous row's hash
--     within the same tenant:
--         hash_current = sha256( coalesce(hash_previous,'') || row_json_no_hash )
--   • A per-tenant advisory lock serialises inserts so the chain has no forks.
--
-- The application never sets hash_current/hash_previous itself; the DB is the
-- single source of truth so a compromised app cannot forge the chain.
-- =============================================================================

CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS trigger AS $$
DECLARE
  prev_hash text;
  row_json  text;
BEGIN
  -- Serialise per-tenant so concurrent inserts cannot both read the same tip.
  PERFORM pg_advisory_xact_lock(hashtext('audit:' || NEW.tenant_id::text));

  SELECT a.hash_current INTO prev_hash
  FROM "AuditLog" a
  WHERE a.tenant_id = NEW.tenant_id
  ORDER BY a.timestamp DESC, a.id DESC
  LIMIT 1;

  NEW.hash_previous := prev_hash; -- NULL for the tenant's first row.

  -- Canonical row image excluding the hash columns themselves.
  row_json := (to_jsonb(NEW) - 'hash_current' - 'hash_previous')::text;

  -- Use the built-in pg_catalog sha256(bytea) rather than pgcrypto's
  -- digest(text,'sha256'): pg_catalog is always on the search_path, whereas
  -- pgcrypto may live in a non-default schema (e.g. Supabase installs it in
  -- "extensions"), which made unqualified digest() fail to resolve inside this
  -- trigger. sha256((t)::bytea) is byte-identical to digest(t,'sha256'), so the
  -- existing hash chain stays valid.
  NEW.hash_current := encode(
    sha256((coalesce(NEW.hash_previous, '') || row_json)::bytea),
    'hex'
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_chain ON "AuditLog";
CREATE TRIGGER trg_audit_log_chain
  BEFORE INSERT ON "AuditLog"
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_chain();

-- Append-only: no one (not even the app role) may mutate or remove audit rows.
REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog" FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog" FROM procureflow_app;
GRANT SELECT, INSERT ON "AuditLog" TO procureflow_app;
