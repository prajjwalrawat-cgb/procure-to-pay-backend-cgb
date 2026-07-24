import { DomainError } from '../common/errors/domain-error';

/** Step role+scope resolved to zero or many candidates — never silently pick one. */
export class AmbiguousApproverError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/ambiguous-approver';
  readonly title = 'Approver could not be resolved';
}

/** No active matrix matched the document — it stays in DRAFT, never auto-approves. */
export class NoMatchingMatrixError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/no-matching-matrix';
  readonly title = 'No approval matrix matched';
}

/** A→B while B→A already exists. */
export class CircularDelegationError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/circular-delegation';
  readonly title = 'Circular delegation rejected';
}

/** Actor is not the assigned approver (nor a valid delegate) for this step. */
export class NotAssignedApproverError extends DomainError {
  readonly status = 403;
  readonly type = 'https://procureflow.io/errors/not-assigned-approver';
  readonly title = 'Not the assigned approver';
}

/** The approval / document is not in a state that allows this action. */
export class ApprovalStateError extends DomainError {
  readonly status = 409;
  readonly type = 'https://procureflow.io/errors/approval-state';
  readonly title = 'Invalid approval state';
}
