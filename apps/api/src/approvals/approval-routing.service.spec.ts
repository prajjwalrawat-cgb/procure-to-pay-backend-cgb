import { describe, expect, it, vi } from 'vitest';

import type { AuditLogService } from '../audit/audit.service';
import type { DomainEventService } from '../common/events/domain-event.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ApprovalContextService } from './approval-context.service';
import { ApprovalRoutingService } from './approval-routing.service';
import type { ApproverResolver } from './approver-resolver.service';
import type { NotificationService } from './notification.service';

interface FakeApproval {
  id: string;
  documentType: 'INVOICE';
  documentId: string;
  stepNo: number;
  decision: string;
  parallelGroup: string | null;
  isEscalation: boolean;
  slaHours: number;
  slaDueAt: Date | null;
  decidedAt: Date | null;
  comment: string | null;
  approverId: string;
  delegatedFromId: string | null;
  stepName: string | null;
  scope: string | null;
  matrixSnapshotId: string;
  createdAt: Date;
}

function approval(partial: Partial<FakeApproval>): FakeApproval {
  return {
    id: 'apr_x',
    documentType: 'INVOICE',
    documentId: 'inv_1',
    stepNo: 1,
    decision: 'PENDING',
    parallelGroup: null,
    isEscalation: false,
    slaHours: 24,
    slaDueAt: null,
    decidedAt: null,
    comment: null,
    approverId: 'usr_a',
    delegatedFromId: null,
    stepName: 'Step',
    scope: 'tenant',
    matrixSnapshotId: 'amx_1',
    createdAt: new Date('2026-01-01'),
    ...partial,
  };
}

function makeRouting(opts: {
  approvals: FakeApproval[];
  snapshot?: { matrixId: string; steps: unknown[] };
}) {
  const invoiceUpdate = vi.fn().mockResolvedValue({});
  const approvalCreate = vi.fn().mockResolvedValue(approval({ id: 'apr_new' }));
  const deleteMany = vi.fn().mockResolvedValue({ count: 0 });

  const prisma = {
    currentTenantId: 'ten_1',
    client: {
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
      approval: {
        findMany: vi.fn().mockResolvedValue(opts.approvals),
        create: approvalCreate,
        deleteMany,
      },
      invoice: {
        update: invoiceUpdate,
        findUnique: vi
          .fn()
          .mockResolvedValue({ approvalMatrixSnapshot: opts.snapshot ?? null }),
      },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    },
  } as unknown as PrismaService;

  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuditLogService;
  const events = {
    emit: vi.fn().mockResolvedValue(undefined),
  } as unknown as DomainEventService;
  const context = {
    build: vi.fn().mockResolvedValue({ documentType: 'INVOICE', total_amount: '100000' }),
    submitterOf: vi.fn().mockResolvedValue('usr_submitter'),
  } as unknown as ApprovalContextService;
  const resolver = {
    resolve: vi.fn().mockResolvedValue({ approverId: 'usr_b', delegatedFromId: null }),
  } as unknown as ApproverResolver;
  const notifications = {
    notify: vi.fn().mockResolvedValue(undefined),
  } as unknown as NotificationService;

  const service = new ApprovalRoutingService(
    prisma,
    audit,
    events,
    context,
    resolver,
    notifications,
  );
  return { service, invoiceUpdate, approvalCreate, deleteMany, audit, events };
}

describe('ApprovalRoutingService.advance', () => {
  it('marks the document APPROVED when the last step is approved', async () => {
    const { service, invoiceUpdate, audit } = makeRouting({
      approvals: [approval({ stepNo: 1, decision: 'APPROVED' })],
      snapshot: { matrixId: 'amx_1', steps: [{ step_no: 1 }] },
    });
    await service.advance('INVOICE', 'inv_1', 'usr_a');
    expect(invoiceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'APPROVED' } }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DOCUMENT_APPROVED' }),
    );
  });

  it('rejects the document and cancels pending approvals on any rejection', async () => {
    const { service, invoiceUpdate, deleteMany } = makeRouting({
      approvals: [
        approval({ id: 'a1', stepNo: 1, decision: 'REJECTED' }),
        approval({ id: 'a2', stepNo: 2, decision: 'PENDING' }),
      ],
    });
    await service.advance('INVOICE', 'inv_1', 'usr_a');
    expect(invoiceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'REJECTED' } }),
    );
    expect(deleteMany).toHaveBeenCalled();
  });

  it('reverts the document when changes are requested', async () => {
    const { service, invoiceUpdate } = makeRouting({
      approvals: [approval({ stepNo: 1, decision: 'CHANGES_REQUESTED' })],
    });
    await service.advance('INVOICE', 'inv_1', 'usr_a');
    expect(invoiceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'MATCH_EXCEPTION' } }),
    );
  });

  it('creates the next step when the current step is approved and more remain', async () => {
    const { service, approvalCreate, invoiceUpdate } = makeRouting({
      approvals: [approval({ stepNo: 1, decision: 'APPROVED' })],
      snapshot: {
        matrixId: 'amx_1',
        steps: [
          { step_no: 1, name: 'A', role: 'PLANT_HEAD', scope: 'tenant', sla_hours: 24 },
          { step_no: 2, name: 'B', role: 'FINANCE_HEAD', scope: 'tenant', sla_hours: 48 },
        ],
      },
    });
    await service.advance('INVOICE', 'inv_1', 'usr_a');
    expect(approvalCreate).toHaveBeenCalled();
    // Not approved yet — a later step is now pending.
    expect(invoiceUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'APPROVED' } }),
    );
  });

  it('waits (no status change) while the current step is still pending', async () => {
    const { service, invoiceUpdate } = makeRouting({
      approvals: [approval({ stepNo: 1, decision: 'PENDING' })],
      snapshot: { matrixId: 'amx_1', steps: [{ step_no: 1 }] },
    });
    await service.advance('INVOICE', 'inv_1', 'usr_a');
    expect(invoiceUpdate).not.toHaveBeenCalled();
  });

  it('advances a parallel-group step when any one member approves', async () => {
    const { service, invoiceUpdate } = makeRouting({
      approvals: [
        approval({ id: 'a1', stepNo: 1, decision: 'APPROVED', parallelGroup: 'g1' }),
        approval({ id: 'a2', stepNo: 1, decision: 'PENDING', parallelGroup: 'g1' }),
      ],
      snapshot: { matrixId: 'amx_1', steps: [{ step_no: 1 }] },
    });
    await service.advance('INVOICE', 'inv_1', 'usr_a');
    expect(invoiceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'APPROVED' } }),
    );
  });
});
