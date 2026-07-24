/**
 * Sourcing read-model response shapes (Slice 6). Values are strings for money
 * (Master Context §3 rule #4) and ISO strings for timestamps. Pre-open, all
 * commercial values are masked out of these shapes server-side.
 */

import type { LiveApprovalStep } from './approvals';
import type {
  AwardStatus,
  QuoteEnvelopeType,
  QuoteStatus,
  ReverseAuctionRoundStatus,
  RfqCorrigendumImpact,
  RfqInvitationSource,
  RfqInvitationStatus,
  RfqStatus,
  RfqType,
  SpecCompliance,
} from '../constants/sourcing-status';

export interface RfqListItem {
  id: string;
  number: string;
  title: string;
  category: string;
  rfqType: RfqType;
  status: RfqStatus;
  estimatedValue: string;
  currency: string;
  invitedCount: number;
  submittedCount: number;
  bidDeadline: string | null;
  createdAt: string;
}

export interface RfqListResponse {
  items: RfqListItem[];
  nextCursor: string | null;
  totalEstimate: number;
}

export interface RfqLineView {
  id: string;
  lineNo: number;
  itemId: string | null;
  itemDesc: string;
  uom: string;
  qtyRequired: string;
  qtyMinSplit: string;
  hsnCode: string | null;
  taxRate: string;
  specDetails: Record<string, unknown> | null;
  deliveryDateRequired: string | null;
  unitCostEstimate: string | null;
  unitWeightKg: string | null;
}

export interface RfqInvitationView {
  id: string;
  vendorId: string;
  vendorName: string;
  source: RfqInvitationSource;
  status: RfqInvitationStatus;
  isMsme: boolean;
  historicalOtif: string | null;
  historicalQuality: string | null;
  acknowledgedAt: string | null;
  declineReason: string | null;
  /** Masked pre-open — never carries a submitted-at against a name. */
  submittedAt: string | null;
}

export interface RfqQuestionView {
  id: string;
  invitationId: string;
  vendorName: string | null;
  questionText: string;
  isPublic: boolean;
  askedAt: string;
  answerText: string | null;
  answeredAt: string | null;
  corrigendumId: string | null;
}

export interface RfqCorrigendumView {
  id: string;
  number: number;
  title: string;
  description: string;
  impact: RfqCorrigendumImpact;
  issuedAt: string;
  newBidDeadline: string | null;
}

export interface RfqDocumentView {
  id: string;
  docType: string;
  filename: string;
  sizeBytes: number;
  uploadedAt: string;
}

export interface RfqDetailResponse {
  id: string;
  number: string;
  title: string;
  category: string;
  subcategory: string | null;
  rfqType: RfqType;
  status: RfqStatus;
  currency: string;
  incotermDefault: string;
  paymentTermsDefault: string;
  estimatedValue: string;
  requisitionId: string | null;
  requisitionNumber: string | null;
  allowSplitAward: boolean;
  allowPartialAward: boolean;
  maxAwardVendors: number;
  blindEvaluation: boolean;
  isReverseAuction: boolean;
  evaluationCriteria: Array<{
    key: string;
    label: string;
    weight: number;
    auto: boolean;
  }>;
  requiredDocuments: Record<string, boolean>;
  publishBy: string | null;
  qaDeadline: string | null;
  bidDeadline: string | null;
  techOpenAt: string | null;
  commercialOpenAt: string | null;
  awardDeadline: string | null;
  publishedAt: string | null;
  corrigendaCount: number;
  lines: RfqLineView[];
  invitations: RfqInvitationView[];
  questions: RfqQuestionView[];
  corrigenda: RfqCorrigendumView[];
  documents: RfqDocumentView[];
  /** Aggregate only — never the per-vendor breakdown pre-open. */
  submittedCount: number;
  invitedCount: number;
}

export interface QuoteLineView {
  id: string;
  rfqLineId: string;
  qtyQuoted: string;
  unitPriceNative: string | null;
  unitPriceInrLanded: string | null;
  discountPct: string;
  taxRate: string;
  lineTotalNative: string | null;
  deliveryLeadDays: number;
  specCompliance: SpecCompliance;
  deviationNotes: string | null;
}

export interface QuoteView {
  id: string;
  rfqId: string;
  vendorId: string;
  vendorName: string;
  quoteNo: string | null;
  envelopeType: QuoteEnvelopeType;
  status: QuoteStatus;
  currency: string;
  incoterm: string;
  validityDays: number | null;
  validityUntil: string | null;
  paymentTermsOffered: string | null;
  totalCommercialValue: string | null;
  submittedAt: string | null;
  submissionHash: string | null;
  revisionNo: number;
  deviationSummary: Record<string, unknown> | null;
  lines: QuoteLineView[];
  isMsme: boolean;
}

export interface ComparisonRowScore {
  criterion: string;
  weight: number;
  rawScore: string | null;
  weightedScore: string | null;
}

export interface ComparisonRow {
  quoteId: string;
  vendorId: string;
  /** Masked to "Vendor A" etc. in blind mode. */
  displayName: string;
  isMsme: boolean;
  historicalOtif: string | null;
  historicalQuality: string | null;
  pastSpend: string | null;
  totalCommercialValue: string | null;
  totalLandedInr: string | null;
  leadDays: number | null;
  specCompliance: SpecCompliance | null;
  status: QuoteStatus;
  scores: ComparisonRowScore[];
  weightedTotal: string | null;
  rank: number | null;
  rankLabel: string | null;
}

export interface ComparisonMatrixResponse {
  rfqId: string;
  masked: boolean;
  blindEvaluation: boolean;
  criteria: Array<{ key: string; label: string; weight: number; auto: boolean }>;
  lines: RfqLineView[];
  rows: ComparisonRow[];
}

export interface AwardAllocationView {
  quoteId: string;
  vendorId: string;
  vendorName: string;
  rfqLineId: string;
  qtyAllocated: string;
  unitPrice: string;
  totalValue: string;
  poId: string | null;
}

export interface AwardView {
  id: string;
  rfqId: string;
  status: AwardStatus;
  recommendationBy: string;
  recommendationAt: string;
  recommendationNotes: string | null;
  varianceFromL1Reason: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  allocations: AwardAllocationView[];
  approvalChain: LiveApprovalStep[];
  totalValue: string;
}

export interface ReverseAuctionLeaderboardEntry {
  rank: number;
  rankLabel: string;
  /** Buyer view carries the real name; vendor view masks to null. */
  vendorName: string | null;
  /**
   * Buyer view carries every bid. Vendor view exposes price/gap/time only for
   * the viewer's OWN row (isYou); competitors' commercials are null so the SSE
   * payload itself never leaks the price ladder (audit — Slice 6 sealed-quote).
   */
  bidPrice: string | null;
  gapToL1: string | null;
  isYou: boolean;
  bidAt: string | null;
}

export interface ReverseAuctionRoundView {
  id: string;
  roundNo: number;
  status: ReverseAuctionRoundStatus;
  startsAt: string;
  endsAt: string;
  startingPrice: string;
  decrementMin: string;
  extensionSeconds: number;
  currentLeaderId: string | null;
  leaderboard: ReverseAuctionLeaderboardEntry[];
}

// ── Vendor-portal views ──────────────────────────────────────────────────────

export interface VendorRfqListItem {
  id: string;
  number: string;
  title: string;
  category: string;
  rfqType: RfqType;
  status: RfqStatus;
  invitationId: string;
  invitationStatus: RfqInvitationStatus;
  bidDeadline: string | null;
  hasQuote: boolean;
}

export interface VendorRfqListResponse {
  items: VendorRfqListItem[];
}
