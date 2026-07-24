import { DomainError } from '../common/errors/domain-error';

/** GRN is not in a state that permits the attempted transition. */
export class GrnStateError extends DomainError {
  readonly status = 409;
  readonly type = 'https://procureflow.io/errors/grn-state';
  readonly title = 'Invalid goods-receipt state';
}

/** Receipt input failed validation (quantities, missing data, weighbridge). */
export class GrnValidationError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/grn-validation';
  readonly title = 'Goods-receipt validation failed';
}

/** Over-receipt beyond tolerance without the required receipt type/permission. */
export class OverReceiptError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/grn-over-receipt';
  readonly title = 'Over-receipt not permitted';
}

/** RMA is not in a state that permits the attempted transition. */
export class RmaStateError extends DomainError {
  readonly status = 409;
  readonly type = 'https://procureflow.io/errors/rma-state';
  readonly title = 'Invalid RMA state';
}
