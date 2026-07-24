import { z } from 'zod';

import {
  CHANGE_REQUEST_TYPE,
  EMPLOYEE_COUNT_BRACKET,
  LEGAL_ENTITY_TYPE,
  ONBOARDING_INVITATION_SOURCE,
  OWNERSHIP_TYPE,
  SCREENING_REVIEW_DECISION,
  SCREENING_TYPE,
  SUSPENSION_REASON_CODE,
  SUSPENSION_TYPE,
  VENDOR_DOCUMENT_TYPE,
} from '../constants/vendor-status';

const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string');
const gstinRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/;
const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

// ── Buyer: invite ────────────────────────────────────────────────────────────

export const InviteVendorInputSchema = z.object({
  legalEntityName: z.string().min(2).max(200),
  email: z.string().email(),
  name: z.string().min(2).max(200),
  categoryKey: z.string().min(1),
  source: z.enum(ONBOARDING_INVITATION_SOURCE).default('BUYER_INVITE_SPOT'),
  rfqId: z.string().nullish(),
});
export type InviteVendorInput = z.infer<typeof InviteVendorInputSchema>;

// ── Public self-registration ─────────────────────────────────────────────────

export const SelfRegistrationInputSchema = z.object({
  /** Which tenant this vendor is registering with — carried by the buyer-issued
   *  registration link. Required so a public signup can never land in an
   *  arbitrary/defaulted tenant (audit: multi-tenancy self-registration gap). */
  tenantId: z.string().uuid(),
  legalEntityName: z.string().min(2).max(200),
  email: z.string().email(),
  phone: z.string().min(6).max(20),
  categoryKey: z.string().min(1),
  captchaResponse: z.string().min(1),
});
export type SelfRegistrationInput = z.infer<typeof SelfRegistrationInputSchema>;

export const VerifyEmailInputSchema = z.object({ token: z.string().min(10) });
export type VerifyEmailInput = z.infer<typeof VerifyEmailInputSchema>;

// ── Wizard steps (each step has its own schema; the UI uses these directly) ────

export const OnboardingStep1Schema = z.object({
  legalEntityType: z.enum(LEGAL_ENTITY_TYPE),
  legalEntityName: z.string().min(2).max(200),
  dateOfIncorporation: z.string().datetime().nullish(),
  businessPan: z.string().regex(panRegex, 'invalid PAN'),
  addressLine1: z.string().min(2).max(200),
  city: z.string().min(1).max(80),
  stateCode: z.string().length(2),
  pincode: z.string().min(6).max(10),
  primaryContactName: z.string().min(2).max(120),
  primaryContactEmail: z.string().email(),
  primaryContactPhone: z.string().min(6).max(20),
});
export type OnboardingStep1 = z.infer<typeof OnboardingStep1Schema>;

export const OnboardingStep2Schema = z.object({
  gstin: z.string().regex(gstinRegex, 'invalid GSTIN'),
  isMsme: z.boolean().default(false),
  udyamNumber: z.string().max(40).nullish(),
});
export type OnboardingStep2 = z.infer<typeof OnboardingStep2Schema>;

export const OnboardingStep3Schema = z.object({
  bankName: z.string().min(2).max(120),
  accountNumber: z.string().min(6).max(30),
  ifsc: z.string().min(11).max(11),
  holderName: z.string().min(2).max(200),
});
export type OnboardingStep3 = z.infer<typeof OnboardingStep3Schema>;

export const OnboardingStep4Schema = z.object({
  certifications: z
    .array(
      z.object({
        docType: z.enum(VENDOR_DOCUMENT_TYPE),
        certificateNumber: z.string().max(80).nullish(),
        validTo: z.string().datetime().nullish(),
      }),
    )
    .default([]),
});
export type OnboardingStep4 = z.infer<typeof OnboardingStep4Schema>;

export const OnboardingStep5Schema = z.object({
  categoryTags: z.array(z.string()).min(1),
  capabilityTags: z.array(z.string()).default([]),
  facilities: z.array(z.string()).default([]),
  employeeCountBracket: z.enum(EMPLOYEE_COUNT_BRACKET),
  annualTurnoverDeclared: decimalString.nullish(),
  references: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        contact: z.string().max(120).nullish(),
        productSupplied: z.string().max(200).nullish(),
      }),
    )
    .max(3)
    .default([]),
});
export type OnboardingStep5 = z.infer<typeof OnboardingStep5Schema>;

export const BeneficialOwnerInputSchema = z.object({
  ownerName: z.string().min(2).max(120),
  ownerPan: z.string().regex(panRegex, 'invalid PAN'),
  ownerDob: z.string().datetime().nullish(),
  ownershipPct: z.number().min(0).max(100),
  ownershipType: z.enum(OWNERSHIP_TYPE).default('DIRECT'),
  countryOfResidence: z.string().default('IN'),
  isPep: z.boolean().default(false),
  pepDetails: z.string().max(500).nullish(),
});
export type BeneficialOwnerInput = z.infer<typeof BeneficialOwnerInputSchema>;

export const OnboardingStep6Schema = z.object({
  beneficialOwners: z.array(BeneficialOwnerInputSchema).default([]),
  sanctionsSelfDeclaration: z.boolean(),
  isRelatedParty: z.boolean().default(false),
  relatedPartyDisclosure: z.string().max(1000).nullish(),
});
export type OnboardingStep6 = z.infer<typeof OnboardingStep6Schema>;

/** Discriminated save-step input (the controller routes by step number). */
export const SaveStepInputSchema = z.union([
  OnboardingStep1Schema,
  OnboardingStep2Schema,
  OnboardingStep3Schema,
  OnboardingStep4Schema,
  OnboardingStep5Schema,
  OnboardingStep6Schema,
]);
export type SaveStepInput = z.infer<typeof SaveStepInputSchema>;

/**
 * Per-step schema lookup. The wizard body MUST be validated against the schema
 * for its specific step number — never the union above. Validating against the
 * union lets a step-N body silently satisfy a more permissive step-M schema
 * (e.g. a bad step-3 IFSC falls through to step-4, which parses to
 * `{ certifications: [] }`), so the handler receives a malformed object and
 * 500s instead of returning a clean validation error.
 */
export const ONBOARDING_STEP_SCHEMAS: Record<number, z.ZodTypeAny> = {
  1: OnboardingStep1Schema,
  2: OnboardingStep2Schema,
  3: OnboardingStep3Schema,
  4: OnboardingStep4Schema,
  5: OnboardingStep5Schema,
  6: OnboardingStep6Schema,
};

// ── Documents ────────────────────────────────────────────────────────────────

export const VendorDocumentUploadSchema = z.object({
  docType: z.enum(VENDOR_DOCUMENT_TYPE),
  s3Key: z.string().min(1),
  filename: z.string().min(1).max(300),
  sizeBytes: z
    .number()
    .int()
    .min(0)
    .max(10 * 1024 * 1024),
  fileHash: z.string().min(1),
  mimeType: z.string().max(120).default('application/pdf'),
  documentNumber: z.string().max(80).nullish(),
  validFrom: z.string().datetime().nullish(),
  validTo: z.string().datetime().nullish(),
});
export type VendorDocumentUpload = z.infer<typeof VendorDocumentUploadSchema>;

export const VerifyDocumentInputSchema = z.object({
  decision: z.enum(['VERIFIED', 'REJECTED']),
  reason: z.string().max(500).nullish(),
});
export type VerifyDocumentInput = z.infer<typeof VerifyDocumentInputSchema>;

// ── CoC + submit ─────────────────────────────────────────────────────────────

export const AcknowledgeCocInputSchema = z.object({
  name: z.string().min(2).max(120),
  designation: z.string().min(2).max(120),
  agreed: z.literal(true),
});
export type AcknowledgeCocInput = z.infer<typeof AcknowledgeCocInputSchema>;

// ── Screenings ───────────────────────────────────────────────────────────────

export const TriggerScreeningInputSchema = z.object({
  screeningType: z.enum(SCREENING_TYPE),
});
export type TriggerScreeningInput = z.infer<typeof TriggerScreeningInputSchema>;

export const ReviewScreeningInputSchema = z.object({
  decision: z.enum(SCREENING_REVIEW_DECISION),
  notes: z.string().max(2000).nullish(),
});
export type ReviewScreeningInput = z.infer<typeof ReviewScreeningInputSchema>;

// ── Review / activation ──────────────────────────────────────────────────────

export const ReturnForInfoInputSchema = z.object({
  items: z.array(z.string().min(1)).min(1),
  note: z.string().max(2000).nullish(),
});
export type ReturnForInfoInput = z.infer<typeof ReturnForInfoInputSchema>;

export const OnboardingDecisionInputSchema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(['APPROVE', 'REJECT', 'CHANGES']),
  comment: z.string().max(2000).nullish(),
});
export type OnboardingDecisionInput = z.infer<typeof OnboardingDecisionInputSchema>;

// ── Suspend / blacklist ──────────────────────────────────────────────────────

export const SuspendVendorInputSchema = z.object({
  suspensionType: z.enum(SUSPENSION_TYPE).default('TEMPORARY'),
  reasonCode: z.enum(SUSPENSION_REASON_CODE),
  reasonNotes: z.string().min(1).max(2000),
  effectiveFrom: z.string().datetime().nullish(),
  effectiveUntil: z.string().datetime().nullish(),
  liftConditions: z.string().max(1000).nullish(),
});
export type SuspendVendorInput = z.infer<typeof SuspendVendorInputSchema>;

export const LiftSuspensionInputSchema = z.object({
  liftReason: z.string().min(1).max(1000),
});
export type LiftSuspensionInput = z.infer<typeof LiftSuspensionInputSchema>;

export const BlacklistVendorInputSchema = z.object({
  reasonNotes: z.string().min(1).max(2000),
  cosignerId: z.string().nullish(),
});
export type BlacklistVendorInput = z.infer<typeof BlacklistVendorInputSchema>;

// ── Change requests ──────────────────────────────────────────────────────────

export const VendorChangeRequestInputSchema = z.object({
  requestType: z.enum(CHANGE_REQUEST_TYPE),
  proposedChanges: z.record(z.unknown()),
});
export type VendorChangeRequestInput = z.infer<typeof VendorChangeRequestInputSchema>;

export const ChangeRequestDecisionInputSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  notes: z.string().max(2000).nullish(),
});
export type ChangeRequestDecisionInput = z.infer<typeof ChangeRequestDecisionInputSchema>;

// ── List queries ─────────────────────────────────────────────────────────────

export const VendorListQuerySchema = z.object({
  tab: z
    .enum(['active', 'onboarding', 'suspended', 'blacklisted', 'archived', 'all'])
    .default('active'),
  category: z.string().nullish(),
  riskGrade: z.string().nullish(),
  msme: z.coerce.boolean().nullish(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().nullish(),
});
export type VendorListQuery = z.infer<typeof VendorListQuerySchema>;

export const OnboardingListQuerySchema = z.object({
  tab: z.enum(['all', 'in_progress', 'my_review', 'approved', 'rejected']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type OnboardingListQuery = z.infer<typeof OnboardingListQuerySchema>;

export const ScorecardQuerySchema = z.object({
  period: z.enum(['ROLLING_90D', 'ROLLING_365D', 'ALL_TIME']).default('ROLLING_90D'),
  category: z.string().nullish(),
});
export type ScorecardQuery = z.infer<typeof ScorecardQuerySchema>;
