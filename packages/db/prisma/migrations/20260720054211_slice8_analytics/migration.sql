-- CreateEnum
CREATE TYPE "SavingsInitiativeType" AS ENUM ('HARD_RFQ', 'PRICE_IMPROVEMENT', 'SOFT_PAYMENT_TERM', 'AVOIDED_COST');

-- CreateEnum
CREATE TYPE "SavingsSourceType" AS ENUM ('RFQ_AWARD', 'NEGOTIATED_PO', 'PAYMENT_TERM', 'MANUAL');

-- CreateEnum
CREATE TYPE "SavingsEntryStatus" AS ENUM ('CONFIRMED', 'PENDING_REVIEW', 'REJECTED');

-- CreateTable
CREATE TABLE "TenantComplianceConfig" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rbi_reference_rate_pct" DECIMAL(6,4) NOT NULL DEFAULT 6.5000,
    "rbi_rate_effective_from" TIMESTAMPTZ(6),
    "rbi_rate_source" TEXT,
    "cost_of_capital_pct" DECIMAL(6,4) NOT NULL DEFAULT 12.0000,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TenantComplianceConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavingsLedgerEntry" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "period_month" TEXT NOT NULL,
    "initiative_type" "SavingsInitiativeType" NOT NULL,
    "source_type" "SavingsSourceType" NOT NULL,
    "source_id" TEXT,
    "vendor_id" TEXT,
    "category" TEXT,
    "baseline_value" DECIMAL(18,4) NOT NULL,
    "awarded_value" DECIMAL(18,4) NOT NULL,
    "savings_amount" DECIMAL(18,4) NOT NULL,
    "savings_pct" DECIMAL(9,4) NOT NULL,
    "buyer_id" TEXT,
    "status" "SavingsEntryStatus" NOT NULL DEFAULT 'CONFIRMED',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "SavingsLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsRefreshLog" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "view_name" TEXT NOT NULL,
    "refreshed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "duration_ms" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'OK',
    "trigger" TEXT NOT NULL DEFAULT 'SCHEDULED',

    CONSTRAINT "AnalyticsRefreshLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsSpendMonthly" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "gross_spend" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "tax_spend" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "net_spend" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "txn_count" INTEGER NOT NULL DEFAULT 0,
    "refreshed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsSpendMonthly_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsVendorMonthly" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "gross_spend" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "net_spend" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "txn_count" INTEGER NOT NULL DEFAULT 0,
    "refreshed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsVendorMonthly_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsApMonthly" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "invoices_total" INTEGER NOT NULL DEFAULT 0,
    "invoices_first_pass" INTEGER NOT NULL DEFAULT 0,
    "invoices_exception" INTEGER NOT NULL DEFAULT 0,
    "invoices_straight_through" INTEGER NOT NULL DEFAULT 0,
    "cycle_hours_sum" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "cycle_count" INTEGER NOT NULL DEFAULT 0,
    "refreshed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsApMonthly_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsMsmeMonthly" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "breach_count" INTEGER NOT NULL DEFAULT 0,
    "breach_exposure" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "refreshed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsMsmeMonthly_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantComplianceConfig_tenant_id_key" ON "TenantComplianceConfig"("tenant_id");

-- CreateIndex
CREATE INDEX "TenantComplianceConfig_tenant_id_idx" ON "TenantComplianceConfig"("tenant_id");

-- CreateIndex
CREATE INDEX "SavingsLedgerEntry_tenant_id_idx" ON "SavingsLedgerEntry"("tenant_id");

-- CreateIndex
CREATE INDEX "SavingsLedgerEntry_tenant_id_period_month_idx" ON "SavingsLedgerEntry"("tenant_id", "period_month");

-- CreateIndex
CREATE INDEX "SavingsLedgerEntry_tenant_id_buyer_id_idx" ON "SavingsLedgerEntry"("tenant_id", "buyer_id");

-- CreateIndex
CREATE UNIQUE INDEX "SavingsLedgerEntry_tenant_id_source_type_source_id_initiati_key" ON "SavingsLedgerEntry"("tenant_id", "source_type", "source_id", "initiative_type");

-- CreateIndex
CREATE INDEX "AnalyticsRefreshLog_tenant_id_idx" ON "AnalyticsRefreshLog"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsRefreshLog_tenant_id_view_name_key" ON "AnalyticsRefreshLog"("tenant_id", "view_name");

-- CreateIndex
CREATE INDEX "AnalyticsSpendMonthly_tenant_id_idx" ON "AnalyticsSpendMonthly"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsSpendMonthly_tenant_id_month_key" ON "AnalyticsSpendMonthly"("tenant_id", "month");

-- CreateIndex
CREATE INDEX "AnalyticsVendorMonthly_tenant_id_idx" ON "AnalyticsVendorMonthly"("tenant_id");

-- CreateIndex
CREATE INDEX "AnalyticsVendorMonthly_tenant_id_month_idx" ON "AnalyticsVendorMonthly"("tenant_id", "month");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsVendorMonthly_tenant_id_vendor_id_month_key" ON "AnalyticsVendorMonthly"("tenant_id", "vendor_id", "month");

-- CreateIndex
CREATE INDEX "AnalyticsApMonthly_tenant_id_idx" ON "AnalyticsApMonthly"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsApMonthly_tenant_id_month_key" ON "AnalyticsApMonthly"("tenant_id", "month");

-- CreateIndex
CREATE INDEX "AnalyticsMsmeMonthly_tenant_id_idx" ON "AnalyticsMsmeMonthly"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsMsmeMonthly_tenant_id_month_key" ON "AnalyticsMsmeMonthly"("tenant_id", "month");
