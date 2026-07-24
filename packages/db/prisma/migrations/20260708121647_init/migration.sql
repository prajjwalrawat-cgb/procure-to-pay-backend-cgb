-- CreateEnum
CREATE TYPE "RequisitionStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CONVERTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PoStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ISSUED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GrnQcStatus" AS ENUM ('PENDING', 'PASSED', 'FAILED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('RECEIVED', 'OCR_PENDING', 'MATCHING', 'EXCEPTION', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'PAID', 'REJECTED', 'VOIDED');

-- CreateEnum
CREATE TYPE "InvoiceSource" AS ENUM ('EMAIL', 'PORTAL', 'MANUAL', 'EDI');

-- CreateEnum
CREATE TYPE "Gstr2bStatus" AS ENUM ('PENDING', 'MATCHED', 'MISMATCH_AMOUNT', 'MISMATCH_DATE', 'NOT_FOUND');

-- CreateEnum
CREATE TYPE "ExceptionSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "PaymentRunStatus" AS ENUM ('DRAFT', 'COMPOSED', 'PENDING_APPROVAL', 'APPROVED', 'SUBMITTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'DELEGATED');

-- CreateEnum
CREATE TYPE "VendorStatus" AS ENUM ('DRAFT', 'PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('REQUISITION', 'PURCHASE_ORDER', 'GRN', 'INVOICE', 'PAYMENT_RUN', 'CONTRACT');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "gstin" TEXT,
    "msmePaymentCapDays" INTEGER NOT NULL DEFAULT 45,
    "tdsRate" DECIMAL(6,4) NOT NULL DEFAULT 0.001,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "argonHash" TEXT NOT NULL,
    "mfaSecret" TEXT,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_id" UUID NOT NULL,
    "dept_id" TEXT,
    "plant_id" TEXT,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plant" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "gstin" TEXT,
    "address" TEXT,
    "stateCode" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Plant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "plant_id" TEXT,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostCenter" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dept_id" TEXT,
    "plant_id" TEXT,
    "budgetAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "budgetPeriod" TEXT NOT NULL DEFAULT 'ANNUAL',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostCenter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gstin" TEXT,
    "pan" TEXT,
    "isMsme" BOOLEAN NOT NULL DEFAULT false,
    "udyamNumber" TEXT,
    "msmeCategory" TEXT,
    "categoryTags" TEXT[],
    "status" "VendorStatus" NOT NULL DEFAULT 'DRAFT',
    "riskScore" DECIMAL(6,2),
    "onTimePct" DECIMAL(6,2),
    "qualityPct" DECIMAL(6,2),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorBank" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountNoEncrypted" TEXT NOT NULL,
    "ifsc" TEXT NOT NULL,
    "holderName" TEXT NOT NULL,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMPTZ(6),
    "pennyDropRef" TEXT,

    CONSTRAINT "VendorBank_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorContact" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "VendorContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorDocument" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "validFrom" TIMESTAMPTZ(6),
    "validTo" TIMESTAMPTZ(6),
    "verifiedAt" TIMESTAMPTZ(6),

    CONSTRAINT "VendorDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Requisition" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "requester_id" TEXT NOT NULL,
    "dept_id" TEXT NOT NULL,
    "cost_center_id" TEXT NOT NULL,
    "plant_id" TEXT NOT NULL,
    "status" "RequisitionStatus" NOT NULL DEFAULT 'DRAFT',
    "totalAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "neededBy" TIMESTAMPTZ(6),
    "approval_matrix_snapshot" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Requisition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequisitionLine" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requisition_id" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "itemDesc" TEXT NOT NULL,
    "uom" TEXT NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "taxRate" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "category" TEXT,
    "budgetLineRef" TEXT,

    CONSTRAINT "RequisitionLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "requisition_id" TEXT,
    "status" "PoStatus" NOT NULL DEFAULT 'DRAFT',
    "totalAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "deliveryAddr" TEXT,
    "terms_snapshot" JSONB,
    "issuedAt" TIMESTAMPTZ(6),
    "expectedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderLine" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "po_id" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "itemDesc" TEXT NOT NULL,
    "uom" TEXT NOT NULL,
    "qtyOrdered" DECIMAL(18,4) NOT NULL,
    "qtyReceived" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "taxRate" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "glAccount" TEXT,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceiptNote" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "po_id" TEXT NOT NULL,
    "received_by" TEXT NOT NULL,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL,
    "qcStatus" "GrnQcStatus" NOT NULL DEFAULT 'PENDING',
    "qc_by" TEXT,
    "qcAt" TIMESTAMPTZ(6),
    "deliveryNoteRef" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoodsReceiptNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrnLine" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "grn_id" TEXT NOT NULL,
    "po_line_id" TEXT NOT NULL,
    "qtyAccepted" DECIMAL(18,4) NOT NULL,
    "qtyRejected" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "rejectionReason" TEXT,

    CONSTRAINT "GrnLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "po_id" TEXT,
    "vendor_invoice_ref" TEXT NOT NULL,
    "invoiceDate" TIMESTAMPTZ(6) NOT NULL,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'RECEIVED',
    "source" "InvoiceSource" NOT NULL DEFAULT 'MANUAL',
    "grossAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "tdsAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "irn" TEXT,
    "ewaybillNo" TEXT,
    "gstr2bStatus" "Gstr2bStatus" NOT NULL DEFAULT 'PENDING',
    "gstr2bMatchedAt" TIMESTAMPTZ(6),
    "ocrConfidence" DECIMAL(5,4),
    "msmeDueDate" TIMESTAMPTZ(6),
    "approval_matrix_snapshot" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "po_line_id" TEXT,
    "itemDesc" TEXT NOT NULL,
    "uom" TEXT NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "taxRate" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceException" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "exceptionType" TEXT NOT NULL,
    "severity" "ExceptionSeverity" NOT NULL DEFAULT 'MEDIUM',
    "details" JSONB NOT NULL,
    "raisedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raised_by" TEXT NOT NULL,
    "resolvedAt" TIMESTAMPTZ(6),
    "resolved_by" TEXT,
    "resolutionAction" TEXT,
    "resolutionNotes" TEXT,

    CONSTRAINT "InvoiceException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceAttachment" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRun" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "cycleDate" TIMESTAMPTZ(6) NOT NULL,
    "status" "PaymentRunStatus" NOT NULL DEFAULT 'DRAFT',
    "grossAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "tdsTotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "bankAccountRef" TEXT,
    "composed_by" TEXT NOT NULL,
    "composedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvals" JSONB,
    "submittedAt" TIMESTAMPTZ(6),

    CONSTRAINT "PaymentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRunItem" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payment_run_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "gross" DECIMAL(18,4) NOT NULL,
    "tds" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "net" DECIMAL(18,4) NOT NULL,
    "orderInBatch" INTEGER NOT NULL,

    CONSTRAINT "PaymentRunItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalMatrix" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "documentType" "DocumentType" NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "conditions" JSONB NOT NULL,
    "steps" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,

    CONSTRAINT "ApprovalMatrix_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "documentType" "DocumentType" NOT NULL,
    "document_id" TEXT NOT NULL,
    "stepNo" INTEGER NOT NULL,
    "approver_id" TEXT NOT NULL,
    "decision" "ApprovalDecision" NOT NULL DEFAULT 'PENDING',
    "decidedAt" TIMESTAMPTZ(6),
    "comment" TEXT,
    "slaHours" INTEGER NOT NULL DEFAULT 24,
    "matrix_snapshot_id" TEXT NOT NULL,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" TEXT,
    "actorType" "ActorType" NOT NULL DEFAULT 'USER',
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "hash_current" TEXT NOT NULL,
    "hash_previous" TEXT,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainEvent" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(6),

    CONSTRAINT "DomainEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

-- CreateIndex
CREATE INDEX "User_tenant_id_idx" ON "User"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "User_tenant_id_email_key" ON "User"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "Session_user_id_idx" ON "Session"("user_id");

-- CreateIndex
CREATE INDEX "Session_refreshTokenHash_idx" ON "Session"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "UserRole_tenant_id_idx" ON "UserRole"("tenant_id");

-- CreateIndex
CREATE INDEX "UserRole_user_id_idx" ON "UserRole"("user_id");

-- CreateIndex
CREATE INDEX "UserRole_role_id_idx" ON "UserRole"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "UserRole_user_id_role_id_dept_id_plant_id_key" ON "UserRole"("user_id", "role_id", "dept_id", "plant_id");

-- CreateIndex
CREATE INDEX "Plant_tenant_id_idx" ON "Plant"("tenant_id");

-- CreateIndex
CREATE INDEX "Department_tenant_id_idx" ON "Department"("tenant_id");

-- CreateIndex
CREATE INDEX "Department_plant_id_idx" ON "Department"("plant_id");

-- CreateIndex
CREATE INDEX "CostCenter_tenant_id_idx" ON "CostCenter"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "CostCenter_tenant_id_code_key" ON "CostCenter"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "Vendor_tenant_id_idx" ON "Vendor"("tenant_id");

-- CreateIndex
CREATE INDEX "Vendor_tenant_id_status_idx" ON "Vendor"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_tenant_id_code_key" ON "Vendor"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "VendorBank_tenant_id_idx" ON "VendorBank"("tenant_id");

-- CreateIndex
CREATE INDEX "VendorBank_vendor_id_idx" ON "VendorBank"("vendor_id");

-- CreateIndex
CREATE INDEX "VendorContact_tenant_id_idx" ON "VendorContact"("tenant_id");

-- CreateIndex
CREATE INDEX "VendorContact_vendor_id_idx" ON "VendorContact"("vendor_id");

-- CreateIndex
CREATE INDEX "VendorDocument_tenant_id_idx" ON "VendorDocument"("tenant_id");

-- CreateIndex
CREATE INDEX "VendorDocument_vendor_id_idx" ON "VendorDocument"("vendor_id");

-- CreateIndex
CREATE INDEX "Requisition_tenant_id_idx" ON "Requisition"("tenant_id");

-- CreateIndex
CREATE INDEX "Requisition_tenant_id_status_idx" ON "Requisition"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "Requisition_tenant_id_createdAt_idx" ON "Requisition"("tenant_id", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Requisition_tenant_id_number_key" ON "Requisition"("tenant_id", "number");

-- CreateIndex
CREATE INDEX "RequisitionLine_tenant_id_idx" ON "RequisitionLine"("tenant_id");

-- CreateIndex
CREATE INDEX "RequisitionLine_requisition_id_idx" ON "RequisitionLine"("requisition_id");

-- CreateIndex
CREATE INDEX "PurchaseOrder_tenant_id_idx" ON "PurchaseOrder"("tenant_id");

-- CreateIndex
CREATE INDEX "PurchaseOrder_tenant_id_status_idx" ON "PurchaseOrder"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "PurchaseOrder_tenant_id_createdAt_idx" ON "PurchaseOrder"("tenant_id", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "PurchaseOrder_vendor_id_idx" ON "PurchaseOrder"("vendor_id");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_tenant_id_number_key" ON "PurchaseOrder"("tenant_id", "number");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_tenant_id_idx" ON "PurchaseOrderLine"("tenant_id");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_po_id_idx" ON "PurchaseOrderLine"("po_id");

-- CreateIndex
CREATE INDEX "GoodsReceiptNote_tenant_id_idx" ON "GoodsReceiptNote"("tenant_id");

-- CreateIndex
CREATE INDEX "GoodsReceiptNote_tenant_id_qcStatus_idx" ON "GoodsReceiptNote"("tenant_id", "qcStatus");

-- CreateIndex
CREATE INDEX "GoodsReceiptNote_po_id_idx" ON "GoodsReceiptNote"("po_id");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceiptNote_tenant_id_number_key" ON "GoodsReceiptNote"("tenant_id", "number");

-- CreateIndex
CREATE INDEX "GrnLine_tenant_id_idx" ON "GrnLine"("tenant_id");

-- CreateIndex
CREATE INDEX "GrnLine_grn_id_idx" ON "GrnLine"("grn_id");

-- CreateIndex
CREATE INDEX "GrnLine_po_line_id_idx" ON "GrnLine"("po_line_id");

-- CreateIndex
CREATE INDEX "Invoice_tenant_id_idx" ON "Invoice"("tenant_id");

-- CreateIndex
CREATE INDEX "Invoice_tenant_id_status_idx" ON "Invoice"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "Invoice_tenant_id_createdAt_idx" ON "Invoice"("tenant_id", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Invoice_vendor_id_idx" ON "Invoice"("vendor_id");

-- CreateIndex
CREATE INDEX "Invoice_po_id_idx" ON "Invoice"("po_id");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_tenant_id_number_key" ON "Invoice"("tenant_id", "number");

-- CreateIndex
CREATE INDEX "InvoiceLine_tenant_id_idx" ON "InvoiceLine"("tenant_id");

-- CreateIndex
CREATE INDEX "InvoiceLine_invoice_id_idx" ON "InvoiceLine"("invoice_id");

-- CreateIndex
CREATE INDEX "InvoiceException_tenant_id_idx" ON "InvoiceException"("tenant_id");

-- CreateIndex
CREATE INDEX "InvoiceException_invoice_id_idx" ON "InvoiceException"("invoice_id");

-- CreateIndex
CREATE INDEX "InvoiceAttachment_tenant_id_idx" ON "InvoiceAttachment"("tenant_id");

-- CreateIndex
CREATE INDEX "InvoiceAttachment_invoice_id_idx" ON "InvoiceAttachment"("invoice_id");

-- CreateIndex
CREATE INDEX "PaymentRun_tenant_id_idx" ON "PaymentRun"("tenant_id");

-- CreateIndex
CREATE INDEX "PaymentRun_tenant_id_status_idx" ON "PaymentRun"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRun_tenant_id_number_key" ON "PaymentRun"("tenant_id", "number");

-- CreateIndex
CREATE INDEX "PaymentRunItem_tenant_id_idx" ON "PaymentRunItem"("tenant_id");

-- CreateIndex
CREATE INDEX "PaymentRunItem_payment_run_id_idx" ON "PaymentRunItem"("payment_run_id");

-- CreateIndex
CREATE INDEX "PaymentRunItem_invoice_id_idx" ON "PaymentRunItem"("invoice_id");

-- CreateIndex
CREATE INDEX "ApprovalMatrix_tenant_id_idx" ON "ApprovalMatrix"("tenant_id");

-- CreateIndex
CREATE INDEX "ApprovalMatrix_tenant_id_documentType_isActive_idx" ON "ApprovalMatrix"("tenant_id", "documentType", "isActive");

-- CreateIndex
CREATE INDEX "Approval_tenant_id_idx" ON "Approval"("tenant_id");

-- CreateIndex
CREATE INDEX "Approval_tenant_id_documentType_document_id_idx" ON "Approval"("tenant_id", "documentType", "document_id");

-- CreateIndex
CREATE INDEX "Approval_approver_id_idx" ON "Approval"("approver_id");

-- CreateIndex
CREATE INDEX "AuditLog_tenant_id_idx" ON "AuditLog"("tenant_id");

-- CreateIndex
CREATE INDEX "AuditLog_tenant_id_timestamp_idx" ON "AuditLog"("tenant_id", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_tenant_id_entityType_entityId_idx" ON "AuditLog"("tenant_id", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "DomainEvent_tenant_id_idx" ON "DomainEvent"("tenant_id");

-- CreateIndex
CREATE INDEX "DomainEvent_tenant_id_processedAt_idx" ON "DomainEvent"("tenant_id", "processedAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Plant" ADD CONSTRAINT "Plant_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "Plant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostCenter" ADD CONSTRAINT "CostCenter_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostCenter" ADD CONSTRAINT "CostCenter_dept_id_fkey" FOREIGN KEY ("dept_id") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostCenter" ADD CONSTRAINT "CostCenter_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "Plant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorBank" ADD CONSTRAINT "VendorBank_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorContact" ADD CONSTRAINT "VendorContact_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorDocument" ADD CONSTRAINT "VendorDocument_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Requisition" ADD CONSTRAINT "Requisition_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequisitionLine" ADD CONSTRAINT "RequisitionLine_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "Requisition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "Requisition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptNote" ADD CONSTRAINT "GoodsReceiptNote_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptNote" ADD CONSTRAINT "GoodsReceiptNote_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrnLine" ADD CONSTRAINT "GrnLine_grn_id_fkey" FOREIGN KEY ("grn_id") REFERENCES "GoodsReceiptNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrnLine" ADD CONSTRAINT "GrnLine_po_line_id_fkey" FOREIGN KEY ("po_line_id") REFERENCES "PurchaseOrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_po_line_id_fkey" FOREIGN KEY ("po_line_id") REFERENCES "PurchaseOrderLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceException" ADD CONSTRAINT "InvoiceException_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceAttachment" ADD CONSTRAINT "InvoiceAttachment_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRun" ADD CONSTRAINT "PaymentRun_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRunItem" ADD CONSTRAINT "PaymentRunItem_payment_run_id_fkey" FOREIGN KEY ("payment_run_id") REFERENCES "PaymentRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRunItem" ADD CONSTRAINT "PaymentRunItem_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalMatrix" ADD CONSTRAINT "ApprovalMatrix_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_matrix_snapshot_id_fkey" FOREIGN KEY ("matrix_snapshot_id") REFERENCES "ApprovalMatrix"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainEvent" ADD CONSTRAINT "DomainEvent_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
