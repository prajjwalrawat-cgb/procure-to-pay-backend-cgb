import { DomainError } from '../common/errors/domain-error';

/** Illegal PO lifecycle transition. */
export class PurchaseOrderStateError extends DomainError {
  readonly status = 409;
  readonly type = 'https://procureflow.io/errors/purchase-order-state';
  readonly title = 'Invalid purchase order state';
}

/** Validation failure while creating/updating a PO (bad qty, dup PR line, …). */
export class PurchaseOrderValidationError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/purchase-order-validation';
  readonly title = 'Purchase order validation failed';
}

/**
 * An order with the same vendor and the same lines already exists (see
 * `duplicate-po.ts`). Advisory, not fatal: repeat orders are legitimate, so the
 * caller re-submits with `confirmDuplicate: true` to proceed. `context` carries
 * `duplicates` — the orders it collided with — so the UI can name them.
 */
export class DuplicatePurchaseOrderError extends DomainError {
  readonly status = 409;
  readonly type = 'https://procureflow.io/errors/purchase-order-duplicate';
  readonly title = 'Possible duplicate purchase order';
}

/** The chosen vendor is inactive, on hold, or has no verified bank. */
export class VendorNotEligibleError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/vendor-not-eligible';
  readonly title = 'Vendor not eligible';
}

/** PO amendment is stubbed in Slice 4 (create an amendment PO — Slice 5.5). */
export class NotImplementedError extends DomainError {
  readonly status = 501;
  readonly type = 'https://procureflow.io/errors/not-implemented';
  readonly title = 'Not implemented';
}
