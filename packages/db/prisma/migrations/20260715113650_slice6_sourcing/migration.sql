-- CreateEnum
CREATE TYPE "RfqType" AS ENUM ('SINGLE_ENVELOPE', 'TWO_ENVELOPE', 'REVERSE_AUCTION', 'FRAMEWORK');

-- CreateEnum
CREATE TYPE "RfqStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'Q_AND_A_OPEN', 'BIDDING_OPEN', 'BID_CLOSED', 'TECH_OPEN', 'COMMERCIAL_OPEN', 'EVALUATION', 'AWARD_PENDING', 'AWARDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RfqInvitationSource" AS ENUM ('PREFERRED', 'DIRECTORY', 'REFERRAL', 'PUBLIC');

-- CreateEnum
CREATE TYPE "RfqInvitationStatus" AS ENUM ('INVITED', 'ACKNOWLEDGED', 'DECLINED', 'QUOTE_SUBMITTED', 'DISQUALIFIED');

-- CreateEnum
CREATE TYPE "RfqCorrigendumImpact" AS ENUM ('DEADLINE_EXTENSION', 'SPEC_CHANGE', 'TERMS_CHANGE', 'CLARIFICATION');

-- CreateEnum
CREATE TYPE "QuoteEnvelopeType" AS ENUM ('TECHNICAL', 'COMMERCIAL', 'COMBINED');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'WITHDRAWN', 'OPENED', 'QUALIFIED', 'DISQUALIFIED', 'DISQUALIFIED_TECH', 'RESUBMISSION_REQUIRED', 'REVISED_SUPERSEDED');

-- CreateEnum
CREATE TYPE "SpecCompliance" AS ENUM ('FULL', 'PARTIAL', 'DEVIATION');

-- CreateEnum
CREATE TYPE "QuoteAttachmentType" AS ENUM ('TECH_SPEC', 'COMMERCIAL_BID', 'CERTIFICATION', 'REFERENCE', 'OTHER');

-- CreateEnum
CREATE TYPE "QuoteEnvelope" AS ENUM ('TECHNICAL', 'COMMERCIAL');

-- CreateEnum
CREATE TYPE "RfqDocumentKind" AS ENUM ('SPEC', 'DRAWING', 'TERMS', 'GENERIC');

-- CreateEnum
CREATE TYPE "ReverseAuctionRoundStatus" AS ENUM ('SCHEDULED', 'LIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AwardStatus" AS ENUM ('RECOMMENDED', 'APPROVED', 'PO_ISSUED', 'REJECTED');

-- AlterEnum
ALTER TYPE "DocumentType" ADD VALUE 'RFQ_AWARD';

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "msme_preference_pct" DECIMAL(6,2) NOT NULL DEFAULT 15,
ADD COLUMN     "new_vendor_default_score" DECIMAL(6,2) NOT NULL DEFAULT 70,
ADD COLUMN     "rfq_min_notice_days" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "rfq_multi_party_open_threshold" DECIMAL(18,4) NOT NULL DEFAULT 2500000;

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "avg_response_time_hours" DECIMAL(10,2),
ADD COLUMN     "capability_tags" TEXT[],
ADD COLUMN     "historical_otif" DECIMAL(6,2),
ADD COLUMN     "historical_quality" DECIMAL(6,2),
ADD COLUMN     "preliminary_status" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Rfq" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "requisition_id" TEXT,
    "category" TEXT NOT NULL,
    "subcategory" TEXT,
    "rfq_type" "RfqType" NOT NULL,
    "status" "RfqStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "incoterm_default" TEXT NOT NULL,
    "delivery_location" JSONB NOT NULL,
    "payment_terms_default" TEXT NOT NULL,
    "estimated_value" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "budget_range_min" DECIMAL(18,4),
    "budget_range_max" DECIMAL(18,4),
    "evaluation_criteria" JSONB NOT NULL,
    "required_documents" JSONB NOT NULL,
    "allow_partial_award" BOOLEAN NOT NULL DEFAULT false,
    "allow_split_award" BOOLEAN NOT NULL DEFAULT true,
    "max_award_vendors" INTEGER NOT NULL DEFAULT 2,
    "blind_evaluation" BOOLEAN NOT NULL DEFAULT false,
    "published_at" TIMESTAMPTZ(6),
    "publish_by" TIMESTAMPTZ(6),
    "qa_deadline" TIMESTAMPTZ(6),
    "bid_deadline" TIMESTAMPTZ(6),
    "tech_open_at" TIMESTAMPTZ(6),
    "commercial_open_at" TIMESTAMPTZ(6),
    "award_deadline" TIMESTAMPTZ(6),
    "allow_bid_revision" BOOLEAN NOT NULL DEFAULT false,
    "revision_count_max" INTEGER NOT NULL DEFAULT 0,
    "corrigenda_count" INTEGER NOT NULL DEFAULT 0,
    "is_reverse_auction" BOOLEAN NOT NULL DEFAULT false,
    "reverse_auction_config" JSONB,
    "spot_buy_exception" BOOLEAN NOT NULL DEFAULT false,
    "cancel_reason" TEXT,
    "created_by" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Rfq_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RfqLine" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rfq_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "item_id" TEXT,
    "item_desc" TEXT NOT NULL,
    "uom" TEXT NOT NULL,
    "qty_required" DECIMAL(18,4) NOT NULL,
    "qty_min_split" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "hsn_code" TEXT,
    "tax_rate" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "spec_details" JSONB,
    "delivery_date_required" TIMESTAMPTZ(6),
    "unit_cost_estimate" DECIMAL(18,4),
    "unit_weight_kg" DECIMAL(18,4),

    CONSTRAINT "RfqLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RfqDocument" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rfq_id" TEXT NOT NULL,
    "doc_type" "RfqDocumentKind" NOT NULL,
    "s3_key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RfqDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RfqInvitation" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rfq_id" TEXT NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "invited_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invited_by" TEXT NOT NULL,
    "invitation_source" "RfqInvitationSource" NOT NULL,
    "status" "RfqInvitationStatus" NOT NULL DEFAULT 'INVITED',
    "acknowledged_at" TIMESTAMPTZ(6),
    "decline_reason" TEXT,
    "can_view_qa" BOOLEAN NOT NULL DEFAULT true,
    "can_bid" BOOLEAN NOT NULL DEFAULT true,
    "is_preliminary" BOOLEAN NOT NULL DEFAULT false,
    "watermark_seed" TEXT NOT NULL,

    CONSTRAINT "RfqInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RfqQuestion" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rfq_id" TEXT NOT NULL,
    "invitation_id" TEXT NOT NULL,
    "question_text" TEXT NOT NULL,
    "asked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "asked_by" TEXT NOT NULL,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "answer_text" TEXT,
    "answered_at" TIMESTAMPTZ(6),
    "answered_by" TEXT,
    "corrigendum_issued" TEXT,

    CONSTRAINT "RfqQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RfqCorrigendum" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rfq_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "impact" "RfqCorrigendumImpact" NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issued_by" TEXT NOT NULL,
    "new_bid_deadline" TIMESTAMPTZ(6),

    CONSTRAINT "RfqCorrigendum_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rfq_id" TEXT NOT NULL,
    "invitation_id" TEXT NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "quote_no" TEXT,
    "envelope_type" "QuoteEnvelopeType" NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "incoterm" TEXT NOT NULL,
    "delivery_location_offered" TEXT,
    "validity_days" INTEGER,
    "validity_until" TIMESTAMPTZ(6),
    "payment_terms_offered" TEXT,
    "total_commercial_value" DECIMAL(18,4),
    "submission_hash" TEXT,
    "submitted_at" TIMESTAMPTZ(6),
    "opened_at" TIMESTAMPTZ(6),
    "opened_by" TEXT,
    "withdrawn_at" TIMESTAMPTZ(6),
    "withdrawal_reason" TEXT,
    "deviation_summary" JSONB,
    "attachment_manifest" JSONB,
    "weighted_score" DECIMAL(8,2),
    "tech_qualified_at" TIMESTAMPTZ(6),
    "tech_qualify_notes" TEXT,
    "revision_no" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteLine" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "quote_id" TEXT NOT NULL,
    "rfq_line_id" TEXT NOT NULL,
    "qty_quoted" DECIMAL(18,4) NOT NULL,
    "unit_price_native" DECIMAL(18,4) NOT NULL,
    "unit_price_inr_landed" DECIMAL(18,4),
    "discount_pct" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "tax_rate" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "line_freight_native" DECIMAL(18,4),
    "line_customs_native" DECIMAL(18,4),
    "line_total_native" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "delivery_lead_days" INTEGER NOT NULL,
    "spec_compliance" "SpecCompliance" NOT NULL DEFAULT 'FULL',
    "deviation_notes" TEXT,
    "no_quote_reason" TEXT,
    "landed_breakdown" JSONB,

    CONSTRAINT "QuoteLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteAttachment" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "quote_id" TEXT NOT NULL,
    "doc_type" "QuoteAttachmentType" NOT NULL,
    "s3_key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "mime_type" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "envelope" "QuoteEnvelope" NOT NULL,
    "watermark_applied" BOOLEAN NOT NULL DEFAULT false,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteEvaluation" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "quote_id" TEXT NOT NULL,
    "evaluator_id" TEXT NOT NULL,
    "criterion" TEXT NOT NULL,
    "weight" INTEGER NOT NULL,
    "raw_score" DECIMAL(6,2) NOT NULL,
    "weighted_score" DECIMAL(8,2) NOT NULL,
    "notes" TEXT,
    "evaluated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReverseAuctionRound" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rfq_id" TEXT NOT NULL,
    "round_no" INTEGER NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "starting_price" DECIMAL(18,4) NOT NULL,
    "decrement_min" DECIMAL(18,4) NOT NULL,
    "decrement_max" DECIMAL(18,4),
    "extension_seconds" INTEGER NOT NULL DEFAULT 120,
    "current_leader_id" TEXT,
    "status" "ReverseAuctionRoundStatus" NOT NULL DEFAULT 'SCHEDULED',
    "created_by" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReverseAuctionRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReverseAuctionBid" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "round_id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "bid_price" DECIMAL(18,4) NOT NULL,
    "bid_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_valid" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ReverseAuctionBid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Award" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rfq_id" TEXT NOT NULL,
    "recommendation_by" TEXT NOT NULL,
    "recommendation_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recommendation_notes" TEXT,
    "variance_from_l1_reason" TEXT,
    "total_value" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "approved_at" TIMESTAMPTZ(6),
    "approved_by" TEXT,
    "status" "AwardStatus" NOT NULL DEFAULT 'RECOMMENDED',
    "approval_matrix_snapshot" JSONB,
    "justification_s3_key" TEXT,
    "justification_hash" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Award_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AwardAllocation" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "award_id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "rfq_line_id" TEXT NOT NULL,
    "qty_allocated" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "total_value" DECIMAL(18,4) NOT NULL,
    "po_id" TEXT,

    CONSTRAINT "AwardAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteOpenLog" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "quote_id" TEXT NOT NULL,
    "envelope" "QuoteEnvelope" NOT NULL,
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "participants" JSONB NOT NULL,
    "hash_before" TEXT,
    "hash_after" TEXT,
    "reason_if_late" TEXT,

    CONSTRAINT "QuoteOpenLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Rfq_tenant_id_idx" ON "Rfq"("tenant_id");

-- CreateIndex
CREATE INDEX "Rfq_tenant_id_status_idx" ON "Rfq"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "Rfq_tenant_id_createdAt_idx" ON "Rfq"("tenant_id", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Rfq_requisition_id_idx" ON "Rfq"("requisition_id");

-- CreateIndex
CREATE UNIQUE INDEX "Rfq_tenant_id_number_key" ON "Rfq"("tenant_id", "number");

-- CreateIndex
CREATE INDEX "RfqLine_tenant_id_idx" ON "RfqLine"("tenant_id");

-- CreateIndex
CREATE INDEX "RfqLine_rfq_id_idx" ON "RfqLine"("rfq_id");

-- CreateIndex
CREATE INDEX "RfqDocument_tenant_id_idx" ON "RfqDocument"("tenant_id");

-- CreateIndex
CREATE INDEX "RfqDocument_rfq_id_idx" ON "RfqDocument"("rfq_id");

-- CreateIndex
CREATE INDEX "RfqInvitation_tenant_id_idx" ON "RfqInvitation"("tenant_id");

-- CreateIndex
CREATE INDEX "RfqInvitation_rfq_id_idx" ON "RfqInvitation"("rfq_id");

-- CreateIndex
CREATE INDEX "RfqInvitation_vendor_id_idx" ON "RfqInvitation"("vendor_id");

-- CreateIndex
CREATE UNIQUE INDEX "RfqInvitation_rfq_id_vendor_id_key" ON "RfqInvitation"("rfq_id", "vendor_id");

-- CreateIndex
CREATE INDEX "RfqQuestion_tenant_id_idx" ON "RfqQuestion"("tenant_id");

-- CreateIndex
CREATE INDEX "RfqQuestion_rfq_id_idx" ON "RfqQuestion"("rfq_id");

-- CreateIndex
CREATE INDEX "RfqQuestion_invitation_id_idx" ON "RfqQuestion"("invitation_id");

-- CreateIndex
CREATE INDEX "RfqCorrigendum_tenant_id_idx" ON "RfqCorrigendum"("tenant_id");

-- CreateIndex
CREATE INDEX "RfqCorrigendum_rfq_id_idx" ON "RfqCorrigendum"("rfq_id");

-- CreateIndex
CREATE INDEX "Quote_tenant_id_idx" ON "Quote"("tenant_id");

-- CreateIndex
CREATE INDEX "Quote_rfq_id_idx" ON "Quote"("rfq_id");

-- CreateIndex
CREATE INDEX "Quote_invitation_id_idx" ON "Quote"("invitation_id");

-- CreateIndex
CREATE INDEX "Quote_vendor_id_idx" ON "Quote"("vendor_id");

-- CreateIndex
CREATE INDEX "Quote_rfq_id_status_idx" ON "Quote"("rfq_id", "status");

-- CreateIndex
CREATE INDEX "QuoteLine_tenant_id_idx" ON "QuoteLine"("tenant_id");

-- CreateIndex
CREATE INDEX "QuoteLine_quote_id_idx" ON "QuoteLine"("quote_id");

-- CreateIndex
CREATE INDEX "QuoteLine_rfq_line_id_idx" ON "QuoteLine"("rfq_line_id");

-- CreateIndex
CREATE INDEX "QuoteAttachment_tenant_id_idx" ON "QuoteAttachment"("tenant_id");

-- CreateIndex
CREATE INDEX "QuoteAttachment_quote_id_idx" ON "QuoteAttachment"("quote_id");

-- CreateIndex
CREATE INDEX "QuoteEvaluation_tenant_id_idx" ON "QuoteEvaluation"("tenant_id");

-- CreateIndex
CREATE INDEX "QuoteEvaluation_quote_id_idx" ON "QuoteEvaluation"("quote_id");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteEvaluation_quote_id_criterion_key" ON "QuoteEvaluation"("quote_id", "criterion");

-- CreateIndex
CREATE INDEX "ReverseAuctionRound_tenant_id_idx" ON "ReverseAuctionRound"("tenant_id");

-- CreateIndex
CREATE INDEX "ReverseAuctionRound_rfq_id_idx" ON "ReverseAuctionRound"("rfq_id");

-- CreateIndex
CREATE INDEX "ReverseAuctionBid_tenant_id_idx" ON "ReverseAuctionBid"("tenant_id");

-- CreateIndex
CREATE INDEX "ReverseAuctionBid_round_id_idx" ON "ReverseAuctionBid"("round_id");

-- CreateIndex
CREATE INDEX "ReverseAuctionBid_quote_id_idx" ON "ReverseAuctionBid"("quote_id");

-- CreateIndex
CREATE INDEX "Award_tenant_id_idx" ON "Award"("tenant_id");

-- CreateIndex
CREATE INDEX "Award_rfq_id_idx" ON "Award"("rfq_id");

-- CreateIndex
CREATE INDEX "Award_tenant_id_status_idx" ON "Award"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "AwardAllocation_tenant_id_idx" ON "AwardAllocation"("tenant_id");

-- CreateIndex
CREATE INDEX "AwardAllocation_award_id_idx" ON "AwardAllocation"("award_id");

-- CreateIndex
CREATE INDEX "AwardAllocation_quote_id_idx" ON "AwardAllocation"("quote_id");

-- CreateIndex
CREATE INDEX "AwardAllocation_vendor_id_idx" ON "AwardAllocation"("vendor_id");

-- CreateIndex
CREATE INDEX "QuoteOpenLog_tenant_id_idx" ON "QuoteOpenLog"("tenant_id");

-- CreateIndex
CREATE INDEX "QuoteOpenLog_quote_id_idx" ON "QuoteOpenLog"("quote_id");

-- AddForeignKey
ALTER TABLE "Rfq" ADD CONSTRAINT "Rfq_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RfqLine" ADD CONSTRAINT "RfqLine_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "Rfq"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RfqDocument" ADD CONSTRAINT "RfqDocument_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "Rfq"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RfqInvitation" ADD CONSTRAINT "RfqInvitation_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "Rfq"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RfqInvitation" ADD CONSTRAINT "RfqInvitation_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RfqQuestion" ADD CONSTRAINT "RfqQuestion_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "Rfq"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RfqQuestion" ADD CONSTRAINT "RfqQuestion_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "RfqInvitation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RfqCorrigendum" ADD CONSTRAINT "RfqCorrigendum_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "Rfq"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "Rfq"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "RfqInvitation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_rfq_line_id_fkey" FOREIGN KEY ("rfq_line_id") REFERENCES "RfqLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteAttachment" ADD CONSTRAINT "QuoteAttachment_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteEvaluation" ADD CONSTRAINT "QuoteEvaluation_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReverseAuctionRound" ADD CONSTRAINT "ReverseAuctionRound_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "Rfq"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReverseAuctionBid" ADD CONSTRAINT "ReverseAuctionBid_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "ReverseAuctionRound"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReverseAuctionBid" ADD CONSTRAINT "ReverseAuctionBid_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Award" ADD CONSTRAINT "Award_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Award" ADD CONSTRAINT "Award_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "Rfq"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AwardAllocation" ADD CONSTRAINT "AwardAllocation_award_id_fkey" FOREIGN KEY ("award_id") REFERENCES "Award"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AwardAllocation" ADD CONSTRAINT "AwardAllocation_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AwardAllocation" ADD CONSTRAINT "AwardAllocation_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteOpenLog" ADD CONSTRAINT "QuoteOpenLog_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
