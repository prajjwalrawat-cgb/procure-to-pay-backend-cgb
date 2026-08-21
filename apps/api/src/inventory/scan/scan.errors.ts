import { DomainError } from '../../common/errors/domain-error';

/**
 * A scanned barcode matched no product. Carries the raw scanned value in the
 * problem+json context so the handset can offer "create new SKU" or a manual
 * lookup instead of a dead end — the operator is standing at the shelf.
 */
export class BarcodeNotFoundError extends DomainError {
  readonly status = 404;
  readonly type = 'https://procureflow.io/errors/scan-barcode-not-found';
  readonly title = 'Barcode not recognised';

  constructor(barcodeRaw: string) {
    super(`No product matches barcode "${barcodeRaw}".`, { barcodeRaw });
  }
}

/** A scanned bin label matched no location. */
export class BinNotFoundError extends DomainError {
  readonly status = 404;
  readonly type = 'https://procureflow.io/errors/scan-bin-not-found';
  readonly title = 'Bin barcode not recognised';

  constructor(binBarcodeRaw: string) {
    super(`No location matches bin barcode "${binBarcodeRaw}".`, { binBarcodeRaw });
  }
}

/**
 * The scan is well-formed but the warehouse state forbids it: a batch-tracked
 * receipt with no expiry, a putaway larger than what was received, a pick
 * beyond the ordered quantity.
 */
export class ScanValidationError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/scan-validation';
  readonly title = 'Scan rejected';
}

/** A cycle count session is not in a state that permits the attempted step. */
export class CycleCountStateError extends DomainError {
  readonly status = 409;
  readonly type = 'https://procureflow.io/errors/scan-cycle-count-state';
  readonly title = 'Invalid cycle count session state';
}

/** The referenced pick list does not exist, or is closed/cancelled. */
export class PickListStateError extends DomainError {
  readonly status = 409;
  readonly type = 'https://procureflow.io/errors/scan-pick-list-state';
  readonly title = 'Invalid pick list state';
}
