/**
 * Contract enums (Slice 9) — mirrored from the Prisma schema. `as const` arrays
 * so they drive both Zod (`z.enum`) and TS types. Kept in sync with
 * `packages/db/prisma/schema.prisma`.
 */

export const CONTRACT_TYPE = [
  'RATE_CONTRACT',
  'FRAMEWORK_AGREEMENT',
  'BLANKET_PO',
  'SERVICE_AGREEMENT',
] as const;
export type ContractType = (typeof CONTRACT_TYPE)[number];

export const CONTRACT_STATUS = [
  'DRAFT',
  'UNDER_NEGOTIATION',
  'AWAITING_APPROVAL',
  'APPROVED',
  'ACTIVE',
  'AWAITING_VENDOR_SIGNATURE',
  'EXPIRING_SOON',
  'EXPIRED',
  'TERMINATED',
  'SUPERSEDED',
] as const;
export type ContractStatus = (typeof CONTRACT_STATUS)[number];

export const COMMITMENT_PERIOD = ['ANNUAL', 'CONTRACT_LIFETIME'] as const;
export type CommitmentPeriod = (typeof COMMITMENT_PERIOD)[number];

export const CONTRACT_CLAUSE_TYPE = [
  'PAYMENT_TERMS',
  'DELIVERY_SLA',
  'QUALITY_STANDARD',
  'PENALTY',
  'FORCE_MAJEURE',
  'CONFIDENTIALITY',
  'IP',
  'TERMINATION',
  'LIABILITY',
  'INSURANCE',
  'CUSTOM',
] as const;
export type ContractClauseType = (typeof CONTRACT_CLAUSE_TYPE)[number];

/**
 * Clause types a contract must carry before it can be submitted for approval
 * (Master Context §15 "Post"; Slice 9 default — configurable per tenant later).
 */
export const MANDATORY_CLAUSE_TYPES: ContractClauseType[] = [
  'PAYMENT_TERMS',
  'DELIVERY_SLA',
  'TERMINATION',
];

export const ESCALATION_TYPE = ['INDEXED', 'FIXED_STEP'] as const;
export type EscalationType = (typeof ESCALATION_TYPE)[number];

export const VOLUME_TRACKING_STATUS = ['ON_TRACK', 'AT_RISK', 'SHORTFALL'] as const;
export type VolumeTrackingStatus = (typeof VOLUME_TRACKING_STATUS)[number];

export const CONTRACT_DOC_TYPE = [
  'EXECUTED_PDF',
  'AMENDMENT',
  'VENDOR_COUNTERSIGNED',
  'SUPPORTING_ANNEXURE',
] as const;
export type ContractDocType = (typeof CONTRACT_DOC_TYPE)[number];

export const CONTRACT_RENEWAL_ALERT_TYPE = [
  'NOTICE_90D',
  'NOTICE_60D',
  'NOTICE_30D',
  'EXPIRED',
] as const;
export type ContractRenewalAlertType = (typeof CONTRACT_RENEWAL_ALERT_TYPE)[number];

export const RENEWAL_ALERT_ACTION = [
  'RENEWED',
  'ALLOWED_TO_EXPIRE',
  'TERMINATED_EARLY',
  'UNDER_NEGOTIATION',
] as const;
export type RenewalAlertAction = (typeof RENEWAL_ALERT_ACTION)[number];

export const CONTRACT_AMENDMENT_STATUS = [
  'DRAFT',
  'AWAITING_APPROVAL',
  'APPROVED',
  'REJECTED',
] as const;
export type ContractAmendmentStatus = (typeof CONTRACT_AMENDMENT_STATUS)[number];

/** Human labels for the four contract types (FE badges + PDF header). */
export const CONTRACT_TYPE_LABEL: Record<ContractType, string> = {
  RATE_CONTRACT: 'Rate contract',
  FRAMEWORK_AGREEMENT: 'Framework agreement',
  BLANKET_PO: 'Blanket PO',
  SERVICE_AGREEMENT: 'Service agreement',
};

export const CLAUSE_TYPE_LABEL: Record<ContractClauseType, string> = {
  PAYMENT_TERMS: 'Payment terms',
  DELIVERY_SLA: 'Delivery SLA',
  QUALITY_STANDARD: 'Quality standard',
  PENALTY: 'Penalty / liquidated damages',
  FORCE_MAJEURE: 'Force majeure',
  CONFIDENTIALITY: 'Confidentiality',
  IP: 'Intellectual property',
  TERMINATION: 'Termination',
  LIABILITY: 'Liability',
  INSURANCE: 'Insurance',
  CUSTOM: 'Custom',
};
