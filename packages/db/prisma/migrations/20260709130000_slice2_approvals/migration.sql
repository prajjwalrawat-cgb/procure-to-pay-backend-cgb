-- Slice 2 — Approval engine + audit log.
-- Adds matrix versioning, richer Approval routing fields, Delegation and
-- Notification tables, and the CHANGES_REQUESTED decision value.

-- AlterEnum
ALTER TYPE "ApprovalDecision" ADD VALUE 'CHANGES_REQUESTED';

-- AlterTable: ApprovalMatrix versioning
ALTER TABLE "ApprovalMatrix"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "previous_version_id" TEXT;

-- AlterTable: Approval routing metadata
ALTER TABLE "Approval"
  ADD COLUMN "step_name" TEXT,
  ADD COLUMN "scope" TEXT,
  ADD COLUMN "parallel_group" TEXT,
  ADD COLUMN "sla_due_at" TIMESTAMPTZ(6),
  ADD COLUMN "escalated_at" TIMESTAMPTZ(6),
  ADD COLUMN "is_escalation" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "delegated_from_id" TEXT,
  ADD COLUMN "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "Delegation" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "delegate_user_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'ALL',
    "document_types" "DocumentType"[] DEFAULT ARRAY[]::"DocumentType"[],
    "reason" TEXT NOT NULL,
    "from_date" TIMESTAMPTZ(6) NOT NULL,
    "to_date" TIMESTAMPTZ(6) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Delegation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "href" TEXT,
    "read_at" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApprovalMatrix_tenant_id_name_documentType_idx" ON "ApprovalMatrix"("tenant_id", "name", "documentType");

-- CreateIndex
CREATE INDEX "Approval_tenant_id_approver_id_decision_idx" ON "Approval"("tenant_id", "approver_id", "decision");

-- CreateIndex
CREATE INDEX "Delegation_tenant_id_idx" ON "Delegation"("tenant_id");

-- CreateIndex
CREATE INDEX "Delegation_tenant_id_user_id_is_active_idx" ON "Delegation"("tenant_id", "user_id", "is_active");

-- CreateIndex
CREATE INDEX "Delegation_delegate_user_id_idx" ON "Delegation"("delegate_user_id");

-- CreateIndex
CREATE INDEX "Notification_tenant_id_idx" ON "Notification"("tenant_id");

-- CreateIndex
CREATE INDEX "Notification_tenant_id_user_id_read_at_idx" ON "Notification"("tenant_id", "user_id", "read_at");

-- AddForeignKey
ALTER TABLE "Delegation" ADD CONSTRAINT "Delegation_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
