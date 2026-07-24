-- CreateEnum
CREATE TYPE "VendorLifecycleStatus" AS ENUM ('INVITED', 'SELF_REGISTERED', 'IN_ONBOARDING', 'UNDER_REVIEW', 'ACTIVE', 'SUSPENDED', 'BLACKLISTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "LegalEntityType" AS ENUM ('PROPRIETORSHIP', 'PARTNERSHIP', 'LLP', 'PVT_LTD', 'PUBLIC_LTD', 'HUF', 'TRUST', 'SOCIETY', 'INDIVIDUAL');

-- CreateEnum
CREATE TYPE "OnboardingInvitationSource" AS ENUM ('BUYER_INVITE_RFQ', 'BUYER_INVITE_SPOT', 'SELF_REGISTRATION');

-- CreateEnum
CREATE TYPE "OnboardingReviewDecision" AS ENUM ('APPROVED', 'REJECTED', 'RETURNED_FOR_INFO');

-- CreateEnum
CREATE TYPE "DocVerificationStatus" AS ENUM ('PENDING', 'AUTO_VERIFIED', 'MANUALLY_VERIFIED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ScreeningType" AS ENUM ('GSTIN_STATUS', 'PAN_STATUS', 'UDYAM_STATUS', 'MCA_DIRECTORS', 'RBI_DEFAULTER', 'SANCTIONS_OFAC', 'SANCTIONS_EU', 'SANCTIONS_UK', 'ADVERSE_MEDIA', 'CREDIT_BUREAU');

-- CreateEnum
CREATE TYPE "ScreeningStatus" AS ENUM ('PENDING', 'CLEAR', 'FLAGGED', 'ERROR', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ScreeningFlagSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ScreeningReviewDecision" AS ENUM ('CLEAR', 'ACCEPT_RISK', 'REJECT_VENDOR');

-- CreateEnum
CREATE TYPE "SanctionsScreeningStatus" AS ENUM ('NOT_LISTED', 'POTENTIAL_MATCH', 'CONFIRMED_MATCH', 'CLEARED');

-- CreateEnum
CREATE TYPE "OwnershipType" AS ENUM ('DIRECT', 'INDIRECT', 'CONTROL_VIA_AGREEMENT');

-- CreateEnum
CREATE TYPE "SuspensionType" AS ENUM ('TEMPORARY', 'INDEFINITE', 'BLACKLIST');

-- CreateEnum
CREATE TYPE "SuspensionReasonCode" AS ENUM ('DOC_EXPIRED', 'QUALITY_ISSUE', 'PAYMENT_DISPUTE', 'COMPLIANCE_BREACH', 'SANCTIONS_HIT', 'REQUESTED_BY_VENDOR', 'OTHER');

-- CreateEnum
CREATE TYPE "ChangeRequestType" AS ENUM ('BANK_CHANGE', 'GSTIN_CHANGE', 'OWNERSHIP_CHANGE', 'CATEGORY_ADD', 'CONTACT_UPDATE');

-- CreateEnum
CREATE TYPE "ChangeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'AUTO_APPROVED');

-- CreateEnum
CREATE TYPE "ScorecardPeriod" AS ENUM ('ROLLING_90D', 'ROLLING_365D', 'ALL_TIME');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DocumentType" ADD VALUE 'VENDOR_ONBOARDING';
ALTER TYPE "DocumentType" ADD VALUE 'VENDOR_CHANGE';

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "activated_at" TIMESTAMPTZ(6),
ADD COLUMN     "activated_by" TEXT,
ADD COLUMN     "annual_turnover_declared" DECIMAL(18,4),
ADD COLUMN     "blacklist_reason" TEXT,
ADD COLUMN     "blacklisted_at" TIMESTAMPTZ(6),
ADD COLUMN     "blacklisted_by" TEXT,
ADD COLUMN     "business_pan" TEXT,
ADD COLUMN     "business_pan_verified_at" TIMESTAMPTZ(6),
ADD COLUMN     "category_config_key" TEXT,
ADD COLUMN     "coc_ack_device" TEXT,
ADD COLUMN     "coc_ack_ip" TEXT,
ADD COLUMN     "coc_acknowledged_at" TIMESTAMPTZ(6),
ADD COLUMN     "data_processing_consent_at" TIMESTAMPTZ(6),
ADD COLUMN     "date_of_incorporation" TIMESTAMPTZ(6),
ADD COLUMN     "employee_count_bracket" TEXT,
ADD COLUMN     "is_related_party" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "legal_entity_name" TEXT,
ADD COLUMN     "legal_entity_type" "LegalEntityType",
ADD COLUMN     "lifecycle_status" "VendorLifecycleStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "onboarding_started_at" TIMESTAMPTZ(6),
ADD COLUMN     "related_party_disclosure" TEXT,
ADD COLUMN     "risk_grade" TEXT,
ADD COLUMN     "risk_last_computed_at" TIMESTAMPTZ(6),
ADD COLUMN     "suspended_at" TIMESTAMPTZ(6),
ADD COLUMN     "suspended_by" TEXT,
ADD COLUMN     "suspension_reason" TEXT,
ADD COLUMN     "turnover_currency" TEXT NOT NULL DEFAULT 'INR';

-- AlterTable
ALTER TABLE "VendorBank" ADD COLUMN     "is_archived" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "manual_override_reason" TEXT,
ADD COLUMN     "name_match_algorithm" TEXT,
ADD COLUMN     "name_match_score" DECIMAL(6,4),
ADD COLUMN     "overridden_by" TEXT,
ADD COLUMN     "penny_drop_credited_at" TIMESTAMPTZ(6),
ADD COLUMN     "penny_drop_name_returned" TEXT;

-- AlterTable
ALTER TABLE "VendorContact" ADD COLUMN     "department" TEXT,
ADD COLUMN     "is_authorized_signatory" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "valid_from" TIMESTAMPTZ(6),
ADD COLUMN     "valid_to" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "VendorDocument" ADD COLUMN     "document_number" TEXT,
ADD COLUMN     "file_hash" TEXT,
ADD COLUMN     "filename" TEXT,
ADD COLUMN     "issued_by" TEXT,
ADD COLUMN     "mime_type" TEXT,
ADD COLUMN     "rejection_reason" TEXT,
ADD COLUMN     "reminder_sent_at" TIMESTAMPTZ(6),
ADD COLUMN     "size_bytes" INTEGER,
ADD COLUMN     "uploaded_at" TIMESTAMPTZ(6),
ADD COLUMN     "uploaded_by" TEXT,
ADD COLUMN     "verification_ref" TEXT,
ADD COLUMN     "verification_source" TEXT,
ADD COLUMN     "verification_status" "DocVerificationStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "verified_by" TEXT;

-- CreateTable
CREATE TABLE "VendorOnboarding" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "invitation_source" "OnboardingInvitationSource" NOT NULL,
    "invitation_ref" TEXT,
    "invited_by" TEXT,
    "self_registration_token" TEXT,
    "token_expires_at" TIMESTAMPTZ(6),
    "email_verified_at" TIMESTAMPTZ(6),
    "wizard_state" JSONB NOT NULL,
    "category_config_key" TEXT NOT NULL,
    "review_decision" "OnboardingReviewDecision",
    "reviewed_by" TEXT,
    "review_notes" TEXT,
    "review_started_at" TIMESTAMPTZ(6),
    "return_for_info_items" JSONB,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMPTZ(6),
    "decision_at" TIMESTAMPTZ(6),
    "sla_target_hours" INTEGER NOT NULL,
    "sla_breach_at" TIMESTAMPTZ(6),
    "approval_matrix_snapshot" JSONB,

    CONSTRAINT "VendorOnboarding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorBeneficialOwner" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "owner_name" TEXT NOT NULL,
    "owner_pan" TEXT NOT NULL,
    "owner_dob" TIMESTAMPTZ(6),
    "ownership_pct" DECIMAL(6,2) NOT NULL,
    "ownership_type" "OwnershipType" NOT NULL DEFAULT 'DIRECT',
    "country_of_residence" TEXT NOT NULL DEFAULT 'IN',
    "is_pep" BOOLEAN NOT NULL DEFAULT false,
    "pep_details" TEXT,
    "sanctions_screening_status" "SanctionsScreeningStatus" NOT NULL DEFAULT 'NOT_LISTED',
    "sanctions_screening_at" TIMESTAMPTZ(6),
    "declared_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "declared_by" TEXT NOT NULL,

    CONSTRAINT "VendorBeneficialOwner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorScreening" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "screening_type" "ScreeningType" NOT NULL,
    "screening_provider" TEXT NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "status" "ScreeningStatus" NOT NULL DEFAULT 'PENDING',
    "flag_severity" "ScreeningFlagSeverity",
    "provider_response" JSONB,
    "findings" JSONB,
    "reviewed_by" TEXT,
    "review_decision" "ScreeningReviewDecision",
    "review_notes" TEXT,
    "next_screening_due_at" TIMESTAMPTZ(6),

    CONSTRAINT "VendorScreening_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorCategoryConfig" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "category_key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT,
    "required_documents" JSONB NOT NULL,
    "optional_documents" JSONB NOT NULL,
    "required_screenings" JSONB NOT NULL,
    "required_certifications" JSONB NOT NULL,
    "approval_matrix_name" TEXT NOT NULL,
    "sla_hours" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "VendorCategoryConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorScorecard" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "category_key" TEXT,
    "period" "ScorecardPeriod" NOT NULL,
    "metrics" JSONB NOT NULL,
    "score" DECIMAL(6,2),
    "grade" TEXT NOT NULL,
    "transaction_count" INTEGER NOT NULL DEFAULT 0,
    "spend_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "computed_by" TEXT,

    CONSTRAINT "VendorScorecard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorSuspension" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "suspension_type" "SuspensionType" NOT NULL,
    "reason_code" "SuspensionReasonCode" NOT NULL,
    "reason_notes" TEXT NOT NULL,
    "imposed_by" TEXT NOT NULL,
    "imposed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cosigned_by" TEXT,
    "effective_from" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_until" TIMESTAMPTZ(6),
    "lift_conditions" TEXT,
    "lifted_by" TEXT,
    "lifted_at" TIMESTAMPTZ(6),
    "lift_reason" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "VendorSuspension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorChangeRequest" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "request_type" "ChangeRequestType" NOT NULL,
    "proposed_changes" JSONB NOT NULL,
    "current_values" JSONB NOT NULL,
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requires_reverification" BOOLEAN NOT NULL DEFAULT false,
    "reverification_types" JSONB,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(6),
    "decided_by" TEXT,
    "decision_notes" TEXT,
    "approval_matrix_snapshot" JSONB,

    CONSTRAINT "VendorChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorOnboarding_tenant_id_idx" ON "VendorOnboarding"("tenant_id");

-- CreateIndex
CREATE INDEX "VendorOnboarding_tenant_id_vendor_id_idx" ON "VendorOnboarding"("tenant_id", "vendor_id");

-- CreateIndex
CREATE INDEX "VendorOnboarding_self_registration_token_idx" ON "VendorOnboarding"("self_registration_token");

-- CreateIndex
CREATE INDEX "VendorBeneficialOwner_tenant_id_idx" ON "VendorBeneficialOwner"("tenant_id");

-- CreateIndex
CREATE INDEX "VendorBeneficialOwner_vendor_id_idx" ON "VendorBeneficialOwner"("vendor_id");

-- CreateIndex
CREATE INDEX "VendorScreening_tenant_id_idx" ON "VendorScreening"("tenant_id");

-- CreateIndex
CREATE INDEX "VendorScreening_vendor_id_idx" ON "VendorScreening"("vendor_id");

-- CreateIndex
CREATE INDEX "VendorScreening_tenant_id_vendor_id_screening_type_idx" ON "VendorScreening"("tenant_id", "vendor_id", "screening_type");

-- CreateIndex
CREATE INDEX "VendorCategoryConfig_tenant_id_idx" ON "VendorCategoryConfig"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "VendorCategoryConfig_tenant_id_category_key_key" ON "VendorCategoryConfig"("tenant_id", "category_key");

-- CreateIndex
CREATE INDEX "VendorScorecard_tenant_id_idx" ON "VendorScorecard"("tenant_id");

-- CreateIndex
CREATE INDEX "VendorScorecard_vendor_id_idx" ON "VendorScorecard"("vendor_id");

-- CreateIndex
CREATE UNIQUE INDEX "VendorScorecard_vendor_id_category_key_period_key" ON "VendorScorecard"("vendor_id", "category_key", "period");

-- CreateIndex
CREATE INDEX "VendorSuspension_tenant_id_idx" ON "VendorSuspension"("tenant_id");

-- CreateIndex
CREATE INDEX "VendorSuspension_vendor_id_idx" ON "VendorSuspension"("vendor_id");

-- CreateIndex
CREATE INDEX "VendorSuspension_tenant_id_vendor_id_is_active_idx" ON "VendorSuspension"("tenant_id", "vendor_id", "is_active");

-- CreateIndex
CREATE INDEX "VendorChangeRequest_tenant_id_idx" ON "VendorChangeRequest"("tenant_id");

-- CreateIndex
CREATE INDEX "VendorChangeRequest_vendor_id_idx" ON "VendorChangeRequest"("vendor_id");

-- CreateIndex
CREATE INDEX "VendorChangeRequest_tenant_id_status_idx" ON "VendorChangeRequest"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "Vendor_tenant_id_lifecycle_status_idx" ON "Vendor"("tenant_id", "lifecycle_status");

-- CreateIndex
CREATE INDEX "VendorDocument_tenant_id_validTo_idx" ON "VendorDocument"("tenant_id", "validTo");

-- AddForeignKey
ALTER TABLE "VendorOnboarding" ADD CONSTRAINT "VendorOnboarding_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorOnboarding" ADD CONSTRAINT "VendorOnboarding_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorBeneficialOwner" ADD CONSTRAINT "VendorBeneficialOwner_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorBeneficialOwner" ADD CONSTRAINT "VendorBeneficialOwner_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorScreening" ADD CONSTRAINT "VendorScreening_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorScreening" ADD CONSTRAINT "VendorScreening_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorCategoryConfig" ADD CONSTRAINT "VendorCategoryConfig_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorScorecard" ADD CONSTRAINT "VendorScorecard_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorScorecard" ADD CONSTRAINT "VendorScorecard_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorSuspension" ADD CONSTRAINT "VendorSuspension_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorSuspension" ADD CONSTRAINT "VendorSuspension_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorChangeRequest" ADD CONSTRAINT "VendorChangeRequest_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorChangeRequest" ADD CONSTRAINT "VendorChangeRequest_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
