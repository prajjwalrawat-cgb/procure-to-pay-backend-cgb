-- =============================================================================
-- Tenant.pan — the company's Permanent Account Number.
--
-- One per legal entity, unlike GSTIN which is one per state registration, so it
-- belongs on the tenant rather than on Plant. Printed on the purchase order:
-- vendors need it for TDS credit and it is what a tax office reconciles the
-- deducted tax against.
-- =============================================================================

ALTER TABLE "Tenant" ADD COLUMN "pan" TEXT;
