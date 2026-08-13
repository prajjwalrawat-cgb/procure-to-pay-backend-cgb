import type { DocumentType } from '@procureflow/shared';

/**
 * Where a routed document lives in the buyer console.
 *
 * One mapping, used by both the approvals inbox and the notifications the
 * routing engine sends. They used to carry a copy each: the inbox's covered
 * four document types and fell through to `/${type.toLowerCase()}/:id`, so a
 * vendor onboarding awaiting approval linked to `/vendor_onboarding/vob_…`
 * and 404'd — the row was in the inbox but unopenable.
 *
 * Every path here must correspond to a real page under `src/app/(web)`.
 */
const HREFS: Record<DocumentType, (id: string) => string> = {
  REQUISITION: (id) => `/requisitions/${id}`,
  PURCHASE_ORDER: (id) => `/purchase-orders/${id}`,
  GRN: (id) => `/goods-receipt/${id}`,
  INVOICE: (id) => `/invoices/${id}`,
  PAYMENT_RUN: (id) => `/payment-runs/${id}`,
  CONTRACT: (id) => `/contracts/${id}`,
  CONTRACT_AMENDMENT: (id) => `/contracts/${id}`,
  VENDOR_ONBOARDING: (id) => `/vendors/onboarding/${id}`,
  // No detail page yet for either of these (the award page is keyed by RFQ id,
  // not award id, and vendor change requests are only shown inside Vendor 360),
  // so both land on the list the reviewer can work from rather than a 404.
  RFQ_AWARD: () => `/sourcing`,
  VENDOR_CHANGE: () => `/vendors`,
};

export function documentHref(documentType: DocumentType, documentId: string): string {
  return HREFS[documentType]?.(documentId) ?? `/${documentId}`;
}
