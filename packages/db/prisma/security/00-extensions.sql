-- Required extensions. pgcrypto provides digest()/sha256 for the audit chain
-- and gen_random_uuid() for Tenant/Role ids (Master Context §7).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
