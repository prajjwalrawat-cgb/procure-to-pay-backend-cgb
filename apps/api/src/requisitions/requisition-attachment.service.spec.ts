import { ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditLogService } from '../audit/audit.service';
import { StorageService } from '../common/storage/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { RequisitionAttachmentService } from './requisition-attachment.service';
import { RequisitionStateError } from './requisition.errors';

const REQUESTER = 'usr_officer';
const APPROVER = 'usr_head';
const STRANGER = 'usr_other';
const ADMIN = 'usr_admin';

/**
 * `approverIds` are the users holding an approval step on the PR; `admins` are
 * users whose roles include TENANT_ADMIN.
 */
function build(
  status: string,
  opts: { approverIds?: string[]; admins?: string[] } = {},
) {
  const approverIds = opts.approverIds ?? [APPROVER];
  const admins = opts.admins ?? [ADMIN];
  const pr = { id: 'pr_1', status, requesterId: REQUESTER };

  const created: Record<string, unknown>[] = [];
  const client = {
    requisition: { findUnique: vi.fn().mockResolvedValue(pr) },
    approval: {
      findFirst: vi.fn(async (a: { where: { approverId: string } }) =>
        approverIds.includes(a.where.approverId) ? { id: 'apr_1' } : null,
      ),
    },
    userRole: {
      findMany: vi.fn(async (a: { where: { userId: string } }) =>
        admins.includes(a.where.userId) ? [{ role: { name: 'TENANT_ADMIN' } }] : [],
      ),
    },
    requisitionAttachment: {
      create: vi.fn(async (a: { data: Record<string, unknown> }) => {
        created.push(a.data);
        return {
          ...a.data,
          uploadedAt: new Date('2026-08-13T00:00:00Z'),
          note: a.data.note ?? null,
        };
      }),
    },
  };

  const prisma = { client, currentTenantId: 'ten_1' } as unknown as PrismaService;
  const audit = { record: vi.fn() } as unknown as AuditLogService;
  const storage = {
    put: vi.fn().mockResolvedValue('key'),
    presignedGetUrl: vi.fn().mockResolvedValue('https://signed'),
  } as unknown as StorageService;

  const svc = new RequisitionAttachmentService(prisma, audit, storage);
  return { svc, pr, created, audit };
}

const file = {
  filename: 'pi.pdf',
  buffer: Buffer.from('%PDF-'),
  mimeType: 'application/pdf',
  sizeBytes: 5,
  docType: 'PROFORMA_INVOICE' as const,
  note: null,
};

describe('RequisitionAttachmentService — who may attach', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('before approval', () => {
    it.each(['DRAFT', 'BUDGET_BREACH_HELD', 'REJECTED'])(
      'lets the requester attach while %s',
      async (status) => {
        const { svc, pr } = build(status);
        expect(await svc.canAttach(pr, REQUESTER)).toBe(true);
      },
    );

    it('blocks an unrelated user on a draft', async () => {
      const { svc, pr } = build('DRAFT');
      expect(await svc.canAttach(pr, STRANGER)).toBe(false);
    });

    it('blocks an approver before the PR is submitted — it is not theirs yet', async () => {
      const { svc, pr } = build('DRAFT');
      expect(await svc.canAttach(pr, APPROVER)).toBe(false);
    });
  });

  describe('under review (AWAITING_APPROVAL)', () => {
    it('still lets the requester attach', async () => {
      const { svc, pr } = build('AWAITING_APPROVAL');
      expect(await svc.canAttach(pr, REQUESTER)).toBe(true);
    });

    it('lets an approver attach, so they can add a quote they asked for', async () => {
      const { svc, pr } = build('AWAITING_APPROVAL');
      expect(await svc.canAttach(pr, APPROVER)).toBe(true);
    });

    it('blocks an unrelated user', async () => {
      const { svc, pr } = build('AWAITING_APPROVAL');
      expect(await svc.canAttach(pr, STRANGER)).toBe(false);
    });
  });

  describe('after approval — the control this whole rule exists for', () => {
    it.each(['APPROVED', 'PARTIALLY_ISSUED', 'FULLY_ISSUED'])(
      'blocks the requesting officer once %s',
      async (status) => {
        const { svc, pr } = build(status);
        expect(await svc.canAttach(pr, REQUESTER)).toBe(false);
      },
    );

    it('still lets an approver on that PR attach', async () => {
      const { svc, pr } = build('APPROVED');
      expect(await svc.canAttach(pr, APPROVER)).toBe(true);
    });

    it('blocks an approver of a *different* PR', async () => {
      // approverIds empty → this user holds no step on this requisition.
      const { svc, pr } = build('APPROVED', { approverIds: [] });
      expect(await svc.canAttach(pr, APPROVER)).toBe(false);
    });

    it('rejects the officer upload with 403 and points them at their approver', async () => {
      const { svc } = build('APPROVED');
      await expect(svc.upload('pr_1', file, REQUESTER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('closed', () => {
    it.each(['CANCELLED', 'CLOSED'])('blocks everyone once %s', async (status) => {
      const { svc, pr } = build(status);
      expect(await svc.canAttach(pr, REQUESTER)).toBe(false);
      expect(await svc.canAttach(pr, APPROVER)).toBe(false);
      expect(await svc.canAttach(pr, ADMIN)).toBe(false);
    });

    it('rejects the upload as a state error, not a permission error', async () => {
      const { svc } = build('CLOSED');
      await expect(svc.upload('pr_1', file, ADMIN)).rejects.toBeInstanceOf(
        RequisitionStateError,
      );
    });
  });

  describe('tenant admin', () => {
    it('may attach post-approval', async () => {
      const { svc, pr } = build('APPROVED');
      expect(await svc.canAttach(pr, ADMIN)).toBe(true);
    });
  });
});

describe('RequisitionAttachmentService — added-after-approval flag', () => {
  beforeEach(() => vi.clearAllMocks());

  it('flags a post-approval upload and audits it under a distinct action', async () => {
    const { svc, created, audit } = build('APPROVED');
    const view = await svc.upload('pr_1', file, APPROVER);

    expect(created[0].addedAfterApproval).toBe(true);
    expect(view.addedAfterApproval).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'REQUISITION_ATTACHMENT_ADDED_AFTER_APPROVAL' }),
    );
  });

  it('does not flag an upload made while the PR is still a draft', async () => {
    const { svc, created, audit } = build('DRAFT');
    const view = await svc.upload('pr_1', file, REQUESTER);

    expect(created[0].addedAfterApproval).toBe(false);
    expect(view.addedAfterApproval).toBe(false);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'REQUISITION_ATTACHMENT_ADDED' }),
    );
  });

  it('stores the sha256 of the actual bytes as the integrity anchor', async () => {
    const { svc, created } = build('DRAFT');
    await svc.upload('pr_1', file, REQUESTER);
    const expected = createHash('sha256').update(file.buffer).digest('hex');
    expect(created[0].fileHash).toBe(expected);
  });
});
