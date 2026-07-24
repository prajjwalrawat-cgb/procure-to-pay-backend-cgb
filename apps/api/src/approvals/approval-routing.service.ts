import { Injectable } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import {
  evaluateConditions,
  type ApprovalContext,
  type ApprovalDecisionAction,
  type ApprovalStep,
  type Condition,
  type DocumentType,
  type LiveApprovalStep,
} from '@procureflow/shared';

import { AuditLogService } from '../audit/audit.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { ApprovalContextService } from './approval-context.service';
import {
  ApprovalStateError,
  NoMatchingMatrixError,
  NotAssignedApproverError,
} from './approval.errors';
import { ApproverResolver } from './approver-resolver.service';
import { docMeta, type ApprovalOutcome } from './document-status';
import { NotificationService } from './notification.service';

interface MatrixSnapshot {
  matrixId: string;
  name: string;
  version: number;
  steps: ApprovalStep[];
}

type ApprovalRow = Prisma.ApprovalGetPayload<Record<string, never>>;

/** Post-approval hook a document module registers to run when its doc is fully
 *  approved (e.g. payment runs submit to the bank). Runs inside the deciding
 *  request's tenant transaction, keeping the engine document-agnostic. */
export type DocumentApprovedHook = (documentId: string, actorId: string) => Promise<void>;

/**
 * ApprovalRoutingService — the generic engine orchestrator (Slice 2).
 * Submits documents, records decisions, and advances the chain. Works on any
 * document type via `ApprovalContextService` + `document-status` mapping.
 */
@Injectable()
export class ApprovalRoutingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
    private readonly context: ApprovalContextService,
    private readonly resolver: ApproverResolver,
    private readonly notifications: NotificationService,
  ) {}

  private readonly approvedHooks = new Map<DocumentType, DocumentApprovedHook[]>();

  /** Register a hook fired when a document of `documentType` is fully approved. */
  onApproved(documentType: DocumentType, hook: DocumentApprovedHook): void {
    const hooks = this.approvedHooks.get(documentType) ?? [];
    hooks.push(hook);
    this.approvedHooks.set(documentType, hooks);
  }

  /** Snapshot the first matching matrix, create step-1 approvals, route. */
  async submit(
    documentType: DocumentType,
    documentId: string,
    actorId: string,
  ): Promise<void> {
    const tenantId = this.tenantId();
    // Idempotent: never double-route a document that is already in flight.
    const existing = await this.prisma.client.approval.count({
      where: { documentType, documentId },
    });
    if (existing > 0) return;

    const ctx = await this.context.build(documentType, documentId);
    const submitterId =
      (await this.context.submitterOf(documentType, documentId)) ?? actorId;

    const matrices = await this.prisma.client.approvalMatrix.findMany({
      where: { documentType, isActive: true },
      orderBy: { priority: 'asc' },
    });
    const matched = matrices.find(
      (m) => evaluateConditions(m.conditions as unknown as Condition, ctx).matched,
    );
    if (!matched) {
      await this.events.emit('NoMatchingMatrix', { documentType, documentId });
      throw new NoMatchingMatrixError(
        'No active approval matrix matched this document.',
        { documentType, documentId },
      );
    }

    const steps = matched.steps as unknown as ApprovalStep[];
    const snapshot: MatrixSnapshot = {
      matrixId: matched.id,
      name: matched.name,
      version: matched.version,
      steps,
    };
    await this.writeSnapshot(documentType, documentId, snapshot);

    const created = await this.createStepFrom(
      documentType,
      documentId,
      snapshot,
      firstStepNo(steps),
      submitterId,
      ctx,
      matched.id,
    );

    await this.setStatus(documentType, documentId, 'AWAITING');
    await this.audit.record({
      action: 'DOCUMENT_ROUTED',
      entityType: entityType(documentType),
      entityId: documentId,
      actorId,
      after: {
        matrixId: matched.id,
        matrix: matched.name,
        version: matched.version,
        assignees: created.map((a) => a.approverId),
      },
    });
    await this.events.emit('ApprovalRequested', {
      documentType,
      documentId,
      approvalIds: created.map((a) => a.id),
    });
    for (const appr of created) {
      await this.notify(appr, documentType, documentId, tenantId);
    }
    // A step whose only members were skipped advances immediately.
    if (created.length === 0) await this.advance(documentType, documentId, actorId);
  }

  /** Record a decision, then advance. */
  async decide(
    approvalId: string,
    action: ApprovalDecisionAction,
    comment: string | null,
    actorId: string,
  ): Promise<void> {
    const approval = await this.prisma.client.approval.findUnique({
      where: { id: approvalId },
    });
    if (!approval) throw new NotAssignedApproverError('Approval not found.');
    if (approval.decision !== 'PENDING') {
      throw new ApprovalStateError('This approval has already been decided.');
    }
    if (approval.approverId !== actorId) {
      throw new NotAssignedApproverError('You are not the assigned approver.', {
        approvalId,
      });
    }

    const decision =
      action === 'APPROVE'
        ? 'APPROVED'
        : action === 'REJECT'
          ? 'REJECTED'
          : 'CHANGES_REQUESTED';

    await this.prisma.client.approval.update({
      where: { id: approvalId },
      data: { decision, decidedAt: new Date(), comment: comment ?? null },
    });
    await this.audit.record({
      action: 'APPROVAL_DECIDED',
      entityType: entityType(approval.documentType),
      entityId: approval.documentId,
      actorId,
      before: { approvalId, stepNo: approval.stepNo },
      after: { decision, comment: comment ?? null },
    });
    await this.events.emit('ApprovalDecided', {
      approvalId,
      documentType: approval.documentType,
      documentId: approval.documentId,
      decision,
    });

    await this.advance(approval.documentType, approval.documentId, actorId);
  }

  /** Evaluate the current step and move the document forward (row-locked). */
  async advance(
    documentType: DocumentType,
    documentId: string,
    actorId: string,
  ): Promise<void> {
    const meta = docMeta(documentType);
    // Serialise concurrent advances (e.g. two parallel approvers racing).
    await this.prisma.client.$queryRawUnsafe(
      `SELECT 1 FROM ${meta.table} WHERE id = $1 FOR UPDATE`,
      documentId,
    );

    const approvals = await this.prisma.client.approval.findMany({
      where: { documentType, documentId },
      orderBy: [{ stepNo: 'asc' }, { createdAt: 'asc' }],
    });

    if (approvals.some((a) => a.decision === 'REJECTED')) {
      await this.terminate(documentType, documentId, approvals, 'REJECTED', actorId);
      return;
    }
    if (approvals.some((a) => a.decision === 'CHANGES_REQUESTED')) {
      await this.terminate(documentType, documentId, approvals, 'REVERTED', actorId);
      return;
    }

    // Walk steps in order; stop at the first unsatisfied one.
    const byStep = groupByStep(approvals);
    const stepNos = [...byStep.keys()].sort((a, b) => a - b);
    for (const stepNo of stepNos) {
      const members = byStep.get(stepNo) ?? [];
      if (!stepSatisfied(members)) return; // still waiting on this step
    }

    // All existing steps satisfied — walk forward through the snapshot, creating
    // the next step. Fully-skipped steps (skip_if match, or a step that resolves
    // only to the submitter) advance to the step AFTER them — never re-attempting
    // the same step number, which would loop forever when a middle step is the
    // submitter's own role.
    const snapshot = await this.readSnapshot(documentType, documentId);
    if (!snapshot) return;
    let candidate = nextStepAfter(snapshot.steps, Math.max(...stepNos, 0));
    if (candidate !== null) {
      const ctx = await this.context.build(documentType, documentId);
      const submitterId = await this.context.submitterOf(documentType, documentId);
      const tenantId = this.tenantId();
      while (candidate !== null) {
        const created = await this.createStepFrom(
          documentType,
          documentId,
          snapshot,
          candidate,
          submitterId,
          ctx,
          snapshot.matrixId,
        );
        if (created.length > 0) {
          for (const appr of created) {
            await this.notify(appr, documentType, documentId, tenantId);
          }
          return;
        }
        candidate = nextStepAfter(snapshot.steps, candidate);
      }
      // Every remaining step was skipped → fall through to approved.
    }

    // No further steps → approved.
    await this.setStatus(documentType, documentId, 'APPROVED');
    await this.audit.record({
      action: 'DOCUMENT_APPROVED',
      entityType: entityType(documentType),
      entityId: documentId,
      actorId,
    });
    await this.events.emit('DocumentApproved', { documentType, documentId });
    await this.notifySubmitter(documentType, documentId, 'DOCUMENT_APPROVED', 'Approved');
    for (const hook of this.approvedHooks.get(documentType) ?? []) {
      await hook(documentId, actorId);
    }
  }

  /** Assigned approver hands off to another user with the same role. */
  async delegate(
    approvalId: string,
    delegateToUserId: string,
    reason: string,
    actorId: string,
  ): Promise<void> {
    const approval = await this.prisma.client.approval.findUnique({
      where: { id: approvalId },
    });
    if (!approval) throw new NotAssignedApproverError('Approval not found.');
    if (approval.approverId !== actorId) {
      throw new NotAssignedApproverError('Only the assigned approver may delegate.');
    }
    if (approval.decision !== 'PENDING') {
      throw new ApprovalStateError('Decided approvals cannot be delegated.');
    }

    await this.prisma.client.approval.update({
      where: { id: approvalId },
      data: {
        approverId: delegateToUserId,
        delegatedFromId: actorId,
      },
    });
    await this.audit.record({
      action: 'APPROVAL_DELEGATED',
      entityType: entityType(approval.documentType),
      entityId: approval.documentId,
      actorId,
      after: { approvalId, delegateTo: delegateToUserId, reason },
    });
    await this.events.emit('ApprovalDelegated', {
      approvalId,
      from: actorId,
      to: delegateToUserId,
    });
    await this.notifications.notify({
      userId: delegateToUserId,
      type: 'APPROVAL_DELEGATED',
      title: 'An approval was delegated to you',
      entityType: entityType(approval.documentType),
      entityId: approval.documentId,
      href: hrefFor(approval.documentType, approval.documentId),
    });
  }

  /** Submitter withdraws before the first decision; all pending cancelled. */
  async withdraw(
    documentType: DocumentType,
    documentId: string,
    actorId: string,
  ): Promise<void> {
    const approvals = await this.prisma.client.approval.findMany({
      where: { documentType, documentId },
    });
    if (approvals.some((a) => a.decision !== 'PENDING')) {
      throw new ApprovalStateError('Cannot withdraw after a decision has been made.');
    }
    await this.prisma.client.approval.deleteMany({ where: { documentType, documentId } });
    await this.setStatus(documentType, documentId, 'REVERTED');
    await this.audit.record({
      action: 'DOCUMENT_WITHDRAWN',
      entityType: entityType(documentType),
      entityId: documentId,
      actorId,
    });
    await this.events.emit('DocumentWithdrawn', { documentType, documentId });
  }

  /**
   * Live chain for a document detail view: the real Approval rows if routed,
   * else the prospective resolved chain from the active matrix (like simulate).
   */
  async getLiveChain(
    documentType: DocumentType,
    documentId: string,
  ): Promise<LiveApprovalStep[]> {
    const approvals = await this.prisma.client.approval.findMany({
      where: { documentType, documentId },
      orderBy: [{ stepNo: 'asc' }, { createdAt: 'asc' }],
    });
    if (approvals.length > 0) return this.liveFromApprovals(approvals);
    return this.prospectiveChain(documentType, documentId);
  }

  /** Retroactively route documents left AWAITING by the Slice 1 stub. */
  async rerouteAwaiting(documentType: DocumentType, actorId: string): Promise<number> {
    if (documentType !== 'INVOICE') return 0;
    const invoices = await this.prisma.client.invoice.findMany({
      where: { status: 'AWAITING_APPROVAL' },
      select: { id: true },
    });
    let routed = 0;
    for (const inv of invoices) {
      const already = await this.prisma.client.approval.count({
        where: { documentType, documentId: inv.id },
      });
      if (already > 0) continue;
      await this.submit(documentType, inv.id, actorId);
      routed += 1;
    }
    return routed;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async createStepFrom(
    documentType: DocumentType,
    documentId: string,
    snapshot: MatrixSnapshot,
    stepNo: number,
    submitterId: string | null,
    ctx: ApprovalContext,
    matrixId: string,
  ): Promise<ApprovalRow[]> {
    const members = snapshot.steps.filter((s) => s.step_no === stepNo);
    const created: ApprovalRow[] = [];
    for (const step of members) {
      if (step.skip_if && evaluateConditions(step.skip_if, ctx).matched) {
        await this.auditSkip(documentType, documentId, step, 'skip_if');
        continue;
      }
      const resolved = await this.resolver.resolve(step.role, step.scope, ctx, {
        documentType,
        tenantId: this.tenantId(),
      });
      if (submitterId && resolved.approverId === submitterId) {
        await this.auditSkip(documentType, documentId, step, 'submitter');
        continue;
      }
      const row = await this.prisma.client.approval.create({
        data: {
          id: newId('approval'),
          tenantId: this.tenantId(),
          documentType,
          documentId,
          stepNo: step.step_no,
          stepName: step.name,
          scope: step.scope,
          parallelGroup: step.parallel_group ?? null,
          approverId: resolved.approverId,
          delegatedFromId: resolved.delegatedFromId,
          slaHours: step.sla_hours,
          slaDueAt: new Date(Date.now() + step.sla_hours * 60 * 60 * 1000),
          matrixSnapshotId: matrixId,
        },
      });
      created.push(row);
    }
    return created;
  }

  private async terminate(
    documentType: DocumentType,
    documentId: string,
    approvals: ApprovalRow[],
    outcome: Extract<ApprovalOutcome, 'REJECTED' | 'REVERTED'>,
    actorId: string,
  ): Promise<void> {
    if (outcome === 'REVERTED') {
      // Changes-requested sends the document back to DRAFT for revision. Clear
      // the whole chain (including the decided rows) so it is a clean slate —
      // otherwise the submit() idempotency guard sees the stale rows and the
      // re-submission silently no-ops. REJECTED is terminal, so it keeps its
      // rows (they render who rejected; the document status blocks re-submit).
      await this.prisma.client.approval.deleteMany({
        where: { documentType, documentId },
      });
    } else {
      const pending = approvals.filter((a) => a.decision === 'PENDING');
      if (pending.length > 0) {
        await this.prisma.client.approval.deleteMany({
          where: { id: { in: pending.map((a) => a.id) } },
        });
      }
    }
    await this.setStatus(documentType, documentId, outcome);
    const action =
      outcome === 'REJECTED' ? 'DOCUMENT_REJECTED' : 'DOCUMENT_CHANGES_REQUESTED';
    await this.audit.record({
      action,
      entityType: entityType(documentType),
      entityId: documentId,
      actorId,
    });
    await this.events.emit(
      outcome === 'REJECTED' ? 'DocumentRejected' : 'DocumentChangesRequested',
      { documentType, documentId },
    );
    await this.notifySubmitter(
      documentType,
      documentId,
      action,
      outcome === 'REJECTED' ? 'Rejected' : 'Changes requested',
    );
  }

  private liveFromApprovals(approvals: ApprovalRow[]): Promise<LiveApprovalStep[]> {
    return this.decorateChain(approvals);
  }

  private async decorateChain(approvals: ApprovalRow[]): Promise<LiveApprovalStep[]> {
    const userIds = [
      ...new Set(
        approvals.flatMap((a) =>
          [a.approverId, a.delegatedFromId].filter((v): v is string => !!v),
        ),
      ),
    ];
    const users = await this.prisma.client.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    const currentStep = this.currentStepNo(approvals);
    const now = Date.now();

    return approvals.map((a) => {
      const decision = a.decision as LiveApprovalStep['decision'];
      const isCurrent = a.stepNo === currentStep && decision === 'PENDING';
      return {
        approvalId: a.id,
        stepNo: a.stepNo,
        name: a.stepName ?? a.scope ?? `Step ${a.stepNo}`,
        role: a.stepName ?? '',
        scope: a.scope ?? 'tenant',
        slaHours: a.slaHours,
        parallelGroup: a.parallelGroup,
        approverId: a.approverId,
        approverName: nameById.get(a.approverId) ?? null,
        decision,
        decidedAt: a.decidedAt?.toISOString() ?? null,
        comment: a.comment,
        slaDueAt: a.slaDueAt?.toISOString() ?? null,
        slaStatus: slaStatus(decision, a.slaDueAt, a.slaHours, now),
        isCurrent,
        isEscalation: a.isEscalation,
        delegatedFromName: a.delegatedFromId
          ? (nameById.get(a.delegatedFromId) ?? null)
          : null,
      };
    });
  }

  private async prospectiveChain(
    documentType: DocumentType,
    documentId: string,
  ): Promise<LiveApprovalStep[]> {
    const ctx = await this.context.build(documentType, documentId).catch(() => null);
    if (!ctx) return [];
    const submitterId = await this.context.submitterOf(documentType, documentId);
    const matrices = await this.prisma.client.approvalMatrix.findMany({
      where: { documentType, isActive: true },
      orderBy: { priority: 'asc' },
    });
    const matched = matrices.find(
      (m) => evaluateConditions(m.conditions as unknown as Condition, ctx).matched,
    );
    if (!matched) return [];
    const steps = (matched.steps as unknown as ApprovalStep[]).sort(
      (a, b) => a.step_no - b.step_no,
    );
    const out: LiveApprovalStep[] = [];
    for (const step of steps) {
      if (step.skip_if && evaluateConditions(step.skip_if, ctx).matched) continue;
      const candidates = await this.resolver.candidatesForRole(
        step.role,
        step.scope,
        ctx,
      );
      const nonSubmitter = candidates.filter((c) => c !== submitterId);
      if (submitterId && nonSubmitter.length === 0 && candidates.includes(submitterId)) {
        continue;
      }
      const approverId = nonSubmitter.length === 1 ? (nonSubmitter[0] as string) : null;
      const user = approverId
        ? await this.prisma.client.user.findUnique({
            where: { id: approverId },
            select: { name: true },
          })
        : null;
      out.push({
        approvalId: null,
        stepNo: step.step_no,
        name: step.name,
        role: step.role,
        scope: step.scope,
        slaHours: step.sla_hours,
        parallelGroup: step.parallel_group ?? null,
        approverId,
        approverName: user?.name ?? null,
        decision: 'PENDING',
        decidedAt: null,
        comment: null,
        slaDueAt: null,
        slaStatus: 'ok',
        isCurrent: out.length === 0,
        isEscalation: false,
        delegatedFromName: null,
      });
    }
    return out;
  }

  private currentStepNo(approvals: ApprovalRow[]): number {
    const byStep = groupByStep(approvals);
    const stepNos = [...byStep.keys()].sort((a, b) => a - b);
    for (const stepNo of stepNos) {
      if (!stepSatisfied(byStep.get(stepNo) ?? [])) return stepNo;
    }
    return Math.max(...stepNos, 0);
  }

  private async notify(
    appr: ApprovalRow,
    documentType: DocumentType,
    documentId: string,
    tenantId: string,
  ): Promise<void> {
    await this.notifications.notify({
      userId: appr.approverId,
      tenantId,
      type: 'APPROVAL_REQUESTED',
      title: `${entityType(documentType)} awaiting your approval`,
      entityType: entityType(documentType),
      entityId: documentId,
      href: hrefFor(documentType, documentId),
    });
  }

  private async notifySubmitter(
    documentType: DocumentType,
    documentId: string,
    type: string,
    outcome: string,
  ): Promise<void> {
    const submitterId = await this.context.submitterOf(documentType, documentId);
    if (!submitterId) return;
    await this.notifications.notify({
      userId: submitterId,
      type,
      title: `${entityType(documentType)} ${outcome.toLowerCase()}`,
      entityType: entityType(documentType),
      entityId: documentId,
      href: hrefFor(documentType, documentId),
    });
  }

  private async auditSkip(
    documentType: DocumentType,
    documentId: string,
    step: ApprovalStep,
    reason: 'skip_if' | 'submitter',
  ): Promise<void> {
    await this.audit.record({
      action: reason === 'submitter' ? 'SUBMITTER_SKIPPED' : 'STEP_SKIPPED',
      entityType: entityType(documentType),
      entityId: documentId,
      actorType: 'SYSTEM',
      after: { stepNo: step.step_no, role: step.role, reason },
    });
  }

  private async setStatus(
    documentType: DocumentType,
    documentId: string,
    outcome: ApprovalOutcome,
  ): Promise<void> {
    const status = docMeta(documentType).status[outcome];
    if (documentType === 'INVOICE') {
      await this.prisma.client.invoice.update({
        where: { id: documentId },
        data: { status: status as Prisma.InvoiceUpdateInput['status'] },
      });
    } else if (documentType === 'PAYMENT_RUN') {
      await this.prisma.client.paymentRun.update({
        where: { id: documentId },
        data: { status: status as Prisma.PaymentRunUpdateInput['status'] },
      });
    } else if (documentType === 'REQUISITION') {
      await this.prisma.client.requisition.update({
        where: { id: documentId },
        data: { status: status as Prisma.RequisitionUpdateInput['status'] },
      });
    } else if (documentType === 'PURCHASE_ORDER') {
      await this.prisma.client.purchaseOrder.update({
        where: { id: documentId },
        data: { status: status as Prisma.PurchaseOrderUpdateInput['status'] },
      });
    } else if (documentType === 'RFQ_AWARD') {
      await this.prisma.client.award.update({
        where: { id: documentId },
        data: { status: status as Prisma.AwardUpdateInput['status'] },
      });
    } else if (documentType === 'VENDOR_ONBOARDING') {
      // While in flight (AWAITING) there is no OnboardingReviewDecision value —
      // leave reviewDecision null and just stamp the review start. Terminal
      // outcomes map onto the reviewDecision enum; the activation hook runs on APPROVE.
      if (outcome === 'AWAITING') {
        await this.prisma.client.vendorOnboarding.update({
          where: { id: documentId },
          data: { reviewStartedAt: new Date() },
        });
      } else {
        await this.prisma.client.vendorOnboarding.update({
          where: { id: documentId },
          data: {
            reviewDecision:
              status as Prisma.VendorOnboardingUpdateInput['reviewDecision'],
            decisionAt: new Date(),
          },
        });
      }
    } else if (documentType === 'VENDOR_CHANGE') {
      await this.prisma.client.vendorChangeRequest.update({
        where: { id: documentId },
        data: { status: status as Prisma.VendorChangeRequestUpdateInput['status'] },
      });
    } else if (documentType === 'CONTRACT') {
      await this.prisma.client.contract.update({
        where: { id: documentId },
        data: { status: status as Prisma.ContractUpdateInput['status'] },
      });
    } else if (documentType === 'CONTRACT_AMENDMENT') {
      await this.prisma.client.contractAmendment.update({
        where: { id: documentId },
        data: { status: status as Prisma.ContractAmendmentUpdateInput['status'] },
      });
    }
  }

  private async writeSnapshot(
    documentType: DocumentType,
    documentId: string,
    snapshot: MatrixSnapshot,
  ): Promise<void> {
    const json = snapshot as unknown as Prisma.InputJsonValue;
    if (documentType === 'INVOICE') {
      await this.prisma.client.invoice.update({
        where: { id: documentId },
        data: { approvalMatrixSnapshot: json },
      });
    } else if (documentType === 'PAYMENT_RUN') {
      await this.prisma.client.paymentRun.update({
        where: { id: documentId },
        data: { approvals: json },
      });
    } else if (documentType === 'REQUISITION') {
      await this.prisma.client.requisition.update({
        where: { id: documentId },
        data: { approvalMatrixSnapshot: json },
      });
    } else if (documentType === 'PURCHASE_ORDER') {
      await this.prisma.client.purchaseOrder.update({
        where: { id: documentId },
        data: { approvalMatrixSnapshot: json },
      });
    } else if (documentType === 'RFQ_AWARD') {
      await this.prisma.client.award.update({
        where: { id: documentId },
        data: { approvalMatrixSnapshot: json },
      });
    } else if (documentType === 'VENDOR_ONBOARDING') {
      await this.prisma.client.vendorOnboarding.update({
        where: { id: documentId },
        data: { approvalMatrixSnapshot: json },
      });
    } else if (documentType === 'VENDOR_CHANGE') {
      await this.prisma.client.vendorChangeRequest.update({
        where: { id: documentId },
        data: { approvalMatrixSnapshot: json },
      });
    } else if (documentType === 'CONTRACT') {
      await this.prisma.client.contract.update({
        where: { id: documentId },
        data: { approvalMatrixSnapshot: json },
      });
    } else if (documentType === 'CONTRACT_AMENDMENT') {
      await this.prisma.client.contractAmendment.update({
        where: { id: documentId },
        data: { approvalMatrixSnapshot: json },
      });
    }
  }

  private async readSnapshot(
    documentType: DocumentType,
    documentId: string,
  ): Promise<MatrixSnapshot | null> {
    if (documentType === 'INVOICE') {
      const inv = await this.prisma.client.invoice.findUnique({
        where: { id: documentId },
        select: { approvalMatrixSnapshot: true },
      });
      return (inv?.approvalMatrixSnapshot as unknown as MatrixSnapshot | null) ?? null;
    }
    if (documentType === 'PAYMENT_RUN') {
      const run = await this.prisma.client.paymentRun.findUnique({
        where: { id: documentId },
        select: { approvals: true },
      });
      return (run?.approvals as unknown as MatrixSnapshot | null) ?? null;
    }
    if (documentType === 'REQUISITION') {
      const pr = await this.prisma.client.requisition.findUnique({
        where: { id: documentId },
        select: { approvalMatrixSnapshot: true },
      });
      return (pr?.approvalMatrixSnapshot as unknown as MatrixSnapshot | null) ?? null;
    }
    if (documentType === 'PURCHASE_ORDER') {
      const po = await this.prisma.client.purchaseOrder.findUnique({
        where: { id: documentId },
        select: { approvalMatrixSnapshot: true },
      });
      return (po?.approvalMatrixSnapshot as unknown as MatrixSnapshot | null) ?? null;
    }
    if (documentType === 'RFQ_AWARD') {
      const award = await this.prisma.client.award.findUnique({
        where: { id: documentId },
        select: { approvalMatrixSnapshot: true },
      });
      return (award?.approvalMatrixSnapshot as unknown as MatrixSnapshot | null) ?? null;
    }
    if (documentType === 'VENDOR_ONBOARDING') {
      const ob = await this.prisma.client.vendorOnboarding.findUnique({
        where: { id: documentId },
        select: { approvalMatrixSnapshot: true },
      });
      return (ob?.approvalMatrixSnapshot as unknown as MatrixSnapshot | null) ?? null;
    }
    if (documentType === 'VENDOR_CHANGE') {
      const cr = await this.prisma.client.vendorChangeRequest.findUnique({
        where: { id: documentId },
        select: { approvalMatrixSnapshot: true },
      });
      return (cr?.approvalMatrixSnapshot as unknown as MatrixSnapshot | null) ?? null;
    }
    if (documentType === 'CONTRACT') {
      const c = await this.prisma.client.contract.findUnique({
        where: { id: documentId },
        select: { approvalMatrixSnapshot: true },
      });
      return (c?.approvalMatrixSnapshot as unknown as MatrixSnapshot | null) ?? null;
    }
    if (documentType === 'CONTRACT_AMENDMENT') {
      const a = await this.prisma.client.contractAmendment.findUnique({
        where: { id: documentId },
        select: { approvalMatrixSnapshot: true },
      });
      return (a?.approvalMatrixSnapshot as unknown as MatrixSnapshot | null) ?? null;
    }
    return null;
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}

// ── pure helpers ───────────────────────────────────────────────────────────

function firstStepNo(steps: ApprovalStep[]): number {
  return Math.min(...steps.map((s) => s.step_no));
}

function nextStepAfter(steps: ApprovalStep[], afterStepNo: number): number | null {
  const higher = steps.map((s) => s.step_no).filter((n) => n > afterStepNo);
  return higher.length > 0 ? Math.min(...higher) : null;
}

function groupByStep(approvals: ApprovalRow[]): Map<number, ApprovalRow[]> {
  const map = new Map<number, ApprovalRow[]>();
  for (const a of approvals) {
    const list = map.get(a.stepNo) ?? [];
    list.push(a);
    map.set(a.stepNo, list);
  }
  return map;
}

/** A step is satisfied when all members approved, or — for parallel/escalated
 *  steps — when any one member approved (any-one-approves advances). */
function stepSatisfied(members: ApprovalRow[]): boolean {
  if (members.length === 0) return true;
  const anyOne =
    members.some((m) => m.parallelGroup) || members.some((m) => m.isEscalation);
  const approved = (a: ApprovalRow): boolean => a.decision === 'APPROVED';
  return anyOne ? members.some(approved) : members.every(approved);
}

function slaStatus(
  decision: LiveApprovalStep['decision'],
  slaDueAt: Date | null,
  slaHours: number,
  now: number,
): LiveApprovalStep['slaStatus'] {
  if (decision !== 'PENDING') return 'done';
  if (!slaDueAt) return 'ok';
  const due = slaDueAt.getTime();
  if (now >= due) return 'breach';
  const windowMs = slaHours * 60 * 60 * 1000;
  const elapsed = now - (due - windowMs);
  return elapsed >= windowMs * 0.75 ? 'warn' : 'ok';
}

function entityType(documentType: DocumentType): string {
  switch (documentType) {
    case 'INVOICE':
      return 'Invoice';
    case 'PAYMENT_RUN':
      return 'PaymentRun';
    case 'REQUISITION':
      return 'Requisition';
    case 'PURCHASE_ORDER':
      return 'PurchaseOrder';
    case 'GRN':
      return 'GoodsReceiptNote';
    case 'CONTRACT':
      return 'Contract';
    case 'CONTRACT_AMENDMENT':
      return 'ContractAmendment';
    case 'RFQ_AWARD':
      return 'Award';
    case 'VENDOR_ONBOARDING':
      return 'VendorOnboarding';
    case 'VENDOR_CHANGE':
      return 'VendorChangeRequest';
  }
}

function hrefFor(documentType: DocumentType, documentId: string): string {
  if (documentType === 'INVOICE') return `/invoices/${documentId}`;
  if (documentType === 'PAYMENT_RUN') return `/payment-runs/${documentId}`;
  if (documentType === 'REQUISITION') return `/requisitions/${documentId}`;
  if (documentType === 'PURCHASE_ORDER') return `/purchase-orders/${documentId}`;
  if (documentType === 'CONTRACT') return `/contracts/${documentId}`;
  if (documentType === 'CONTRACT_AMENDMENT') return `/contracts/${documentId}`;
  if (documentType === 'RFQ_AWARD') return `/sourcing/awards/${documentId}`;
  if (documentType === 'VENDOR_ONBOARDING') return `/vendors/onboarding/${documentId}`;
  if (documentType === 'VENDOR_CHANGE') return `/vendors/changes/${documentId}`;
  return `/${documentType.toLowerCase()}/${documentId}`;
}
