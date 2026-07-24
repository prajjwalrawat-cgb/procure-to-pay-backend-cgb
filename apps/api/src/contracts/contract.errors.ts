import { DomainError } from '../common/errors/domain-error';

/** Illegal contract lifecycle transition (e.g. execute a non-approved contract). */
export class ContractStateError extends DomainError {
  readonly status = 409;
  readonly type = 'https://procureflow.io/errors/contract-state';
  readonly title = 'Invalid contract state';
}

/** Validation failure creating/updating a contract (missing clause, bad dates…). */
export class ContractValidationError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/contract-validation';
  readonly title = 'Contract validation failed';
}

/** Call-off rejected — contract inactive/expired, rate out of validity, or a
 *  price override was attempted (rate immutability, ADR-029). */
export class CallOffRejectedError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/call-off-rejected';
  readonly title = 'Call-off rejected';
}

/** An action needs a co-signing role that the actor cannot satisfy alone
 *  (early termination = Procurement Head + Legal Officer). */
export class CosignRequiredError extends DomainError {
  readonly status = 409;
  readonly type = 'https://procureflow.io/errors/contract-cosign-required';
  readonly title = 'Co-sign required';
}
