/**
 * Base class for domain errors (Master Context §3 rule #4 — never throw
 * strings). Later slices extend this with MatchExceptionError, BudgetBreachError,
 * etc. The exception filter renders these as RFC 7807 problem+json (§8).
 */
export abstract class DomainError extends Error {
  abstract readonly status: number;
  abstract readonly type: string;
  abstract readonly title: string;
  readonly context?: Record<string, unknown>;

  constructor(message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.context = context;
  }
}

/** Thrown by ZodValidationPipe on invalid input. */
export class ZodValidationError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/validation';
  readonly title = 'Request validation failed';
}
