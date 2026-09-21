-- Home command center + Analytics overview (ADR-028 summary table).
--
-- One row per tenant per day: flow counts (invoice-basis net spend, documents
-- created) recomputed over a trailing window on each refresh, plus a snapshot
-- of stock metrics (open POs, invoices in flight, active vendors, MSME
-- compliance score) written for the refresh day only. RLS is added by
-- security/01-rls.sql like the other Analytics* tables. Additive only.

-- CreateTable
CREATE TABLE "AnalyticsDaily" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "spend_net" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "requisitions_created" INTEGER NOT NULL DEFAULT 0,
    "pos_created" INTEGER NOT NULL DEFAULT 0,
    "invoices_received" INTEGER NOT NULL DEFAULT 0,
    "open_pos" INTEGER,
    "invoices_in_flight" INTEGER,
    "active_vendors" INTEGER,
    "msme_compliance_score" DECIMAL(6,2),
    "refreshed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsDaily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnalyticsDaily_tenant_id_day_idx" ON "AnalyticsDaily"("tenant_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsDaily_tenant_id_day_key" ON "AnalyticsDaily"("tenant_id", "day");
