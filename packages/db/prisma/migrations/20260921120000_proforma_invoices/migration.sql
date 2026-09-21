-- Proforma invoices.
--
-- Some vendors will not supply until an advance is paid, and the advance is
-- paid against their proforma (PI). The real tax invoice only arrives after
-- that, and must land on the same record — a second invoice would bill the PO
-- twice and lose track of what was already paid.
--
-- An invoice now says which it is. The balance of a proforma is blocked once the
-- advance is paid, until the tax invoice replaces it; the PI's reference and the
-- total approved against it are kept for the re-approval decision.

CREATE TYPE "InvoiceDocumentKind" AS ENUM ('TAX_INVOICE', 'PROFORMA');

ALTER TYPE "InvoiceAttachmentType" ADD VALUE IF NOT EXISTS 'PROFORMA_PDF';

ALTER TABLE "Invoice" ADD COLUMN "document_kind" "InvoiceDocumentKind" NOT NULL DEFAULT 'TAX_INVOICE';
ALTER TABLE "Invoice" ADD COLUMN "proforma_ref" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "proforma_gross_amount" DECIMAL(18,4);
ALTER TABLE "Invoice" ADD COLUMN "tax_invoice_received_at" TIMESTAMPTZ(6);

ALTER TABLE "InvoiceException" ADD COLUMN "superseded_at" TIMESTAMPTZ(6);
