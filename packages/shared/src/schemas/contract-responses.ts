/**
 * Contract read models (Slice 9). Pure TS interfaces — money as string, all
 * timestamps ISO strings. These are the return types the controllers annotate.
 */
import type {
  CommitmentPeriod,
  ContractAmendmentStatus,
  ContractClauseType,
  ContractDocType,
  ContractRenewalAlertType,
  ContractStatus,
  ContractType,
  RenewalAlertAction,
  VolumeTrackingStatus,
} from '../constants/contract-status';
import type { EscalationClause } from './contracts';
import type { LiveApprovalStep } from './approvals';
import type { PaymentTerms } from './purchase-order';

export interface ContractRateCardView {
  id: string;
  lineNo: number;
  itemId: string | null;
  itemDesc: string;
  uom: string;
  rateYear: number;
  unitRate: string;
  taxRate: string;
  volumeBandMin: string | null;
  volumeBandMax: string | null;
  routeOrigin: string | null;
  routeDest: string | null;
  effectiveFrom: string;
  effectiveTo: string;
}

export interface ContractClauseView {
  id: string;
  clauseType: ContractClauseType;
  title: string;
  contentText: string;
  isFromLibrary: boolean;
  libraryClauseId: string | null;
  orderNo: number;
  isMandatory: boolean;
}

export interface ContractDocumentView {
  id: string;
  docType: ContractDocType;
  filename: string;
  url: string;
  uploadedAt: string;
}

export interface ContractCallOffView {
  id: string;
  poId: string;
  poNumber: string;
  poStatus: string;
  qty: string;
  value: string;
  calledOffAt: string;
}

export interface ContractAmendmentView {
  id: string;
  amendmentNo: number;
  status: ContractAmendmentStatus;
  changeSummary: string;
  changeValue: string;
  requestedBy: string | null;
  requestedAt: string;
  approvedAt: string | null;
  effectiveFrom: string;
}

export interface ContractRenewalAlertView {
  id: string;
  alertType: ContractRenewalAlertType;
  triggeredAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  actionTaken: RenewalAlertAction | null;
}

export interface VolumeTrackingView {
  period: string;
  commitmentPeriod: CommitmentPeriod;
  committedQty: string | null;
  actualQty: string;
  committedValue: string | null;
  actualValue: string;
  commitmentUom: string | null;
  /** actual / committed, 0..1+ (null when no commitment set). */
  pctOfCommitment: number | null;
  /** run-rate extrapolation of year-end actual as a fraction of committed. */
  projectedPctOfCommitment: number | null;
  shortfallValue: string | null;
  status: VolumeTrackingStatus;
}

export interface ContractListItem {
  id: string;
  number: string;
  title: string;
  vendor: { id: string; name: string };
  contractType: ContractType;
  category: string;
  status: ContractStatus;
  totalValueEstimate: string;
  currency: string;
  validityStart: string;
  validityEnd: string;
  daysToExpiry: number;
}

export interface ContractListResponse {
  items: ContractListItem[];
  nextCursor: string | null;
  totalEstimate: number;
  counts: {
    active: number;
    draft: number;
    awaiting_approval: number;
    expiring_soon: number;
    expired: number;
    terminated: number;
  };
}

export interface ContractDetailResponse {
  id: string;
  number: string;
  title: string;
  contractType: ContractType;
  category: string;
  status: ContractStatus;
  vendor: { id: string; name: string; code: string; gstin: string | null };
  rfqId: string | null;
  currency: string;
  totalValueEstimate: string;
  validityStart: string;
  validityEnd: string;
  daysToExpiry: number;
  autoRenew: boolean;
  renewalNoticeDays: number;
  terminationNoticeDays: number;
  commitmentPeriod: CommitmentPeriod;
  minimumCommitmentValue: string | null;
  minimumCommitmentQty: string | null;
  commitmentUom: string | null;
  paymentTerms: PaymentTerms | null;
  escalationClause: EscalationClause | null;
  governingLaw: string | null;
  disputeResolution: string | null;
  requireVendorCountersign: boolean;
  skipPoApprovalWithinContract: boolean;
  maxCallOffValue: string | null;
  amendmentNo: number;
  parentContractId: string | null;
  supersedesContractId: string | null;
  supersededByContractId: string | null;
  executedAt: string | null;
  vendorSignedAt: string | null;
  terminatedAt: string | null;
  terminationReason: string | null;
  pdfAvailable: boolean;
  stages: { key: string; label: string; state: 'done' | 'active' | 'todo' }[];
  rateCards: ContractRateCardView[];
  rateYears: number[];
  clauses: ContractClauseView[];
  documents: ContractDocumentView[];
  callOffs: ContractCallOffView[];
  amendments: ContractAmendmentView[];
  renewalAlerts: ContractRenewalAlertView[];
  volumeTracking: VolumeTrackingView | null;
  liveApprovalChain: LiveApprovalStep[];
  myApprovalId: string | null;
  activity: { id: string; action: string; actorId: string | null; at: string }[];
  canEdit: boolean;
  canSubmit: boolean;
  canDecide: boolean;
  canExecute: boolean;
  canAmend: boolean;
  canRenew: boolean;
  canTerminate: boolean;
  canCallOff: boolean;
}

export interface ClauseLibraryItem {
  id: string;
  clauseType: ContractClauseType;
  title: string;
  contentText: string;
  isDefault: boolean;
  version: number;
  createdAt: string;
}

export interface RenewalCalendarEntry {
  contractId: string;
  number: string;
  title: string;
  vendorName: string;
  totalValueEstimate: string;
  currency: string;
  validityEnd: string;
  daysToExpiry: number;
  bucket: '90d' | '60d' | '30d' | 'expired';
  alert: ContractRenewalAlertView | null;
}

export interface RenewalCalendarResponse {
  entries: RenewalCalendarEntry[];
}

export interface EscalationProposalResponse {
  contractId: string;
  indexValue: string;
  baseIndexValue: string | null;
  capPct: string | null;
  proposals: {
    rateCardId: string;
    itemDesc: string;
    currentRate: string;
    proposedRate: string;
    upliftPct: string;
    capped: boolean;
  }[];
  amendmentId: string | null;
}

// ── Vendor-portal read models ────────────────────────────────────────────────

export interface VendorContractListItem {
  id: string;
  number: string;
  title: string;
  contractType: ContractType;
  status: ContractStatus;
  validityStart: string;
  validityEnd: string;
  requiresCountersign: boolean;
}

export interface VendorContractDetailResponse {
  id: string;
  number: string;
  title: string;
  contractType: ContractType;
  status: ContractStatus;
  validityStart: string;
  validityEnd: string;
  currency: string;
  paymentTerms: PaymentTerms | null;
  requiresCountersign: boolean;
  rateCards: ContractRateCardView[];
  clauses: ContractClauseView[];
  callOffs: ContractCallOffView[];
  documents: ContractDocumentView[];
  pdfAvailable: boolean;
}
