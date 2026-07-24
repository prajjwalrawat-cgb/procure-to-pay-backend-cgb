/**
 * Sourcing / RFQ status enums (Slice 6). Financial-adjacent documents never
 * soft-delete (Master Context §3 rule #10) — RFQs, quotes and awards move
 * through these states. Mirrored by the Prisma enums in the DB package.
 */

export const RFQ_TYPE = [
  'SINGLE_ENVELOPE',
  'TWO_ENVELOPE',
  'REVERSE_AUCTION',
  'FRAMEWORK',
] as const;
export type RfqType = (typeof RFQ_TYPE)[number];

export const RFQ_STATUS = [
  'DRAFT',
  'PUBLISHED',
  'Q_AND_A_OPEN',
  'BIDDING_OPEN',
  'BID_CLOSED',
  'TECH_OPEN',
  'COMMERCIAL_OPEN',
  'EVALUATION',
  'AWARD_PENDING',
  'AWARDED',
  'CANCELLED',
] as const;
export type RfqStatus = (typeof RFQ_STATUS)[number];

export const RFQ_INVITATION_SOURCE = [
  'PREFERRED',
  'DIRECTORY',
  'REFERRAL',
  'PUBLIC',
] as const;
export type RfqInvitationSource = (typeof RFQ_INVITATION_SOURCE)[number];

export const RFQ_INVITATION_STATUS = [
  'INVITED',
  'ACKNOWLEDGED',
  'DECLINED',
  'QUOTE_SUBMITTED',
  'DISQUALIFIED',
] as const;
export type RfqInvitationStatus = (typeof RFQ_INVITATION_STATUS)[number];

export const RFQ_CORRIGENDUM_IMPACT = [
  'DEADLINE_EXTENSION',
  'SPEC_CHANGE',
  'TERMS_CHANGE',
  'CLARIFICATION',
] as const;
export type RfqCorrigendumImpact = (typeof RFQ_CORRIGENDUM_IMPACT)[number];

export const QUOTE_ENVELOPE_TYPE = ['TECHNICAL', 'COMMERCIAL', 'COMBINED'] as const;
export type QuoteEnvelopeType = (typeof QUOTE_ENVELOPE_TYPE)[number];

export const QUOTE_STATUS = [
  'DRAFT',
  'SUBMITTED',
  'WITHDRAWN',
  'OPENED',
  'QUALIFIED',
  'DISQUALIFIED',
  'DISQUALIFIED_TECH',
  'RESUBMISSION_REQUIRED',
  'REVISED_SUPERSEDED',
] as const;
export type QuoteStatus = (typeof QUOTE_STATUS)[number];

export const SPEC_COMPLIANCE = ['FULL', 'PARTIAL', 'DEVIATION'] as const;
export type SpecCompliance = (typeof SPEC_COMPLIANCE)[number];

export const QUOTE_ATTACHMENT_TYPE = [
  'TECH_SPEC',
  'COMMERCIAL_BID',
  'CERTIFICATION',
  'REFERENCE',
  'OTHER',
] as const;
export type QuoteAttachmentType = (typeof QUOTE_ATTACHMENT_TYPE)[number];

export const QUOTE_ENVELOPE = ['TECHNICAL', 'COMMERCIAL'] as const;
export type QuoteEnvelope = (typeof QUOTE_ENVELOPE)[number];

export const RFQ_DOCUMENT_TYPE = ['SPEC', 'DRAWING', 'TERMS', 'GENERIC'] as const;
export type RfqDocumentType = (typeof RFQ_DOCUMENT_TYPE)[number];

export const REVERSE_AUCTION_ROUND_STATUS = [
  'SCHEDULED',
  'LIVE',
  'COMPLETED',
  'CANCELLED',
] as const;
export type ReverseAuctionRoundStatus = (typeof REVERSE_AUCTION_ROUND_STATUS)[number];

export const AWARD_STATUS = ['RECOMMENDED', 'APPROVED', 'PO_ISSUED', 'REJECTED'] as const;
export type AwardStatus = (typeof AWARD_STATUS)[number];

export const QUOTE_TECH_DECISION = ['QUALIFIED', 'DISQUALIFIED'] as const;
export type QuoteTechDecision = (typeof QUOTE_TECH_DECISION)[number];

/** RFQ status → the stages strip on the detail page (Slice 6 frontend §3). */
export const RFQ_STAGE_STRIP: RfqStatus[] = [
  'DRAFT',
  'PUBLISHED',
  'Q_AND_A_OPEN',
  'BIDDING_OPEN',
  'TECH_OPEN',
  'COMMERCIAL_OPEN',
  'EVALUATION',
  'AWARD_PENDING',
  'AWARDED',
];
