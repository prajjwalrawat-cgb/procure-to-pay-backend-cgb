-- =============================================================================
-- Row-Level Security — Master Context §3 rule #1, §4.
-- Applied AFTER `prisma migrate` by scripts/apply-security.ts.
--
-- RLS is enforced for the runtime app role (procureflow_app), which is NOT the
-- table owner. The migrate/seed owner (procureflow) bypasses RLS as owner, which
-- is what lets the seed insert across the tenant boundary.
--
-- Every tenanted table gets the identical isolation policy:
--   tenant_id = current_setting('app.tenant_id', true)::uuid
-- The `true` second arg makes the setting missing-safe (returns NULL → no rows)
-- rather than erroring when the GUC is unset (e.g. during /auth/* before context).
-- =============================================================================

DO $$
DECLARE
  t text;
  tenanted_tables text[] := ARRAY[
    'User', 'UserRole', 'Plant', 'Department', 'CostCenter',
    'Vendor', 'VendorBank', 'VendorContact', 'VendorDocument',
    'Requisition', 'RequisitionLine', 'RequisitionComment', 'RequisitionAttachment',
    'PurchaseOrder', 'PurchaseOrderLine', 'PurchaseOrderComment',
    'PurchaseOrderAttachment', 'PurchaseOrderTerm',
    'Item', 'ItemUomConversion', 'ItemVendorPricing',
    'Budget', 'BudgetCommitment', 'BudgetAdjustment',
    'GoodsReceiptNote', 'GrnLine', 'GrnQcSample', 'GrnAttachment',
    'ReturnMaterialAuth', 'ReturnMaterialAuthLine', 'StockLedger',
    'Invoice', 'InvoiceLine',
    'InvoiceException', 'InvoiceAttachment', 'InvoiceComment', 'PaymentRun',
    'PaymentRunItem', 'ApprovalMatrix', 'Approval', 'AuditLog', 'DomainEvent',
    'TenantMatchConfig', 'Delegation', 'Notification', 'BankAccount',
    'PaymentRecord',
    -- Slice 6 sourcing
    'Rfq', 'RfqLine', 'RfqDocument', 'RfqInvitation', 'RfqQuestion',
    'RfqCorrigendum', 'Quote', 'QuoteLine', 'QuoteAttachment', 'QuoteEvaluation',
    'ReverseAuctionRound', 'ReverseAuctionBid', 'Award', 'AwardAllocation',
    'QuoteOpenLog',
    -- Slice 7 vendor lifecycle
    'VendorOnboarding', 'VendorBeneficialOwner', 'VendorScreening',
    'VendorCategoryConfig', 'VendorScorecard', 'VendorSuspension',
    'VendorChangeRequest',
    -- Slice 8 analytics (RLS-protected summary tables — see ADR-028)
    'TenantComplianceConfig', 'SavingsLedgerEntry', 'AnalyticsRefreshLog',
    'AnalyticsSpendMonthly', 'AnalyticsVendorMonthly', 'AnalyticsApMonthly',
    'AnalyticsMsmeMonthly', 'AnalyticsDaily',
    -- Slice 9 contracts
    'Contract', 'ContractRateCard', 'ContractClause', 'ClauseLibrary',
    'ContractDocument', 'ContractCallOff', 'ContractVolumeTracking',
    'ContractAmendment', 'ContractRenewalAlert',
    -- Slice 10a integrations
    'TenantIntegrationCredential', 'IntegrationUsageLog', 'InboundEmail',
    -- Slice 10b banking
    'PaymentSubmissionIntent',
    -- Slice 12 inventory (native warehouse module)
    'Product', 'Location', 'StockLedgerEntry', 'ImportBatch', 'ImportRow',
    -- Slice 11 organisation settings
    'CustomFieldDefinition',
    -- Slice 13 mobile scanner
    'ScanEvent', 'CycleCountSession', 'CycleCountVariance', 'PickList', 'PickListLine',
    -- Slice 14 physical box tracking
    'Box', 'BoxMove'
  ];
BEGIN
  FOREACH t IN ARRAY tenanted_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    -- Belt-and-suspenders: ensure the policy is applied even to the owner in
    -- runtime paths is NOT wanted (seed needs owner bypass), so we do NOT FORCE.
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      || 'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
      || 'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid);',
      t
    );
    -- Grant runtime DML to the app role (default privileges cover future tables,
    -- this covers tables that already exist when the script runs).
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO procureflow_app;', t);
  END LOOP;
END
$$;

-- Schema-level USAGE. Normally granted once at container bootstrap
-- (docker/init-app-role.sql), but `prisma migrate reset` drops & recreates the
-- public schema and wipes it — so re-grant here to keep `security:apply`
-- self-sufficient after a reset.
GRANT USAGE ON SCHEMA public TO procureflow_app;

-- pgcrypto lives in the `extensions` schema on managed Postgres (Supabase). The
-- audit-chain verification query calls extensions.digest(...) at runtime as the
-- app role, so it needs USAGE on that schema + EXECUTE on its functions. (The
-- insert-time trigger runs as owner and doesn't rely on this grant.)
GRANT USAGE ON SCHEMA extensions TO procureflow_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA extensions TO procureflow_app;

-- Non-tenanted tables the app must still read/write (no RLS by tenant_id).
GRANT SELECT, INSERT, UPDATE, DELETE ON "Session" TO procureflow_app;
GRANT SELECT ON "Role" TO procureflow_app;
GRANT SELECT ON "Tenant" TO procureflow_app;

-- Slice 12 — derived stock summary. Read-only; tenant isolation comes from the
-- view's `security_invoker` setting plus the RLS policy on StockLedgerEntry,
-- and the service layer filters on tenant_id as well.
DO $$
BEGIN
  EXECUTE 'GRANT SELECT ON product_stock_summary TO procureflow_app';
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'product_stock_summary not present yet — run `prisma migrate deploy` first.';
END
$$;
