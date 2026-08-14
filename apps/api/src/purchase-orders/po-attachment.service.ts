import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '@procureflow/db';
import type { PoAttachmentType, PoAttachmentView } from '@procureflow/shared';
import { createHash } from 'node:crypto';

import { AuditLogService } from '../audit/audit.service';
import { StorageService } from '../common/storage/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { PurchaseOrderStateError } from './purchase-order.errors';

/** PO states where the document set is sealed — nothing may be added. */
const CLOSED_STATES = new Set(['CANCELLED', 'CLOSED']);

/**
 * Once the order is out with the vendor, the quote it was priced from is part
 * of the record. A late document may still be added — a revised quote often
 * arrives after the fact — but it is flagged, never silently folded in.
 */
const POST_ISSUE_STATES = new Set([
  'ISSUED',
  'ACKNOWLEDGED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'PARTIALLY_INVOICED',
  'INVOICED',
]);

/** After issue nothing may be removed — deleting the quote rewrites history. */
const DELETE_LOCKED_STATES = new Set([...POST_ISSUE_STATES, 'CANCELLED', 'CLOSED']);

export interface PoAttachmentUpload {
  filename: string;
  buffer: Buffer;
  mimeType: string;
  sizeBytes: number;
  docType: PoAttachmentType;
  note: string | null;
}

/**
 * Purchase-order attachments — the offline vendor quote a spot buy is raised
 * against, plus any proforma, spec or email approval behind it.
 *
 * A PR-based PO inherits its evidence from the requisition. A spot buy has no
 * requisition, so without this the approver is asked to sign an order with
 * nothing behind the price at all.
 *
 * Buyer-side only. There is deliberately no vendor-portal route to this data:
 * a quote comparison or an internal note must never reach the supplier.
 *
 * Files are proxied through the API to S3 rather than uploaded direct from the
 * browser, matching the requisition and invoice paths.
 */
@Injectable()
export class PoAttachmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly storage: StorageService,
  ) {}

  async upload(
    poId: string,
    file: PoAttachmentUpload,
    actorId: string,
  ): Promise<PoAttachmentView> {
    const po = await this.requirePo(poId);
    if (CLOSED_STATES.has(po.status)) {
      throw new PurchaseOrderStateError(
        'This purchase order is closed — documents can no longer be added.',
        { status: po.status },
      );
    }
    const afterIssue = POST_ISSUE_STATES.has(po.status);

    const id = newId('purchaseOrderAttachment');
    const tenantId = this.tenantId();
    const s3Key = `purchase-orders/${tenantId}/${poId}/${id}-${file.filename}`;
    await this.storage.put(s3Key, file.buffer, file.mimeType);

    // sha256 of the actual bytes — lets an approver verify later that the quote
    // they are looking at is the one the PO was raised against.
    const fileHash = createHash('sha256').update(file.buffer).digest('hex');

    const row = await this.prisma.client.purchaseOrderAttachment.create({
      data: {
        id,
        tenantId,
        poId,
        s3Key,
        filename: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        fileHash,
        docType: file.docType,
        note: file.note,
        addedAfterIssue: afterIssue,
        uploadedBy: actorId,
      },
    });

    await this.audit.record({
      // Distinct action so a post-issue addition is greppable in the audit log
      // rather than buried behind an identical event name.
      action: afterIssue ? 'PO_ATTACHMENT_ADDED_AFTER_ISSUE' : 'PO_ATTACHMENT_ADDED',
      entityType: 'PurchaseOrder',
      entityId: poId,
      actorId,
      after: {
        attachmentId: id,
        filename: file.filename,
        docType: file.docType,
        fileHash,
        poStatus: po.status,
        addedAfterIssue: afterIssue,
      },
    });

    return this.toView(row, null);
  }

  async list(poId: string): Promise<PoAttachmentView[]> {
    const rows = await this.prisma.client.purchaseOrderAttachment.findMany({
      where: { poId },
      orderBy: { uploadedAt: 'asc' },
    });
    if (rows.length === 0) return [];

    const uploaders = await this.prisma.client.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.uploadedBy))] } },
      select: { id: true, name: true },
    });
    const nameById = new Map(uploaders.map((u) => [u.id, u.name]));

    return Promise.all(
      rows.map((r) => this.toView(r, nameById.get(r.uploadedBy) ?? null)),
    );
  }

  async remove(
    poId: string,
    attachmentId: string,
    actorId: string,
  ): Promise<{ ok: true }> {
    const po = await this.requirePo(poId);
    if (DELETE_LOCKED_STATES.has(po.status)) {
      throw new PurchaseOrderStateError(
        'Documents on an issued purchase order cannot be removed.',
        { status: po.status },
      );
    }

    const row = await this.prisma.client.purchaseOrderAttachment.findFirst({
      where: { id: attachmentId, poId },
    });
    if (!row) throw new NotFoundException('Attachment not found');
    if (row.uploadedBy !== actorId && !(await this.isTenantAdmin(actorId))) {
      throw new ForbiddenException(
        'Only the uploader or a tenant admin may remove this document.',
      );
    }

    // The S3 object is deliberately left in place: the audit row references the
    // key, and orphan cleanup is a bucket-lifecycle concern, not a request path.
    await this.prisma.client.purchaseOrderAttachment.delete({
      where: { id: attachmentId },
    });
    await this.audit.record({
      action: 'PO_ATTACHMENT_REMOVED',
      entityType: 'PurchaseOrder',
      entityId: poId,
      actorId,
      before: { attachmentId, filename: row.filename, s3Key: row.s3Key },
    });
    return { ok: true };
  }

  private async toView(
    row: {
      id: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
      docType: string;
      note: string | null;
      addedAfterIssue: boolean;
      uploadedAt: Date;
      uploadedBy: string;
      s3Key: string;
    },
    uploadedByName: string | null,
  ): Promise<PoAttachmentView> {
    return {
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      docType: row.docType as PoAttachmentType,
      note: row.note,
      addedAfterIssue: row.addedAfterIssue,
      uploadedAt: row.uploadedAt.toISOString(),
      uploadedBy: row.uploadedBy,
      uploadedByName,
      // Signing is per-object; one failure must not blank the whole list.
      url: await this.storage.presignedGetUrl(row.s3Key).catch(() => ''),
    };
  }

  private async requirePo(id: string): Promise<{ id: string; status: string }> {
    const po = await this.prisma.client.purchaseOrder.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    return po;
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
