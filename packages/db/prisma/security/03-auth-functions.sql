-- =============================================================================
-- Authentication lookup — runs BEFORE tenant context exists (Master Context §4).
--
-- RLS on "User" is keyed by tenant_id, so a tenant-less read returns zero rows.
-- Login therefore cannot query "User" directly. This SECURITY DEFINER function,
-- owned by the table owner, performs the narrow by-email lookup needed to
-- authenticate, then the app sets app.tenant_id from the resolved tenant and all
-- further reads go through normal RLS. It exposes only auth-relevant columns.
-- =============================================================================

CREATE OR REPLACE FUNCTION auth_find_user(p_email text)
RETURNS TABLE (
  id          text,
  tenant_id   uuid,
  email       text,
  name        text,
  argon_hash  text,
  mfa_secret  text,
  mfa_enabled boolean,
  is_active   boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.id, u.tenant_id, u.email, u.name,
         u."argonHash", u."mfaSecret", u."mfaEnabled", u."isActive"
  FROM "User" u
  -- Both sides are lowered. Comparing a lowered input against the raw column
  -- locked out any user whose stored address carried a capital (a vendor invite
  -- used to store the email exactly as the buyer typed it): login found no row
  -- and reported "Invalid credentials", and forgot-password silently sent
  -- nothing. Writes normalise now, but the lookup must not depend on that.
  WHERE lower(u.email) = lower(p_email)
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION auth_find_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_user(text) TO procureflow_app;
