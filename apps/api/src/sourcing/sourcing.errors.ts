import { DomainError } from '../common/errors/domain-error';

/** Invalid RFQ/quote/award input that isn't a plain schema failure. */
export class SourcingValidationError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/sourcing-validation';
  readonly title = 'Sourcing validation failed';
}

/** Illegal state transition on an RFQ, quote, or award. */
export class SourcingStateError extends DomainError {
  readonly status = 409;
  readonly type = 'https://procureflow.io/errors/sourcing-state';
  readonly title = 'Invalid sourcing state transition';
}

/** A sealed quote's content was requested before the formal open ceremony. */
export class SealedQuoteError extends DomainError {
  readonly status = 403;
  readonly type = 'https://procureflow.io/errors/sealed-quote';
  readonly title = 'Quote is sealed until opening';
}

/** Multi-party open ceremony quorum not met (Slice 6 §5). */
export class OpenQuorumError extends DomainError {
  readonly status = 403;
  readonly type = 'https://procureflow.io/errors/open-quorum';
  readonly title = 'Quote opening requires a multi-party quorum';
}

/** Two-envelope enforcement: commercial file into technical envelope, etc. */
export class EnvelopeError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/envelope';
  readonly title = 'Envelope rule violated';
}

/** Award to non-L1 vendor without the mandatory variance justification. */
export class VarianceJustificationError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/variance-justification';
  readonly title = 'Variance-from-L1 justification required';
}

/** Reverse-auction bid rejected (not below leader, round not live, etc.). */
export class ReverseAuctionError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/reverse-auction';
  readonly title = 'Reverse-auction bid rejected';
}
