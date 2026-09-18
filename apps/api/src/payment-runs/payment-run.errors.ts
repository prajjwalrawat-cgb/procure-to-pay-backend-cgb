import { DomainError } from '../common/errors/domain-error';

/** The run/item is not in a state that allows this action. */
export class PaymentRunStateError extends DomainError {
  readonly status = 409;
  readonly type = 'https://procureflow.io/errors/payment-run-state';
  readonly title = 'Invalid payment-run state';
}

/** An invoice can't be added (wrong status, unverified bank, or duplicate). */
export class PaymentItemInvalidError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/payment-item-invalid';
  readonly title = 'Invoice cannot be added to this run';
}

/** A payment can't be recorded against the invoice (state, amount, or duplicate). */
export class PaymentRecordInvalidError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/payment-record-invalid';
  readonly title = 'Payment cannot be recorded';
}

/** Submission blocked because items changed after approval, or a hash mismatch. */
export class PaymentRunSubmissionBlockedError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/payment-run-submission-blocked';
  readonly title = 'Payment run submission blocked';
}
