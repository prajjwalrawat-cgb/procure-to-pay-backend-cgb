-- =============================================================================
-- Multi-organisation workspaces.
--
-- A person belongs to several organisations by holding one "User" row per
-- tenant under the same email. "User" is RLS-scoped to one tenant, so finding
-- a person's other rows and creating a new tenant both have to step outside
-- the caller's tenant — these SECURITY DEFINER functions do exactly that and
-- nothing more.
-- =============================================================================

-- Every organisation the given user can switch to, including their own.
-- Another row is included only when it is active, holds an internal (non-
-- vendor) role, and both it and the caller's row have a verified email: an
-- admin can create a user with any address, so an unverified row must never
-- open a door into another tenant.
CREATE OR REPLACE FUNCTION auth_user_workspaces(p_user_id text)
RETURNS TABLE (
  user_id     text,
  tenant_id   uuid,
  tenant_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.id, t.id, t.name
  FROM "User" src
  JOIN "User" u ON lower(u.email) = lower(src.email)
  JOIN "Tenant" t ON t.id = u.tenant_id
  WHERE src.id = p_user_id
    AND src."isActive"
    AND u."isActive"
    AND (
      u.id = src.id
      OR (src.email_verified_at IS NOT NULL AND u.email_verified_at IS NOT NULL)
    )
    AND EXISTS (
      SELECT 1 FROM "UserRole" ur JOIN "Role" r ON r.id = ur.role_id
      WHERE ur.user_id = u.id AND r.name <> 'VENDOR_USER'
    )
  ORDER BY lower(t.name);
$$;

REVOKE EXECUTE ON FUNCTION auth_user_workspaces(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_user_workspaces(text) TO procureflow_app;

-- Create a new organisation and make the source user its TENANT_ADMIN, by
-- copying their identity (email, name, password hash, MFA, verification) into
-- a new "User" row in the new tenant. Returns the new tenant id. The caller
-- (the API) has already checked the source user holds tenant:create.
CREATE OR REPLACE FUNCTION create_workspace(
  p_name             text,
  p_source_user_id   text,
  p_new_user_id      text,
  p_new_user_role_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_src     "User"%ROWTYPE;
  v_role_id uuid;
  v_tenant  uuid;
BEGIN
  SELECT * INTO v_src FROM "User" WHERE id = p_source_user_id AND "isActive";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_workspace: source user % not found', p_source_user_id;
  END IF;

  SELECT id INTO v_role_id FROM "Role" WHERE name = 'TENANT_ADMIN';
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'create_workspace: TENANT_ADMIN role missing';
  END IF;

  INSERT INTO "Tenant" (name) VALUES (btrim(p_name)) RETURNING id INTO v_tenant;

  INSERT INTO "User" (
    id, tenant_id, email, name, "argonHash", "mfaSecret", "mfaEnabled",
    "isActive", email_verified_at, "createdAt", "updatedAt"
  ) VALUES (
    p_new_user_id, v_tenant, lower(v_src.email), v_src.name, v_src."argonHash",
    v_src."mfaSecret", v_src."mfaEnabled", true, v_src.email_verified_at,
    now(), now()
  );

  INSERT INTO "UserRole" (id, tenant_id, user_id, role_id)
  VALUES (p_new_user_role_id, v_tenant, p_new_user_id, v_role_id);

  RETURN v_tenant;
END;
$$;

REVOKE EXECUTE ON FUNCTION create_workspace(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_workspace(text, text, text, text) TO procureflow_app;
