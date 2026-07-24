import { DomainError } from '../common/errors/domain-error';

/** Illegal lifecycle transition (e.g. editing a non-draft PR). */
export class RequisitionStateError extends DomainError {
  readonly status = 409;
  readonly type = 'https://procureflow.io/errors/requisition-state';
  readonly title = 'Invalid requisition state';
}

/** Submit blocked because the lines fail validation. */
export class RequisitionValidationError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/requisition-validation';
  readonly title = 'Requisition validation failed';
}

/**
 * Post-approval, pre-PO revision is not supported in Slice 4 (cancel + re-create
 * instead). In-place edit + delta approval is a Slice 4.5 conversation.
 */
export class RequisitionReviseNotAllowedError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/requisition-revise-not-allowed';
  readonly title = 'Revision not allowed';
}
