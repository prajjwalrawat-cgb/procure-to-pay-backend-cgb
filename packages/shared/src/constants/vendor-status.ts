/**
 * Vendor lifecycle + onboarding + screening enums (Slice 7). Mirrored by the
 * Prisma enums in the DB package. Vendors are never deleted (§3 rule #10) — they
 * move through these lifecycle states.
 */

export const VENDOR_LIFECYCLE_STATUS = [
  'INVITED',
  'SELF_REGISTERED',
  'IN_ONBOARDING',
  'UNDER_REVIEW',
  'ACTIVE',
  'SUSPENDED',
  'BLACKLISTED',
  'ARCHIVED',
] as const;
export type VendorLifecycleStatus = (typeof VENDOR_LIFECYCLE_STATUS)[number];

export const LEGAL_ENTITY_TYPE = [
  'PROPRIETORSHIP',
  'PARTNERSHIP',
  'LLP',
  'PVT_LTD',
  'PUBLIC_LTD',
  'HUF',
  'TRUST',
  'SOCIETY',
  'INDIVIDUAL',
] as const;
export type LegalEntityType = (typeof LEGAL_ENTITY_TYPE)[number];

/** Legal-entity types that must disclose beneficial owners ≥25% (PMLA/MCA). */
export const COMPANY_ENTITY_TYPES: LegalEntityType[] = [
  'PARTNERSHIP',
  'LLP',
  'PVT_LTD',
  'PUBLIC_LTD',
  'TRUST',
  'SOCIETY',
];

export const EMPLOYEE_COUNT_BRACKET = [
  '<10',
  '10-50',
  '50-250',
  '250-1000',
  '1000+',
] as const;
export type EmployeeCountBracket = (typeof EMPLOYEE_COUNT_BRACKET)[number];

export const VENDOR_RISK_GRADE = ['A+', 'A', 'B', 'C', 'D'] as const;
export type VendorRiskGrade = (typeof VENDOR_RISK_GRADE)[number];

export const ONBOARDING_INVITATION_SOURCE = [
  'BUYER_INVITE_RFQ',
  'BUYER_INVITE_SPOT',
  'SELF_REGISTRATION',
] as const;
export type OnboardingInvitationSource = (typeof ONBOARDING_INVITATION_SOURCE)[number];

export const ONBOARDING_REVIEW_DECISION = [
  'APPROVED',
  'REJECTED',
  'RETURNED_FOR_INFO',
] as const;
export type OnboardingReviewDecision = (typeof ONBOARDING_REVIEW_DECISION)[number];

export const VENDOR_DOCUMENT_TYPE = [
  'GST_CERT',
  'PAN_CARD',
  'MSME_UDYAM',
  'INCORPORATION_CERT',
  'AUTHORIZED_SIGNATORY_LETTER',
  'ADDRESS_PROOF',
  'CANCELLED_CHEQUE',
  'ISO_9001',
  'ISO_14001',
  'ISO_45001',
  'ISO_27001',
  'REACH_DECL',
  'SDS',
  'FACTORY_LICENSE',
  'POLLUTION_NOC',
  'FSSAI',
  'BIS_CERT',
  'RC_BOOK',
  'DRIVING_LICENSE',
  'INSURANCE_POLICY',
  'AUDITED_FINANCIALS',
  'CREDIT_REPORT',
  'CODE_OF_CONDUCT',
  'OTHER',
] as const;
export type VendorDocumentType = (typeof VENDOR_DOCUMENT_TYPE)[number];

export const DOC_VERIFICATION_STATUS = [
  'PENDING',
  'AUTO_VERIFIED',
  'MANUALLY_VERIFIED',
  'FAILED',
  'EXPIRED',
] as const;
export type DocVerificationStatus = (typeof DOC_VERIFICATION_STATUS)[number];

export const DOC_VERIFICATION_SOURCE = [
  'AUTO_API',
  'MANUAL_REVIEW',
  'VENDOR_ATTESTATION',
] as const;
export type DocVerificationSource = (typeof DOC_VERIFICATION_SOURCE)[number];

export const SCREENING_TYPE = [
  'GSTIN_STATUS',
  'PAN_STATUS',
  'UDYAM_STATUS',
  'MCA_DIRECTORS',
  'RBI_DEFAULTER',
  'SANCTIONS_OFAC',
  'SANCTIONS_EU',
  'SANCTIONS_UK',
  'ADVERSE_MEDIA',
  'CREDIT_BUREAU',
] as const;
export type ScreeningType = (typeof SCREENING_TYPE)[number];

export const SCREENING_STATUS = [
  'PENDING',
  'CLEAR',
  'FLAGGED',
  'ERROR',
  'EXPIRED',
] as const;
export type ScreeningStatus = (typeof SCREENING_STATUS)[number];

export const SCREENING_FLAG_SEVERITY = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type ScreeningFlagSeverity = (typeof SCREENING_FLAG_SEVERITY)[number];

export const SCREENING_REVIEW_DECISION = [
  'CLEAR',
  'ACCEPT_RISK',
  'REJECT_VENDOR',
] as const;
export type ScreeningReviewDecision = (typeof SCREENING_REVIEW_DECISION)[number];

export const SANCTIONS_SCREENING_STATUS = [
  'NOT_LISTED',
  'POTENTIAL_MATCH',
  'CONFIRMED_MATCH',
  'CLEARED',
] as const;
export type SanctionsScreeningStatus = (typeof SANCTIONS_SCREENING_STATUS)[number];

export const OWNERSHIP_TYPE = ['DIRECT', 'INDIRECT', 'CONTROL_VIA_AGREEMENT'] as const;
export type OwnershipType = (typeof OWNERSHIP_TYPE)[number];

export const SUSPENSION_TYPE = ['TEMPORARY', 'INDEFINITE', 'BLACKLIST'] as const;
export type SuspensionType = (typeof SUSPENSION_TYPE)[number];

export const SUSPENSION_REASON_CODE = [
  'DOC_EXPIRED',
  'QUALITY_ISSUE',
  'PAYMENT_DISPUTE',
  'COMPLIANCE_BREACH',
  'SANCTIONS_HIT',
  'REQUESTED_BY_VENDOR',
  'OTHER',
] as const;
export type SuspensionReasonCode = (typeof SUSPENSION_REASON_CODE)[number];

export const CHANGE_REQUEST_TYPE = [
  'BANK_CHANGE',
  'GSTIN_CHANGE',
  'OWNERSHIP_CHANGE',
  'CATEGORY_ADD',
  'CONTACT_UPDATE',
] as const;
export type ChangeRequestType = (typeof CHANGE_REQUEST_TYPE)[number];

export const CHANGE_REQUEST_STATUS = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'AUTO_APPROVED',
] as const;
export type ChangeRequestStatus = (typeof CHANGE_REQUEST_STATUS)[number];

export const SCORECARD_PERIOD = ['ROLLING_90D', 'ROLLING_365D', 'ALL_TIME'] as const;
export type ScorecardPeriod = (typeof SCORECARD_PERIOD)[number];

export const NAME_MATCH_ALGORITHM = ['JARO_WINKLER', 'LEVENSHTEIN', 'HYBRID'] as const;
export type NameMatchAlgorithm = (typeof NAME_MATCH_ALGORITHM)[number];
