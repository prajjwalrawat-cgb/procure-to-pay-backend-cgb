import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '@procureflow/db';
import type {
  RequisitionAttachmentType,
  RequisitionAttachmentView,
} from '@procureflow/shared';
import { createHash } from 'node:crypto';

import { AuditLogService } from '../audit/audit.service';
import { StorageService } from '../common/storage/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { RequisitionStateError } from './requisition.errors';

/** PR states where the document set is sealed — nothing may be added. */
const CLOSED_STATES = new Set(['CANCELLED', 'CLOSED']);

/**
 * Approval is done: the document set is now the evidence the approver acted on.
 * A late document (typically a vendor PI) may still be added, but only by one of
 * the PR's own approvers — never by the requesting officer, who could otherwise
 * change what the approval appears to rest on without the approver knowing.
 */
const POST_APPROVAL_STATES = new Set([
  'APPROVED',
  'PARTIALLY_ISSUED',
  'FULLY_ISSUED',
]);

/**
 * Once approved, attachments may no longer be removed at all — deleting the
 * quote an approver relied on would rewrite history.
 */
const DELETE_LOCKED_STATES = new Set([
  'APPROVED',
  'PARTIALLY_ISSUED',
  'FULLY_ISSUED',
  'CANCELLED',
  'CLOSED',
]);

export interface AttachmentUpload {
  filename: string;
  buffer: Buffer;
  mimeType: string;
  sizeBytes: number;
  docType: RequisitionAttachmentType;
  note: string | null;
}

/**
 * Requisition attachments — quotes, proforma invoices, specs and drawings.
 *
 * Files are proxied through the API to S3 rather than uploaded direct from the
 * browser with a presigned PUT, matching the vendor-onboarding and invoice
 * paths: a presigned PUT would need CORS on the bucket, and these documents are
 * small enough that proxying costs nothing.
 */
@Injectable()
export class RequisitionAttachmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly storage: StorageService,
  ) {}

  async upload(
    requisitionId: string,
    file: AttachmentUpload,
    actorId: string,
  ): Promise<RequisitionAttachmentView> {
    const pr = await this.requirePr(requisitionId);
    await this.assertMayAttach(pr, actorId);
    const afterApproval = POST_APPROVAL_STATES.has(pr.status);

    const id = newId('requisitionAttachment');
    const tenantId = this.tenantId();
    const s3Key = `requisitions/${tenantId}/${requisitionId}/${id}-${file.filename}`;
    await this.storage.put(s3Key, file.buffer, file.mimeType);

    // sha256 of the actual bytes — lets an approver verify later that the PI
    // they are looking at is the one that was attached.
    const fileHash = createHash('sha256').update(file.buffer).digest('hex');

    const row = await this.prisma.client.requisitionAttachment.create({
      data: {
        id,
        tenantId,
        requisitionId,
        s3Key,
        filename: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        fileHash,
        docType: file.docType,
        note: file.note,
        addedAfterApproval: afterApproval,
        uploadedBy: actorId,
      },
    });

    await this.audit.record({
      // A distinct action so a post-approval addition is greppable in the audit
      // log rather than buried behind an identical event name.
      action: afterApproval
        ? 'REQUISITION_ATTACHMENT_ADDED_AFTER_APPROVAL'
        : 'REQUISITION_ATTACHMENT_ADDED',
      entityType: 'Requisition',
      entityId: requisitionId,
      actorId,
      after: {
        attachmentId: id,
        filename: file.filename,
        docType: file.docType,
        fileHash,
        prStatus: pr.status,
        addedAfterApproval: afterApproval,
      },
    });

    return {
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      docType: row.docType as RequisitionAttachmentType,
      note: row.note,
      addedAfterApproval: row.addedAfterApproval,
      uploadedAt: row.uploadedAt.toISOString(),
      uploadedBy: row.uploadedBy,
      uploadedByName: null,
      url: await this.storage.presignedGetUrl(s3Key).catch(() => ''),
    };
  }

  async list(requisitionId: string): Promise<RequisitionAttachmentView[]> {
    const rows = await this.prisma.client.requisitionAttachment.findMany({
      where: { requisitionId },
      orderBy: { uploadedAt: 'asc' },
    });
    if (rows.length === 0) return [];

    const uploaders = await this.prisma.client.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.uploadedBy))] } },
      select: { id: true, name: true },
    });
    const nameById = new Map(uploaders.map((u) => [u.id, u.name]));

    return Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        filename: r.filename,
        mimeType: r.mimeType,
        sizeBytes: r.sizeBytes,
        docType: r.docType as RequisitionAttachmentType,
        note: r.note,
        addedAfterApproval: r.addedAfterApproval,
        uploadedAt: r.uploadedAt.toISOString(),
        uploadedBy: r.uploadedBy,
        uploadedByName: nameById.get(r.uploadedBy) ?? null,
        // Signing is per-object; one failure must not blank the whole list.
        url: await this.storage.presignedGetUrl(r.s3Key).catch(() => ''),
      })),
    );
  }

  async remove(
    requisitionId: string,
    attachmentId: string,
    actorId: string,
  ): Promise<{ ok: true }> {
    const pr = await this.requirePr(requisitionId);
    if (DELETE_LOCKED_STATES.has(pr.status)) {
      throw new RequisitionStateError(
        'Attachments on an approved requisition cannot be removed.',
        { status: pr.status },
      );
    }

    const row = await this.prisma.client.requisitionAttachment.findFirst({
      where: { id: attachmentId, requisitionId },
    });
    if (!row) throw new NotFoundException('Attachment not found');
    if (row.uploadedBy !== actorId && !(await this.isTenantAdmin(actorId))) {
      throw new ForbiddenException(
        'Only the uploader or a tenant admin may remove this attachment.',
      );
    }

    // The S3 object is deliberately left in place: the audit row references the
    // key, and orphan cleanup is a bucket-lifecycle concern, not a request path.
    await this.prisma.client.requisitionAttachment.delete({ where: { id: attachmentId } });
    await this.audit.record({
      action: 'REQUISITION_ATTACHMENT_REMOVED',
      entityType: 'Requisition',
      entityId: requisitionId,
      actorId,
      before: { attachmentId, filename: row.filename, s3Key: row.s3Key },
    });
    return { ok: true };
  }

  /**
   * Who may attach, by PR state:
   *   DRAFT / BUDGET_BREACH_HELD / REJECTED → the requester (still theirs to build)
   *   AWAITING_APPROVAL                     → requester *and* its approvers, so
   *                                           an approver can ask for a missing
   *                                           quote mid-review
   *   APPROVED / *_ISSUED                   → its approvers only
   *   CANCELLED / CLOSED                    → nobody
   * TENANT_ADMIN is allowed throughout except on a closed PR.
   */
  async canAttach(
    pr: { id: string; status: string; requesterId: string },
    userId: string,
  ): Promise<boolean> {
    if (CLOSED_STATES.has(pr.status)) return false;
    if (await this.isTenantAdmin(userId)) return true;

    if (POST_APPROVAL_STATES.has(pr.status)) return this.isApproverOf(pr.id, userId);
    if (pr.status === 'AWAITING_APPROVAL') {
      return pr.requesterId === userId || (await this.isApproverOf(pr.id, userId));
    }
    return pr.requesterId === userId;
  }

  private async assertMayAttach(
    pr: { id: string; status: string; requesterId: string },
    userId: string,
  ): Promise<void> {
    if (await this.canAttach(pr, userId)) return;

    if (CLOSED_STATES.has(pr.status)) {
      throw new RequisitionStateError(
        'This requisition is closed — attachments can no longer be added.',
        { status: pr.status },
      );
    }
    if (POST_APPROVAL_STATES.has(pr.status)) {
      throw new ForbiddenException(
        'This requisition is already approved — only an approver on it may attach further documents. Send the file to your approver instead.',
      );
    }
    throw new ForbiddenException(
      'Only the requester or an approver on this requisition may attach documents.',
    );
  }

  /** Anyone holding an approval step on this PR, decided or still pending. */
  private async isApproverOf(requisitionId: string, userId: string): Promise<boolean> {
    const step = await this.prisma.client.approval.findFirst({
      where: {
        documentType: 'REQUISITION',
        documentId: requisitionId,
        approverId: userId,
      },
      select: { id: true },
    });
    return step !== null;
  }

  private async requirePr(
    id: string,
  ): Promise<{ id: string; status: string; requesterId: string }> {
    const pr = await this.prisma.client.requisition.findUnique({
      where: { id },
      select: { id: true, status: true, requesterId: true },
    });
    if (!pr) throw new NotFoundException('Requisition not found');
    return pr;
  }

  private async isTenantAdmin(userId: string): Promise<boolean> {
    const roles = await this.prisma.client.userRole.findMany({
      where: { userId },
      include: { role: true },
    });
    return roles.some((r) => r.role.name === 'TENANT_ADMIN');
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
