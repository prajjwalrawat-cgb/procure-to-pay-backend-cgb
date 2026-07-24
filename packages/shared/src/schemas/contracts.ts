import { z } from 'zod';

import {
  COMMITMENT_PERIOD,
  CONTRACT_CLAUSE_TYPE,
  CONTRACT_TYPE,
  ESCALATION_TYPE,
  RENEWAL_ALERT_ACTION,
} from '../constants/contract-status';
import { DeliveryAddressSchema, PaymentTermsSchema } from './purchase-order';

const positiveDecimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal string');

export const ESCALATION_REVIEW_FREQUENCY = [
  'MONTHLY',
  'QUARTERLY',
  'SEMI_ANNUAL',
  'ANNUAL',
] as const;
export type EscalationReviewFrequency = (typeof ESCALATION_REVIEW_FREQUENCY)[number];

// ── Nested config ────────────────────────────────────────────────────────────

export const EscalationClauseSchema = z.object({
  type: z.enum(ESCALATION_TYPE),
  indexRef: z.string().max(80).nullish(), // e.g. 'HPCL_DIESEL_KOLKATA'
  baseIndexValue: positiveDecimal.nullish(),
  reviewFrequency: z.enum(ESCALATION_REVIEW_FREQUENCY),
  capPct: positiveDecimal.nullish(),
});
export type EscalationClause = z.infer<typeof EscalationClauseSchema>;

export const RateCardInputSchema = z.object({
  itemId: z.string().nullish(),
  itemDesc: z.string().min(1).max(500),
  uom: z.string().min(1).max(20),
  rateYear: z.number().int().min(1).max(10).default(1),
  unitRate: positiveDecimal,
  taxRate: positiveDecimal.default('0'),
  volumeBandMin: positiveDecimal.nullish(),
  volumeBandMax: positiveDecimal.nullish(),
  routeOrigin: z.string().max(120).nullish(),
  routeDest: z.string().max(120).nullish(),
  effectiveFrom: z.string().datetime(),
  effectiveTo: z.string().datetime(),
});
export type RateCardInput = z.infer<typeof RateCardInputSchema>;

export const ClauseInputSchema = z.object({
  clauseType: z.enum(CONTRACT_CLAUSE_TYPE),
  title: z.string().min(1).max(200),
  contentText: z.string().min(1).max(20000),
  isFromLibrary: z.boolean().default(false),
  libraryClauseId: z.string().nullish(),
  orderNo: z.number().int().min(0).default(0),
  isMandatory: z.boolean().default(false),
});
export type ClauseInput = z.infer<typeof ClauseInputSchema>;

// ── Contract create / update ─────────────────────────────────────────────────

export const ContractCreateInputSchema = z.object({
  title: z.string().min(3).max(200),
  contractType: z.enum(CONTRACT_TYPE),
  vendorId: z.string().min(1),
  category: z.string().min(1).max(120),
  rfqId: z.string().nullish(),
  validityStart: z.string().datetime(),
  validityEnd: z.string().datetime(),
  autoRenew: z.boolean().default(false),
  renewalNoticeDays: z.number().int().min(0).max(365).default(90),
  currency: z.literal('INR').default('INR'),
  totalValueEstimate: positiveDecimal.default('0'),
  minimumCommitmentValue: positiveDecimal.nullish(),
  minimumCommitmentQty: positiveDecimal.nullish(),
  commitmentUom: z.string().max(20).nullish(),
  commitmentPeriod: z.enum(COMMITMENT_PERIOD).default('ANNUAL'),
  paymentTerms: PaymentTermsSchema,
  escalationClause: EscalationClauseSchema.nullish(),
  terminationNoticeDays: z.number().int().min(0).max(365).default(30),
  governingLaw: z.string().max(200).nullish(),
  disputeResolution: z.string().max(500).nullish(),
  requireVendorCountersign: z.boolean().default(false),
  skipPoApprovalWithinContract: z.boolean().default(true),
  maxCallOffValue: positiveDecimal.nullish(),
  parentContractId: z.string().nullish(),
  rateCards: z.array(RateCardInputSchema).default([]),
  clauses: z.array(ClauseInputSchema).default([]),
});
export type ContractCreateInput = z.infer<typeof ContractCreateInputSchema>;

export const ContractUpdateInputSchema = ContractCreateInputSchema.partial().omit({
  parentContractId: true,
});
export type ContractUpdateInput = z.infer<typeof ContractUpdateInputSchema>;

// ── Lifecycle actions ────────────────────────────────────────────────────────

export const ContractDecisionInputSchema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(['APPROVE', 'REJECT', 'REQUEST_CHANGES']),
  comment: z.string().max(2000).nullish(),
});
export type ContractDecisionInput = z.infer<typeof ContractDecisionInputSchema>;

export const AmendmentInputSchema = z.object({
  changeSummary: z.string().min(3).max(1000),
  effectiveFrom: z.string().datetime(),
  changeValue: positiveDecimal.default('0'),
  /** Rate-card rows to replace (matched by id) with a new unit rate. */
  rateChanges: z
    .array(z.object({ rateCardId: z.string().min(1), newUnitRate: positiveDecimal }))
    .default([]),
  /** Free-form field changes recorded for the amendment audit trail. */
  fieldChanges: z.record(z.string(), z.unknown()).default({}),
});
export type AmendmentInput = z.infer<typeof AmendmentInputSchema>;

export const TerminateInputSchema = z.object({
  reason: z.string().min(3).max(1000),
  effectiveDate: z.string().datetime(),
});
export type TerminateInput = z.infer<typeof TerminateInputSchema>;

export const RenewInputSchema = z.object({
  validityStart: z.string().datetime().nullish(),
  validityEnd: z.string().datetime().nullish(),
});
export type RenewInput = z.infer<typeof RenewInputSchema>;

export const CallOffInputSchema = z.object({
  deliveryLocation: DeliveryAddressSchema,
  expectedDeliveryDate: z.string().datetime(),
  lines: z
    .array(
      z.object({
        contractRateCardId: z.string().min(1),
        qty: positiveDecimal.refine((v) => Number(v) > 0, 'qty must be > 0'),
      }),
    )
    .min(1),
});
export type CallOffInput = z.infer<typeof CallOffInputSchema>;

export const ClauseLibraryInputSchema = z.object({
  clauseType: z.enum(CONTRACT_CLAUSE_TYPE),
  title: z.string().min(1).max(200),
  contentText: z.string().min(1).max(20000),
  isDefault: z.boolean().default(false),
});
export type ClauseLibraryInput = z.infer<typeof ClauseLibraryInputSchema>;

export const AddClauseInputSchema = ClauseInputSchema;
export type AddClauseInput = ClauseInput;

export const AcknowledgeAlertInputSchema = z.object({
  actionTaken: z.enum(RENEWAL_ALERT_ACTION),
});
export type AcknowledgeAlertInput = z.infer<typeof AcknowledgeAlertInputSchema>;

/** TENANT_ADMIN enters a fresh index value → EscalationService proposes rates. */
export const ApplyIndexInputSchema = z.object({
  indexValue: positiveDecimal.refine((v) => Number(v) > 0, 'index value must be > 0'),
});
export type ApplyIndexInput = z.infer<typeof ApplyIndexInputSchema>;

export const CountersignInputSchema = z.object({
  s3Key: z.string().min(1),
  filename: z.string().min(1).max(300),
});
export type CountersignInput = z.infer<typeof CountersignInputSchema>;

// ── List query ───────────────────────────────────────────────────────────────

export const CONTRACT_TABS = [
  'active',
  'draft',
  'awaiting_approval',
  'expiring_soon',
  'expired',
  'terminated',
] as const;
export type ContractTab = (typeof CONTRACT_TABS)[number];

export const ContractListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().nullish(),
  status: z.string().nullish(),
  vendorId: z.string().nullish(),
  category: z.string().nullish(),
  contractType: z.enum(CONTRACT_TYPE).nullish(),
  expiringWithinDays: z.coerce.number().int().min(1).max(365).nullish(),
  tab: z.enum(CONTRACT_TABS).default('active'),
});
export type ContractListQuery = z.infer<typeof ContractListQuerySchema>;
