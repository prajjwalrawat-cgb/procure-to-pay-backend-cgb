/**
 * Vendor lifecycle read-model response shapes (Slice 7). Money is a string
 * (§3 rule #4); timestamps are ISO strings.
 */

import type {
  ChangeRequestStatus,
  ChangeRequestType,
  DocVerificationStatus,
  OnboardingInvitationSource,
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
  cocAcknowledgedAt: string | null;
  canReview: boolean;
  myApprovalId: string | null;
  returnForInfoItems: string[];
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
