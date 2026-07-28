import { DomainError } from '../common/errors/domain-error';

/** Movement input failed validation (quantities, missing refs, bad location). */
export class InventoryValidationError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/inventory-validation';
  readonly title = 'Inventory validation failed';
}

/**
 * Not enough stock at the chosen location to satisfy an outward movement
 * (business rule 4). Callers may override with an explicit flag.
 */
export class InsufficientStockError extends DomainError {
  readonly status = 409;
  readonly type = 'https://procureflow.io/errors/inventory-insufficient-stock';
  readonly title = 'Insufficient stock at location';
}

/** A goods receipt was attempted without a valid, approved PO (business rule 1). */
export class PoRequiredError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/inventory-po-required';
  readonly title = 'Purchase order required for goods receipt';
}

/** A ledger entry is not in a state that permits the attempted transition. */
export class LedgerStateError extends DomainError {
  readonly status = 409;
  readonly type = 'https://procureflow.io/errors/inventory-ledger-state';
  readonly title = 'Invalid ledger entry state';
}

/** Attempted mutation of the immutable ledger (business rule 6). */
export class LedgerImmutableError extends DomainError {
  readonly status = 409;
  readonly type = 'https://procureflow.io/errors/inventory-ledger-immutable';
  readonly title = 'Stock ledger entries are immutable';
}

/** Bulk import batch/row is not in a state that permits the attempted action. */
export class ImportStateError extends DomainError {
  readonly status = 409;
  readonly type = 'https://procureflow.io/errors/inventory-import-state';
  readonly title = 'Invalid import batch state';
}

/** The uploaded file could not be parsed into rows. */
export class ImportParseError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/inventory-import-parse';
  readonly title = 'Import file could not be parsed';
}
