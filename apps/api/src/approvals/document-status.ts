import type { DocumentType } from '@procureflow/shared';

/** Generic lifecycle outcomes the approval engine drives, mapped per doc type. */
export type ApprovalOutcome = 'AWAITING' | 'APPROVED' | 'REJECTED' | 'REVERTED';

interface DocMeta {
  /** Quoted table name for row locking. */
  table: string;
  status: Record<ApprovalOutcome, string>;
}

/**
 * Maps the engine's generic outcomes onto each document type's concrete status
 * enum. Keeps `ApprovalRoutingService` document-agnostic (Slice 2 §Objective:
 * "Approval logic is generic. Written once, consumed by every document type.").
 */
const DOC_META: Partial<Record<DocumentType, DocMeta>> = {
  INVOICE: {
    table: '"Invoice"',
    status: {
      AWAITING: 'AWAITING_APPROVAL',
      APPROVED: 'APPROVED',
      REJECTED: 'REJECTED',
      REVERTED: 'MATCH_EXCEPTION',
    },
  },
  PAYMENT_RUN: {
    table: '"PaymentRun"',
    status: {
      AWAITING: 'AWAITING_APPROVAL',
      APPROVED: 'APPROVED', // PaymentRunService flips this to SUBMITTED_TO_BANK
      REJECTED: 'CANCELLED',
      REVERTED: 'DRAFT',
    },
  },
  // Slice 4 — requisitions route through the same engine. On approval, the
  // RequisitionApprovalHooks listener commits budget. REVERTED (withdraw /
  // changes-requested) drops the PR back to DRAFT so it can be revised.
  REQUISITION: {
    table: '"Requisition"',
    status: {
      AWAITING: 'AWAITING_APPROVAL',
      APPROVED: 'APPROVED',
      REJECTED: 'REJECTED',
      REVERTED: 'DRAFT',
    },
  },
  // Slice 4 — purchase orders. PurchaseOrderService issues on approval (hook).
  PURCHASE_ORDER: {
    table: '"PurchaseOrder"',
    status: {
      AWAITING: 'AWAITING_APPROVAL',
      APPROVED: 'APPROVED', // PurchaseOrderService.issue moves it to ISSUED
      REJECTED: 'CANCELLED',
      REVERTED: 'DRAFT',
    },
  },
  // Slice 6 — sourcing awards. AwardService.onApproved creates the PO(s). The
  // engine's outcomes map onto the Award status enum; RECOMMENDED persists while
  // the award is in flight (there is no distinct AWAITING award status).
  RFQ_AWARD: {
    table: '"Award"',
    status: {
      AWAITING: 'RECOMMENDED',
      APPROVED: 'APPROVED',
      REJECTED: 'REJECTED',
      REVERTED: 'RECOMMENDED',
    },
  },
  // Slice 7 — vendor onboarding. The VendorOnboarding.reviewDecision enum carries
  // the outcome; VendorOnboardingService.onOnboardingApproved activates on APPROVE.
  // The engine maps its generic outcomes onto reviewDecision (see approval-routing
  // setStatus), so the concrete strings here are the OnboardingReviewDecision enum.
  VENDOR_ONBOARDING: {
    table: '"VendorOnboarding"',
    status: {
      AWAITING: 'PENDING',
      APPROVED: 'APPROVED',
      REJECTED: 'REJECTED',
      REVERTED: 'RETURNED_FOR_INFO',
    },
  },
  // Slice 7 — material post-activation change requests. VendorChangeService.decide
  // applies the change on approval; the engine drives VendorChangeRequest.status.
  VENDOR_CHANGE: {
    table: '"VendorChangeRequest"',
    status: {
      AWAITING: 'PENDING',
      APPROVED: 'APPROVED',
      REJECTED: 'REJECTED',
      REVERTED: 'PENDING',
    },
  },
  // Slice 9 — contract execution. ContractService.onApproved runs on APPROVE; the
  // engine leaves it APPROVED and execute() generates the PDF + flips to ACTIVE.
  CONTRACT: {
    table: '"Contract"',
    status: {
      AWAITING: 'AWAITING_APPROVAL',
      APPROVED: 'APPROVED',
      REJECTED: 'DRAFT', // rejected contracts return to DRAFT for revision
      REVERTED: 'DRAFT',
    },
  },
  // Slice 9 — contract amendments. ContractService.onAmendmentApproved applies the
  // change on APPROVE; the engine drives ContractAmendment.status.
  CONTRACT_AMENDMENT: {
    table: '"ContractAmendment"',
    status: {
      AWAITING: 'AWAITING_APPROVAL',
      APPROVED: 'APPROVED',
      REJECTED: 'REJECTED',
      REVERTED: 'DRAFT',
    },
  },
};

export function docMeta(documentType: DocumentType): DocMeta {
  const meta = DOC_META[documentType];
  if (!meta) {
    throw new Error(`Approval routing is not wired for ${documentType} yet.`);
  }
  return meta;
}
