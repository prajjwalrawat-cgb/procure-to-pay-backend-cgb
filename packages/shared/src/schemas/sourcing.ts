import { z } from 'zod';

import { INCOTERMS } from '../constants/status';
import {
  QUOTE_ATTACHMENT_TYPE,
  QUOTE_ENVELOPE,
  QUOTE_ENVELOPE_TYPE,
  QUOTE_TECH_DECISION,
  RFQ_CORRIGENDUM_IMPACT,
  RFQ_DOCUMENT_TYPE,
  RFQ_INVITATION_SOURCE,
  RFQ_TYPE,
  SPEC_COMPLIANCE,
} from '../constants/sourcing-status';

const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string');

// ── Evaluation criteria ──────────────────────────────────────────────────────

export const EvaluationCriterionSchema = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
  weight: z.number().int().min(0).max(100),
  auto: z.boolean().default(false),
});
export type EvaluationCriterionInput = z.infer<typeof EvaluationCriterionSchema>;

export const DeliveryLocationSchema = z.object({
  label: z.string().max(120).nullish(),
  line1: z.string().max(200).nullish(),
  city: z.string().max(80).nullish(),
  stateCode: z.string().max(2),
  plantId: z.string().nullish(),
});
export type DeliveryLocationInput = z.infer<typeof DeliveryLocationSchema>;

// ── RFQ lines ────────────────────────────────────────────────────────────────

export const RfqLineInputSchema = z.object({
  itemId: z.string().nullish(),
  itemDesc: z.string().min(1).max(500),
  uom: z.string().min(1).max(20),
  qtyRequired: decimalString,
  qtyMinSplit: decimalString.default('0'),
  hsnCode: z.string().max(12).nullish(),
  taxRate: decimalString.default('0'),
  specDetails: z.record(z.unknown()).nullish(),
  deliveryDateRequired: z.string().datetime().nullish(),
  unitCostEstimate: decimalString.nullish(),
  unitWeightKg: decimalString.nullish(),
});
export type RfqLineInput = z.infer<typeof RfqLineInputSchema>;

// ── RFQ create / update ──────────────────────────────────────────────────────

export const RfqReverseAuctionConfigSchema = z.object({
  decrementMin: decimalString,
  decrementMax: decimalString.nullish(),
  extensionSeconds: z.number().int().min(0).max(900).default(120),
  roundMinutes: z.number().int().min(1).max(240).default(30),
});
export type RfqReverseAuctionConfig = z.infer<typeof RfqReverseAuctionConfigSchema>;

export const RfqCreateInputSchema = z.object({
  title: z.string().min(1).max(200),
  requisitionId: z.string().nullish(),
  category: z.string().min(1).max(120),
  subcategory: z.string().max(120).nullish(),
  rfqType: z.enum(RFQ_TYPE),
  currency: z.string().length(3).default('INR'),
  incotermDefault: z.enum(INCOTERMS).default('DDP'),
  deliveryLocation: DeliveryLocationSchema,
  paymentTermsDefault: z.string().max(60).default('NET_45'),
  estimatedValue: decimalString.default('0'),
  budgetRangeMin: decimalString.nullish(),
  budgetRangeMax: decimalString.nullish(),
  evaluationCriteria: z.array(EvaluationCriterionSchema).min(1),
  requiredDocuments: z.record(z.boolean()).default({}),
  allowPartialAward: z.boolean().default(false),
  allowSplitAward: z.boolean().default(true),
  maxAwardVendors: z.number().int().min(1).max(5).default(2),
  allowBidRevision: z.boolean().default(false),
  revisionCountMax: z.number().int().min(0).max(5).default(0),
  blindEvaluation: z.boolean().default(false),
  isReverseAuction: z.boolean().default(false),
  reverseAuctionConfig: RfqReverseAuctionConfigSchema.nullish(),
  lines: z.array(RfqLineInputSchema).min(1),
});
export type RfqCreateInput = z.infer<typeof RfqCreateInputSchema>;

export const RfqUpdateInputSchema = RfqCreateInputSchema.partial().extend({
  evaluationCriteria: z.array(EvaluationCriterionSchema).min(1).optional(),
  lines: z.array(RfqLineInputSchema).min(1).optional(),
});
export type RfqUpdateInput = z.infer<typeof RfqUpdateInputSchema>;

// ── Timing / publish ─────────────────────────────────────────────────────────

export const RfqPublishInputSchema = z.object({
  qaDeadline: z.string().datetime().nullish(),
  bidDeadline: z.string().datetime(),
  techOpenAt: z.string().datetime().nullish(),
  commercialOpenAt: z.string().datetime().nullish(),
  awardDeadline: z.string().datetime().nullish(),
  spotBuyException: z.boolean().default(false),
});
export type RfqPublishInput = z.infer<typeof RfqPublishInputSchema>;

// ── Invitations ──────────────────────────────────────────────────────────────

export const RfqInvitationInputSchema = z.object({
  vendorIds: z.array(z.string().min(1)).min(1),
  source: z.enum(RFQ_INVITATION_SOURCE).default('DIRECTORY'),
  isPreliminaryInvitation: z.boolean().default(false),
});
export type RfqInvitationInput = z.infer<typeof RfqInvitationInputSchema>;

export const RfqNewVendorInviteSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  categoryTags: z.array(z.string()).default([]),
});
export type RfqNewVendorInvite = z.infer<typeof RfqNewVendorInviteSchema>;

export const RfqRemoveInvitationSchema = z.object({ reason: z.string().min(1).max(500) });
export type RfqRemoveInvitationInput = z.infer<typeof RfqRemoveInvitationSchema>;

// ── Corrigendum / cancel ─────────────────────────────────────────────────────

export const RfqCorrigendumInputSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(4000),
  impact: z.enum(RFQ_CORRIGENDUM_IMPACT),
  newBidDeadline: z.string().datetime().nullish(),
});
export type RfqCorrigendumInput = z.infer<typeof RfqCorrigendumInputSchema>;

export const RfqCancelInputSchema = z.object({ reason: z.string().min(1).max(500) });
export type RfqCancelInput = z.infer<typeof RfqCancelInputSchema>;

// ── Documents ────────────────────────────────────────────────────────────────

export const RfqDocumentInputSchema = z.object({
  docType: z.enum(RFQ_DOCUMENT_TYPE),
  s3Key: z.string().min(1),
  filename: z.string().min(1).max(300),
  sizeBytes: z.number().int().min(0),
});
export type RfqDocumentInput = z.infer<typeof RfqDocumentInputSchema>;

// ── Q&A ──────────────────────────────────────────────────────────────────────

export const RfqQuestionInputSchema = z.object({
  invitationId: z.string().min(1),
  questionText: z.string().min(1).max(2000),
  isPublic: z.boolean().default(true),
});
export type RfqQuestionInput = z.infer<typeof RfqQuestionInputSchema>;

export const RfqAnswerInputSchema = z.object({
  answerText: z.string().min(1).max(4000),
  corrigendumId: z.string().nullish(),
});
export type RfqAnswerInput = z.infer<typeof RfqAnswerInputSchema>;

// ── Quotes (vendor) ──────────────────────────────────────────────────────────

export const QuoteCreateInputSchema = z.object({
  rfqId: z.string().min(1),
  /** Optional — the backend resolves the vendor's own invitation from the JWT. */
  invitationId: z.string().min(1).nullish(),
  envelopeType: z.enum(QUOTE_ENVELOPE_TYPE).default('COMBINED'),
  quoteNo: z.string().max(60).nullish(),
});
export type QuoteCreateInput = z.infer<typeof QuoteCreateInputSchema>;

export const QuoteLineInputSchema = z.object({
  rfqLineId: z.string().min(1),
  qtyQuoted: decimalString,
  unitPriceNative: decimalString,
  discountPct: decimalString.default('0'),
  taxRate: decimalString.default('0'),
  lineFreightNative: decimalString.nullish(),
  lineCustomsNative: decimalString.nullish(),
  deliveryLeadDays: z.number().int().min(0).max(3650),
  specCompliance: z.enum(SPEC_COMPLIANCE).default('FULL'),
  deviationNotes: z.string().max(2000).nullish(),
  noQuoteReason: z.string().max(500).nullish(),
});
export type QuoteLineInput = z.infer<typeof QuoteLineInputSchema>;

export const QuoteUpdateInputSchema = z.object({
  currency: z.string().length(3).nullish(),
  incoterm: z.enum(INCOTERMS).nullish(),
  deliveryLocationOffered: z.string().max(200).nullish(),
  validityDays: z.number().int().min(1).max(365).nullish(),
  paymentTermsOffered: z.string().max(60).nullish(),
  lines: z.array(QuoteLineInputSchema).min(1),
});
export type QuoteUpdateInput = z.infer<typeof QuoteUpdateInputSchema>;

export const QuoteAttachmentInputSchema = z.object({
  envelope: z.enum(QUOTE_ENVELOPE),
  docType: z.enum(QUOTE_ATTACHMENT_TYPE),
  s3Key: z.string().min(1),
  filename: z.string().min(1).max(300),
  sizeBytes: z.number().int().min(0),
  mimeType: z.string().max(120).default('application/pdf'),
  fileHash: z.string().min(1),
});
export type QuoteAttachmentInput = z.infer<typeof QuoteAttachmentInputSchema>;

export const QuoteWithdrawInputSchema = z.object({ reason: z.string().min(1).max(500) });
export type QuoteWithdrawInput = z.infer<typeof QuoteWithdrawInputSchema>;

export const RfqDeclineInputSchema = z.object({ reason: z.string().min(1).max(500) });
export type RfqDeclineInput = z.infer<typeof RfqDeclineInputSchema>;

// ── Opening ceremony ─────────────────────────────────────────────────────────

export const QuoteOpenInputSchema = z.object({
  participantUserIds: z.array(z.string().min(1)).min(1),
});
export type QuoteOpenInput = z.infer<typeof QuoteOpenInputSchema>;

export const QuoteQualifyInputSchema = z.object({
  decision: z.enum(QUOTE_TECH_DECISION),
  notes: z.string().max(2000).nullish(),
});
export type QuoteQualifyInput = z.infer<typeof QuoteQualifyInputSchema>;

// ── Evaluation ───────────────────────────────────────────────────────────────

export const QuoteEvaluateInputSchema = z.object({
  scores: z
    .array(
      z.object({
        criterion: z.string().min(1),
        rawScore: z.number().min(0).max(100),
        notes: z.string().max(2000).nullish(),
      }),
    )
    .min(1),
});
export type QuoteEvaluateInput = z.infer<typeof QuoteEvaluateInputSchema>;

// ── Award ────────────────────────────────────────────────────────────────────

export const AwardAllocationInputSchema = z.object({
  quoteId: z.string().min(1),
  rfqLineId: z.string().min(1),
  qtyAllocated: decimalString,
  unitPrice: decimalString,
});
export type AwardAllocationInput = z.infer<typeof AwardAllocationInputSchema>;

export const AwardRecommendInputSchema = z.object({
  allocations: z.array(AwardAllocationInputSchema).min(1),
  notes: z.string().max(4000).nullish(),
  varianceFromL1Reason: z.string().max(4000).nullish(),
});
export type AwardRecommendInput = z.infer<typeof AwardRecommendInputSchema>;

export const AwardDecisionInputSchema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(['APPROVE', 'REJECT', 'CHANGES']),
  comment: z.string().max(2000).nullish(),
});
export type AwardDecisionInput = z.infer<typeof AwardDecisionInputSchema>;

// ── Reverse auction ──────────────────────────────────────────────────────────

export const ReverseAuctionStartInputSchema = z.object({
  startsAt: z.string().datetime(),
  durationMinutes: z.number().int().min(1).max(240).default(30),
  startingPrice: decimalString,
  decrementMin: decimalString,
  decrementMax: decimalString.nullish(),
  extensionSeconds: z.number().int().min(0).max(900).default(120),
});
export type ReverseAuctionStartInput = z.infer<typeof ReverseAuctionStartInputSchema>;

export const ReverseAuctionBidInputSchema = z.object({
  roundId: z.string().min(1),
  quoteId: z.string().min(1),
  bidPrice: decimalString,
});
export type ReverseAuctionBidInput = z.infer<typeof ReverseAuctionBidInputSchema>;

// ── List query ───────────────────────────────────────────────────────────────

export const RfqListQuerySchema = z.object({
  tab: z
    .enum(['active', 'draft', 'my_action', 'evaluation', 'awarded', 'cancelled'])
    .default('active'),
  category: z.string().nullish(),
  status: z.string().nullish(),
  type: z.enum(RFQ_TYPE).nullish(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().nullish(),
});
export type RfqListQuery = z.infer<typeof RfqListQuerySchema>;
