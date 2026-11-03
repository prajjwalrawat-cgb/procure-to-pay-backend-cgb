-- =============================================================================
-- The AskMira link — the two lookups that run BEFORE a tenant is known.
--
-- AskMira's server signs each call with the secret of ONE connection, and names
-- its own workspace in the token. To check the token we must first find which
-- tenant here that AskMira workspace is connected to — before app.tenant_id can
-- be set. Like auth_find_user (03-auth-functions.sql) these SECURITY DEFINER
-- functions do exactly that narrow lookup and nothing else; everything after
-- runs inside the tenant's context under normal RLS.
-- =============================================================================

-- Which tenant an AskMira workspace is connected to, and the nonce its secret is
-- derived from. One row or none.
CREATE OR REPLACE FUNCTION askmira_find_link(p_askmira_tenant_id uuid)
RETURNS TABLE (
  tenant_id         uuid,
  askmira_tenant_id uuid,
  askmira_name      text,
  askmira_origin    text,
  secret_nonce      text,
  tenant_name       text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT l.tenant_id, l.askmira_tenant_id, l.askmira_name, l.askmira_origin,
         l.secret_nonce, t.name
  FROM "AskmiraLink" l
  JOIN "Tenant" t ON t.id = l.tenant_id
  WHERE l.askmira_tenant_id = p_askmira_tenant_id
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION askmira_find_link(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION askmira_find_link(uuid) TO procureflow_app;

-- Spend a one-time connect code: marks it used (whatever happens next) and
-- returns it, if it was unused and unexpired. AskMira's server then proves the
-- PKCE verifier against the challenge returned here.
CREATE OR REPLACE FUNCTION askmira_take_code(p_code_hash text)
RETURNS TABLE (
  tenant_id         uuid,
  askmira_tenant_id uuid,
  askmira_name      text,
  askmira_origin    text,
  challenge         text,
  approved_by       text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE "AskmiraConnectCode" c
  SET used_at = now()
  WHERE c.code_hash = p_code_hash AND c.used_at IS NULL AND c.expires_at > now()
  RETURNING c.tenant_id, c.askmira_tenant_id, c.askmira_name, c.askmira_origin,
            c.challenge, c.approved_by;
$$;

REVOKE EXECUTE ON FUNCTION askmira_take_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION askmira_take_code(text) TO procureflow_app;
