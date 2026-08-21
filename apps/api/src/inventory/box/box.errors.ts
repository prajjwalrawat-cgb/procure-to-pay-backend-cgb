import { DomainError } from '../../common/errors/domain-error';

/**
 * A scanned box barcode matched no box. Carries the raw value so the handset
 * can offer "register this box" instead of a dead end — the operator is holding
 * the carton.
 */
export class BoxNotFoundError extends DomainError {
  readonly status = 404;
  readonly type = 'https://procureflow.io/errors/box-not-found';
  readonly title = 'Box barcode not recognised';

  constructor(barcodeRaw: string) {
    super(`No box matches barcode "${barcodeRaw}".`, { barcodeRaw });
  }
}

/** The box operation is well-formed but the warehouse state forbids it. */
export class BoxValidationError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/box-validation';
  readonly title = 'Box operation rejected';
}

/** A box is retired, or already where it is being moved to. */
export class BoxStateError extends DomainError {
  readonly status = 409;
  readonly type = 'https://procureflow.io/errors/box-state';
  readonly title = 'Invalid box state';
}
