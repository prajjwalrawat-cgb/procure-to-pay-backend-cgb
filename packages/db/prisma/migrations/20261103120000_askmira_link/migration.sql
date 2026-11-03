-- The link with AskMira (apps/api/src/integrations/askmira). Additive.
-- RLS for the tenanted tables and the pre-tenant lookup functions are in
-- security/01-rls.sql and security/04-askmira.sql, applied by security:apply.

CREATE TABLE "AskmiraLink" (
    "tenant_id" UUID NOT NULL,
    "askmira_tenant_id" UUID NOT NULL,
    "askmira_name" TEXT,
    "askmira_origin" TEXT,
    "secret_nonce" TEXT NOT NULL,
    "connected_by" TEXT,
    "connected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AskmiraLink_pkey" PRIMARY KEY ("tenant_id")
);

CREATE UNIQUE INDEX "AskmiraLink_askmira_tenant_id_key" ON "AskmiraLink"("askmira_tenant_id");

CREATE TABLE "AskmiraConnectCode" (
    "code_hash" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "askmira_tenant_id" UUID NOT NULL,
    "askmira_name" TEXT,
    "askmira_origin" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "approved_by" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),

    CONSTRAINT "AskmiraConnectCode_pkey" PRIMARY KEY ("code_hash")
);

CREATE INDEX "AskmiraConnectCode_tenant_id_idx" ON "AskmiraConnectCode"("tenant_id");

CREATE TABLE "AskmiraUsedToken" (
    "jti" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AskmiraUsedToken_pkey" PRIMARY KEY ("jti")
);

CREATE TABLE "AskmiraPerson" (
    "tenant_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "askmira_user_id" TEXT,
    "linked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivated_at" TIMESTAMPTZ(6),

    CONSTRAINT "AskmiraPerson_pkey" PRIMARY KEY ("tenant_id","user_id")
);
