import { DomainError } from '../common/errors/domain-error';

/** Invalid vendor onboarding/lifecycle input beyond a plain schema failure. */
export class VendorValidationError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/vendor-validation';
  readonly title = 'Vendor validation failed';
}

/** Illegal lifecycle transition (e.g. activating a vendor with pending screenings). */
export class VendorStateError extends DomainError {
  readonly status = 409;
  readonly type = 'https://procureflow.io/errors/vendor-state';
  readonly title = 'Invalid vendor state transition';
}

/** A blacklist attempt without the required MD + LEGAL_OFFICER co-sign. */
export class CosignRequiredError extends DomainError {
  readonly status = 409;
  readonly type = 'https://procureflow.io/errors/cosign-required';
  readonly title = 'Co-sign required';
}

/** A self-registration or magic-link token that is invalid/expired. */
export class InvalidTokenError extends DomainError {
  readonly status = 401;
  readonly type = 'https://procureflow.io/errors/invalid-token';
  readonly title = 'Invalid or expired token';
}
