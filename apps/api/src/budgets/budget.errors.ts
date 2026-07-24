import { DomainError } from '../common/errors/domain-error';

/** Raised when a requisition exceeds the remaining budget for its cost center. */
export class BudgetBreachError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/budget-breach';
  readonly title = 'Budget exceeded';
}

/** No active budget covers the cost center for the requested period. */
export class BudgetMissingError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/budget-missing';
  readonly title = 'No active budget';
}

/** A PO would transfer more than the PR commitment's remaining amount. */
export class BudgetTransferOverError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/budget-transfer-over';
  readonly title = 'Budget transfer exceeds commitment';
}

/** A non-INR amount was supplied against an INR-only cost center (v1). */
export class CurrencyMismatchError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/currency-mismatch';
  readonly title = 'Currency mismatch';
}
