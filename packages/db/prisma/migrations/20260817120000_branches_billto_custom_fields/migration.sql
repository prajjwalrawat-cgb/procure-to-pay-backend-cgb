-- =============================================================================
-- Multi-registration branches, PO bill-to, and admin-defined custom fields.
--
-- Plant.is_default — a tenant registered in more than one state has a GSTIN per
-- state, and every document that does not name a branch has to fall back to one
-- deliberately. Before this the fallback was `findFirst()`, i.e. whichever row
-- the planner returned, which with two registrations is a coin flip.
--
-- PurchaseOrder.bill_to_plant_id — the registration the order is billed to, held
-- separately from the ship-to address. Under IGST Act s.10(1)(b), goods
-- delivered to a third party on the buyer's direction take the buyer's own
-- principal place of business as the place of supply, so it is this column —
-- never the delivery address — that decides CGST+SGST vs IGST and which
-- registration claims the input credit.
--
-- CustomFieldDefinition + `custom_fields` — fields an admin adds to a document
-- type from Settings without a code change. Definitions are rows; the captured
-- values live in each document's own JSON column, keyed by definition `key`.
-- Definitions are deactivated rather than deleted so historic values stay
-- readable.
--
-- RLS for CustomFieldDefinition is applied by prisma/security/01-rls.sql via
-- `pnpm security:apply` (run AFTER this migration).
-- =============================================================================

-- CreateEnum
CREATE TYPE "CustomFieldEntity" AS ENUM ('REQUISITION', 'PURCHASE_ORDER', 'GOODS_RECEIPT', 'INVOICE', 'VENDOR', 'ITEM');

-- CreateEnum
CREATE TYPE "CustomFieldType" AS ENUM ('TEXT', 'TEXTAREA', 'NUMBER', 'DATE', 'SELECT', 'MULTI_SELECT', 'CHECKBOX');

-- AlterTable
ALTER TABLE "Plant" ADD COLUMN "is_default" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN "bill_to_plant_id" TEXT;

-- AlterTable
ALTER TABLE "Requisition" ADD COLUMN "custom_fields" JSONB;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN "custom_fields" JSONB;

-- AlterTable
ALTER TABLE "GoodsReceiptNote" ADD COLUMN "custom_fields" JSONB;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "custom_fields" JSONB;

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN "custom_fields" JSONB;

-- AlterTable
ALTER TABLE "Item" ADD COLUMN "custom_fields" JSONB;

-- CreateTable
CREATE TABLE "CustomFieldDefinition" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "entity_type" "CustomFieldEntity" NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "field_type" "CustomFieldType" NOT NULL,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "is_printable" BOOLEAN NOT NULL DEFAULT false,
    "help_text" TEXT,
    "order_no" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CustomFieldDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomFieldDefinition_tenant_id_entity_type_key_key" ON "CustomFieldDefinition"("tenant_id", "entity_type", "key");

-- CreateIndex
CREATE INDEX "CustomFieldDefinition_tenant_id_entity_type_order_no_idx" ON "CustomFieldDefinition"("tenant_id", "entity_type", "order_no");

-- CreateIndex
CREATE INDEX "PurchaseOrder_bill_to_plant_id_idx" ON "PurchaseOrder"("bill_to_plant_id");

-- AddForeignKey
ALTER TABLE "CustomFieldDefinition" ADD CONSTRAINT "CustomFieldDefinition_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_bill_to_plant_id_fkey" FOREIGN KEY ("bill_to_plant_id") REFERENCES "Plant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: the oldest plant in each tenant becomes the default registration,
-- which is what the old findFirst() fallback resolved to in practice. An admin
-- can move it in Settings → Branches.
UPDATE "Plant" p
SET "is_default" = true
WHERE p."id" = (
  SELECT p2."id"
  FROM "Plant" p2
  WHERE p2."tenant_id" = p."tenant_id"
  ORDER BY p2."createdAt" ASC, p2."id" ASC
  LIMIT 1
);

-- Backfill: existing orders keep billing to the plant their requisition names,
-- else the tenant's default registration — so no historic PO changes its tax
-- treatment when the renderer starts reading this column.
UPDATE "PurchaseOrder" po
SET "bill_to_plant_id" = COALESCE(
  (SELECT r."plant_id" FROM "Requisition" r WHERE r."id" = po."requisition_id"),
  (SELECT p."id" FROM "Plant" p WHERE p."tenant_id" = po."tenant_id" AND p."is_default" ORDER BY p."id" LIMIT 1)
);
