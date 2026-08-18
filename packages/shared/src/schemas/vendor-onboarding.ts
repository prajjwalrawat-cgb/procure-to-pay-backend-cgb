import { z } from 'zod';

import { GST_STATES } from '../constants/gst-states';
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

/* Every user-facing field carries an explicit message. Zod's stock text ("Invalid
 * email", "String must contain exactly 2 character(s)") reaches the vendor verbatim
 * via problem+json `context.issues`, so it has to read as instructions, not as a
 * type error. The two most-confused fields say what the *right* value looks like:
 * PAN is routinely filled with the 15-char GSTIN, and stateCode with "DEL"/"MH"
 * instead of the 2-digit GST state code the tax engine keys off. */
const EMAIL_MESSAGE = 'Enter a valid email address, e.g. name@company.com';
const PAN_MESSAGE =
  'PAN must be 10 characters: 5 letters, 4 digits, 1 letter (e.g. AFMFS3755D). If you have a 15-character GSTIN, the PAN is characters 3–12 of it';
const GSTIN_MESSAGE =
  'GSTIN must be 15 characters: 2-digit state code, 10-character PAN, then 3 more (e.g. 07AFMFS3755D1ZS)';
const STATE_CODE_MESSAGE =
  'Select your state — this must be the 2-digit GST state code (e.g. 07 for Delhi), not the state name';

/* Checked against the real code list, not just `length(2)`: a well-formed but
 * wrong code ("AB", or a digit typo) passes a length check and then silently
 * picks the wrong GST heads downstream in determineTaxKind. Retired codes stay
 * valid so re-saving a legacy vendor record doesn't fail. */
const GST_STATE_CODES = new Set(GST_STATES.map((s) => s.code));
const IFSC_MESSAGE = 'IFSC must be exactly 11 characters, e.g. HDFC0001234';

// ── Buyer: invite ────────────────────────────────────────────────────────────

export const InviteVendorInputSchema = z.object({
  legalEntityName: z
    .string()
    .min(2, 'Enter the vendor’s registered legal entity name (at least 2 characters)')
    .max(200, 'Legal entity name cannot exceed 200 characters'),
  email: z.string().trim().toLowerCase().email(EMAIL_MESSAGE),
  name: z
    .string()
    .min(2, 'Display name must be at least 2 characters')
    .max(200, 'Display name cannot exceed 200 characters'),
  categoryKey: z.string().min(1, 'Select a category'),
  source: z.enum(ONBOARDING_INVITATION_SOURCE).default('BUYER_INVITE_SPOT'),
  rfqId: z.string().nullish(),
  /** Set after the officer has seen a "looks like an existing vendor" warning and
   *  confirmed it really is a different entity. Only overrides the fuzzy
   *  legal-name match — an email already in use is never overridable, because
   *  both vendor records would share one login (see assertNoDuplicateInvite). */
  allowDuplicate: z.boolean().default(false),
});
export type InviteVendorInput = z.infer<typeof InviteVendorInputSchema>;

/** Why an in-flight invitation is being withdrawn. Kept on the onboarding as
 *  review notes and in the audit log — invitations are never hard-deleted. */
export const CancelOnboardingInputSchema = z.object({
  reason: z
    .string()
    .min(3, 'Give a reason (at least 3 characters) — it is recorded in the audit log')
    .max(500, 'Reason cannot exceed 500 characters'),
});
export type CancelOnboardingInput = z.infer<typeof CancelOnboardingInputSchema>;

/**
 * Buyer-side correction of a vendor's name. Both fields are optional so the
 * caller can fix one without restating the other, but at least one must be
 * present — an empty PATCH is a mistake, not a no-op worth a 200.
 *
 * `legalEntityName` is only accepted while the vendor is still onboarding: once
 * activated it is the name PAN/GST verification matched against, and changing it
 * is a material change that belongs in the change-request approval path.
 */
export const RenameVendorInputSchema = z
  .object({
    name: z
      .string()
      .min(2, 'Display name must be at least 2 characters')
      .max(200, 'Display name cannot exceed 200 characters')
      .optional(),
    legalEntityName: z
      .string()
      .min(2, 'Legal entity name must be at least 2 characters')
      .max(200, 'Legal entity name cannot exceed 200 characters')
      .optional(),
    reason: z.string().max(500, 'Reason cannot exceed 500 characters').nullish(),
  })
  .refine((v) => v.name != null || v.legalEntityName != null, {
    message: 'Give a new display name or legal entity name',
    path: ['name'],
  });
export type RenameVendorInput = z.infer<typeof RenameVendorInputSchema>;

// ── Public self-registration ─────────────────────────────────────────────────

export const SelfRegistrationInputSchema = z.object({
  /** Which tenant this vendor is registering with — carried by the buyer-issued
   *  registration link. Required so a public signup can never land in an
   *  arbitrary/defaulted tenant (audit: multi-tenancy self-registration gap). */
  tenantId: z.string().uuid('This registration link is invalid or incomplete'),
  legalEntityName: z
    .string()
    .min(2, 'Enter your registered legal entity name (at least 2 characters)')
    .max(200, 'Legal entity name cannot exceed 200 characters'),
  email: z.string().trim().toLowerCase().email(EMAIL_MESSAGE),
  phone: z
    .string()
    .min(6, 'Enter a valid phone number (at least 6 digits)')
    .max(20, 'Phone number cannot exceed 20 characters'),
  categoryKey: z.string().min(1, 'Select a category'),
  captchaResponse: z.string().min(1, 'Please complete the captcha'),
});
export type SelfRegistrationInput = z.infer<typeof SelfRegistrationInputSchema>;

export const VerifyEmailInputSchema = z.object({ token: z.string().min(10) });
export type VerifyEmailInput = z.infer<typeof VerifyEmailInputSchema>;

/** Buyer-invited vendor sets their own password from the emailed magic link.
 *  `tenantId` is carried by the link (like self-registration) so the public,
 *  JWT-less endpoint can open the correct tenant context; `token` is the secret
 *  gate (the onboarding's selfRegistrationToken). */
export const AcceptInviteInputSchema = z.object({
  token: z.string().min(10, 'This invitation link is invalid or incomplete'),
  tenantId: z.string().uuid('This invitation link is invalid or incomplete'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(200, 'Password cannot exceed 200 characters'),
});
export type AcceptInviteInput = z.infer<typeof AcceptInviteInputSchema>;

// ── Wizard steps (each step has its own schema; the UI uses these directly) ────

export const OnboardingStep1Schema = z.object({
  legalEntityType: z.enum(LEGAL_ENTITY_TYPE),
  legalEntityName: z
    .string()
    .min(2, 'Enter your registered legal entity name (at least 2 characters)')
    .max(200, 'Legal entity name cannot exceed 200 characters'),
  dateOfIncorporation: z.string().datetime().nullish(),
  businessPan: z.string().regex(panRegex, PAN_MESSAGE),
  addressLine1: z
    .string()
    .min(2, 'Enter your registered address')
    .max(200, 'Address cannot exceed 200 characters'),
  city: z.string().min(1, 'Enter your city').max(80, 'City cannot exceed 80 characters'),
  stateCode: z
    .string()
    .refine((v) => GST_STATE_CODES.has(v), { message: STATE_CODE_MESSAGE }),
  pincode: z
    .string()
    .min(6, 'Pincode must be at least 6 digits')
    .max(10, 'Pincode cannot exceed 10 characters'),
  primaryContactName: z
    .string()
    .min(2, 'Enter the primary contact’s name')
    .max(120, 'Contact name cannot exceed 120 characters'),
  primaryContactEmail: z.string().email(EMAIL_MESSAGE),
  primaryContactPhone: z
    .string()
    .min(6, 'Enter a valid phone number (at least 6 digits)')
    .max(20, 'Phone number cannot exceed 20 characters'),
});
export type OnboardingStep1 = z.infer<typeof OnboardingStep1Schema>;

export const OnboardingStep2Schema = z.object({
  gstin: z.string().regex(gstinRegex, GSTIN_MESSAGE),
  isMsme: z.boolean().default(false),
  udyamNumber: z.string().max(40, 'Udyam number cannot exceed 40 characters').nullish(),
});
export type OnboardingStep2 = z.infer<typeof OnboardingStep2Schema>;

export const OnboardingStep3Schema = z.object({
  bankName: z
    .string()
    .min(2, 'Enter your bank’s name')
    .max(120, 'Bank name cannot exceed 120 characters'),
  accountNumber: z
    .string()
    .min(6, 'Account number must be at least 6 characters')
    .max(30, 'Account number cannot exceed 30 characters'),
  ifsc: z.string().min(11, IFSC_MESSAGE).max(11, IFSC_MESSAGE),
  holderName: z
    .string()
    .min(2, 'Enter the account holder’s name exactly as it appears at the bank')
    .max(200, 'Account holder name cannot exceed 200 characters'),
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
  categoryTags: z.array(z.string()).min(1, 'Add at least one category'),
  capabilityTags: z.array(z.string()).default([]),
  facilities: z.array(z.string()).default([]),
  employeeCountBracket: z.enum(EMPLOYEE_COUNT_BRACKET),
  annualTurnoverDeclared: decimalString.nullish(),
  references: z
    .array(
      z.object({
        name: z
          .string()
          .min(1, 'Enter the reference’s name')
          .max(120, 'Reference name cannot exceed 120 characters'),
        contact: z.string().max(120, 'Contact cannot exceed 120 characters').nullish(),
        productSupplied: z
          .string()
          .max(200, 'Product supplied cannot exceed 200 characters')
          .nullish(),
      }),
    )
    .max(3, 'You can add at most 3 references')
    .default([]),
});
export type OnboardingStep5 = z.infer<typeof OnboardingStep5Schema>;

export const BeneficialOwnerInputSchema = z.object({
  ownerName: z
    .string()
    .min(2, 'Enter the owner’s full name')
    .max(120, 'Owner name cannot exceed 120 characters'),
  ownerPan: z.string().regex(panRegex, PAN_MESSAGE),
  ownerDob: z.string().datetime().nullish(),
  ownershipPct: z
    .number()
    .min(0, 'Ownership must be between 0 and 100%')
    .max(100, 'Ownership must be between 0 and 100%'),
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
