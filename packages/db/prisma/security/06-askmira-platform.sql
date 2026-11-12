-- =============================================================================
-- AskMira's platform sets a company up here (askmira.platform.ts).
--
-- AskMira's super admin holds ProcureFlow's platform key (ASKMIRA_PLATFORM_SECRET
-- on this server). With it AskMira may find an organisation, or create one with
-- its first TENANT_ADMIN. Both step outside any one tenant, so like
-- create_workspace (05-workspaces.sql) they are SECURITY DEFINER functions that
-- do exactly that and nothing more; connecting the tenant afterwards runs in
-- its own context under normal RLS.
-- =============================================================================

-- Organisations whose name matches p_q, or whose active TENANT_ADMIN's email
-- matches p_q; or, with p_admin_email, exactly those that address administers.
-- Each with its admins' emails and the AskMira workspace it is connected to.
CREATE OR REPLACE FUNCTION askmira_platform_orgs(p_q text, p_admin_email text)
RETURNS TABLE (
  tenant_id    uuid,
  tenant_name  text,
  admins       text[],
  connected_to uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH admins AS (
    SELECT u.tenant_id, lower(u.email) AS email
    FROM "User" u
    JOIN "UserRole" ur ON ur.user_id = u.id
    JOIN "Role" r ON r.id = ur.role_id AND r.name = 'TENANT_ADMIN'
    WHERE u."isActive"
  ),
  hits AS (
    SELECT t.id
    FROM "Tenant" t
    WHERE (
      p_admin_email IS NOT NULL
      AND EXISTS (SELECT 1 FROM admins a WHERE a.tenant_id = t.id AND a.email = lower(p_admin_email))
    ) OR (
      p_admin_email IS NULL AND p_q IS NOT NULL AND (
        t.name ILIKE '%' || p_q || '%'
        OR EXISTS (SELECT 1 FROM admins a WHERE a.tenant_id = t.id AND a.email ILIKE '%' || p_q || '%')
      )
    )
    LIMIT 20
  )
  SELECT t.id, t.name,
         COALESCE((SELECT array_agg(DISTINCT a.email) FROM admins a WHERE a.tenant_id = t.id), '{}'),
         l.askmira_tenant_id
  FROM hits h
  JOIN "Tenant" t ON t.id = h.id
  LEFT JOIN "AskmiraLink" l ON l.tenant_id = t.id
  ORDER BY lower(t.name);
$$;

REVOKE EXECUTE ON FUNCTION askmira_platform_orgs(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION askmira_platform_orgs(text, text) TO procureflow_app;

-- A new organisation with p_email as its TENANT_ADMIN. The person comes in from
-- AskMira (signInFromAskMira) or sets a password with "Forgot password", which
-- also verifies the email; p_argon is a hash of a password nobody knows.
CREATE OR REPLACE FUNCTION askmira_platform_create(
  p_name         text,
  p_email        text,
  p_person       text,
  p_argon        text,
  p_user_id      text,
  p_user_role_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role_id uuid;
  v_tenant  uuid;
BEGIN
  SELECT id INTO v_role_id FROM "Role" WHERE name = 'TENANT_ADMIN';
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'askmira_platform_create: TENANT_ADMIN role missing';
  END IF;

  INSERT INTO "Tenant" (name) VALUES (btrim(p_name)) RETURNING id INTO v_tenant;

  INSERT INTO "User" (
    id, tenant_id, email, name, "argonHash", "isActive", "createdAt", "updatedAt"
  ) VALUES (
    p_user_id, v_tenant, lower(btrim(p_email)), btrim(p_person), p_argon, true, now(), now()
  );

  INSERT INTO "UserRole" (id, tenant_id, user_id, role_id)
  VALUES (p_user_role_id, v_tenant, p_user_id, v_role_id);

  RETURN v_tenant;
END;
$$;

REVOKE EXECUTE ON FUNCTION askmira_platform_create(text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION askmira_platform_create(text, text, text, text, text, text) TO procureflow_app;
