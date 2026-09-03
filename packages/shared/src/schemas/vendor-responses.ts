/**
 * Vendor lifecycle read-model response shapes (Slice 7). Money is a string
 * (§3 rule #4); timestamps are ISO strings.
 */

import type {
  ChangeRequestStatus,
  ChangeRequestType,
  DocVerificationStatus,
  OnboardingInvitationSource,
  OnboardingReviewDecision,
  SanctionsScreeningStatus,
  ScreeningStatus,
  ScreeningType,
  SuspensionType,
  VendorDocumentType,
  VendorLifecycleStatus,
  VendorRiskGrade,
} from '../constants/vendor-status';

export interface VendorListItem {
  id: string;
  code: string;
  name: string;
  legalEntityName: string | null;
  isMsme: boolean;
  category: string | null;
  lifecycleStatus: VendorLifecycleStatus;
  riskGrade: VendorRiskGrade | null;
  scorecardGrade: string | null;
  lastTransactionAt: string | null;
  fytdSpend: string;
  activePoCount: number;
}

export interface VendorListResponse {
  items: VendorListItem[];
  nextCursor: string | null;
  totalEstimate: number;
}

export interface OnboardingListItem {
  id: string;
  vendorId: string;
  vendorName: string;
  category: string | null;
  isMsme: boolean;
  invitationSource: OnboardingInvitationSource;
  completionPct: number;
  riskGrade: VendorRiskGrade | null;
  docsVerified: number;
  docsRequired: number;
  daysOpen: number;
  stalled: boolean;
  lifecycleStatus: VendorLifecycleStatus;
  slaTargetHours: number;
  slaBreachAt: string | null;
  reviewDecision: OnboardingReviewDecision | null;
  /** The vendor has set a password from the invitation link — from here on the
   *  invite is a working login, so withdrawing it needs VENDOR_SUSPEND. */
  inviteAccepted: boolean;
  /** True while *this viewer* can withdraw the invitation: nothing submitted, no
   *  decision recorded, and they hold the authority the stage requires. */
  canCancel: boolean;
}

export interface OnboardingListResponse {
  items: OnboardingListItem[];
}

export interface VendorDocumentView {
  id: string;
  docType: VendorDocumentType;
  filename: string;
  documentNumber: string | null;
  verificationStatus: DocVerificationStatus;
  validTo: string | null;
  uploadedAt: string;
  /** Time-limited presigned URL so a reviewer can open the file. Empty string
   *  when the object is missing or the presigner fails — render no link then. */
  url: string;
  sizeBytes: number;
}

export interface VendorScreeningView {
  id: string;
  screeningType: ScreeningType;
  provider: string;
  status: ScreeningStatus;
  flagSeverity: string | null;
  findings: Record<string, unknown> | null;
  completedAt: string | null;
  nextDueAt: string | null;
}

export interface BeneficialOwnerView {
  id: string;
  ownerName: string;
  ownerPan: string;
  ownershipPct: string;
  isPep: boolean;
  sanctionsScreeningStatus: SanctionsScreeningStatus;
}

export interface WizardStepSummary {
  step: number;
  name: string;
  done: boolean;
  completionPct: number;
  data: Record<string, unknown> | null;
}

export interface RiskTrafficLight {
  key: 'statutory' | 'financial' | 'compliance' | 'sanctions' | 'operational';
  label: string;
  state: 'green' | 'amber' | 'red';
}

/** One step of the onboarding's approval chain, as shown in the decision panel. */
export interface OnboardingApprovalStep {
  stepNo: number;
  name: string;
  role: string;
  approverName: string | null;
  decision: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED' | 'DELEGATED';
  decidedAt: string | null;
  comment: string | null;
  isCurrent: boolean;
}

export interface OnboardingDetailResponse {
  id: string;
  vendorId: string;
  vendorName: string;
  legalEntityName: string | null;
  category: string | null;
  isMsme: boolean;
  lifecycleStatus: VendorLifecycleStatus;
  invitationSource: OnboardingInvitationSource;
  completionPct: number;
  daysOpen: number;
  slaTargetHours: number;
  slaBreachAt: string | null;
  startedAt: string;
  submittedAt: string | null;
  steps: WizardStepSummary[];
  documents: VendorDocumentView[];
  screenings: VendorScreeningView[];
  beneficialOwners: BeneficialOwnerView[];
  riskLights: RiskTrafficLight[];
  canReview: boolean;
  myApprovalId: string | null;
  /** The outcome once the chain reaches a terminal decision — null while the
   *  onboarding is still in flight. `canReview: false` on its own says nothing
   *  about *why*, so without this the panel read "waiting on another approver"
   *  to everyone looking at an onboarding that had already been approved. */
  reviewDecision: OnboardingReviewDecision | null;
  decisionAt: string | null;
  /** The live approval chain — who decided what, and who it now sits with. */
  approvalChain: OnboardingApprovalStep[];
  returnForInfoItems: string[];
  /** The account the vendor will be paid into, with the outcome of the
   *  penny-drop name match. Shown at review because money moves against this and
   *  a failed match used to be stored where nobody saw it. */
  bank: OnboardingBankView | null;
}

export interface VendorScorecardView {
  categoryKey: string | null;
  period: string;
  score: number | null;
  grade: string;
  insufficientData: boolean;
  transactionCount: number;
  spendAmount: string;
  metrics: {
    otifPct: number | null;
    qualityPct: number | null;
    responseTimeAvgHrs: number | null;
    disputeRatePct: number | null;
    paymentCycleDays: number | null;
    rfqParticipationPct: number | null;
    winRatePct: number | null;
  };
}

export interface Vendor360Response {
  id: string;
  code: string;
  name: string;
  legalEntityName: string | null;
  legalEntityType: string | null;
  isMsme: boolean;
  msmeCategory: string | null;
  lifecycleStatus: VendorLifecycleStatus;
  riskGrade: VendorRiskGrade | null;
  riskScore: string | null;
  gstin: string | null;
  pan: string | null;
  category: string | null;
  categoryTags: string[];
  capabilityTags: string[];
  activatedAt: string | null;
  scorecard: VendorScorecardView;
  fytdSpend: string;
  avgPaymentCycleDays: number | null;
  primaryContact: { name: string; email: string | null; phone: string | null } | null;
  bank: {
    bankName: string;
    accountNoLast4: string;
    ifsc: string;
    verifiedAt: string | null;
  } | null;
  beneficialOwners: BeneficialOwnerView[];
  documents: VendorDocumentView[];
  suspensions: VendorSuspensionView[];
  changeRequests: VendorChangeRequestView[];
}

export interface OnboardingBankView {
  bankName: string;
  /** Only ever the last four digits — the account number is stored encrypted. */
  accountNoLast4: string;
  ifsc: string;
  /** The name the vendor declared as the account holder. */
  holderName: string;
  /** What the bank returned for that account, when a penny drop ran. */
  pennyDropNameReturned: string | null;
  /** 0..1 similarity between the two names above; null if no check has run. */
  nameMatchScore: number | null;
  isVerified: boolean;
  /** A buyer's written reason for accepting an unverified account. */
  manualOverrideReason: string | null;
}

export interface VendorSuspensionView {
  id: string;
  suspensionType: SuspensionType;
  reasonCode: string;
  reasonNotes: string;
  imposedAt: string;
  effectiveUntil: string | null;
  liftConditions: string | null;
  liftedAt: string | null;
}

export interface VendorChangeRequestView {
  id: string;
  requestType: ChangeRequestType;
  status: ChangeRequestStatus;
  proposedChanges: Record<string, unknown>;
  currentValues: Record<string, unknown>;
  requiresReverification: boolean;
  requestedAt: string;
  decidedAt: string | null;
}
