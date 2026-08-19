import { Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '@procureflow/db';
import {
  ONBOARDING_MANDATORY_DOCUMENTS,
  VENDOR_EVENTS,
  categoryConfig,
  type VendorDocumentUpload,
} from '@procureflow/shared';

import { AuditLogService } from '../audit/audit.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { NotificationService } from '../approvals/notification.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * VendorDocumentService (Slice 7 §4). Upload (with ClamAV virus scan — stubbed
 * in Slice 7), auto/manual verification, and a nightly expiry job that warns
 * 30 days out and auto-suspends the vendor when a mandatory document expires.
 */
@Injectable()
export class VendorDocumentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * @param confirmed Whether something outside the file agreed it is the
   *   document it was filed as — the registry accepted its GSTIN, the PAN
   *   matched, the IFSC resolved (see DocumentExtractionResult.confirmsDocument).
   *
   *   This used to be a list of document *types*: anything filed as a PAN card
   *   was stamped AUTO_VERIFIED on arrival, whatever the file contained. A blank
   *   page earned the same green badge as a real card, and a reviewer had no way
   *   to tell them apart. Verification is now something a document earns, and a
   *   file nobody could check waits for a human.
   */
  async uploadDocument(
    vendorId: string,
    input: VendorDocumentUpload,
    actorId: string,
    confirmed = false,
  ): Promise<{ id: string }> {
    const vendor = await this.prisma.client.vendor.findUniqueOrThrow({
      where: { id: vendorId },
    });
    // ClamAV virus scan (docker-compose service) is stubbed in Slice 7 — assume clean.
    const autoVerified = confirmed;
    const id = newId('vendorDocument');
    await this.prisma.client.vendorDocument.create({
      data: {
        id,
        tenantId: vendor.tenantId,
        vendorId,
        docType: input.docType,
        s3Key: input.s3Key,
        filename: input.filename,
        sizeBytes: input.sizeBytes,
        fileHash: input.fileHash,
        mimeType: input.mimeType,
        documentNumber: input.documentNumber ?? null,
        validFrom: input.validFrom ? new Date(input.validFrom) : null,
        validTo: input.validTo ? new Date(input.validTo) : null,
        uploadedBy: actorId,
        uploadedAt: new Date(),
        verificationStatus: autoVerified ? 'AUTO_VERIFIED' : 'PENDING',
        verificationSource: autoVerified ? 'AUTO_API' : null,
        verifiedAt: autoVerified ? new Date() : null,
      },
    });
    await this.audit.record({
      action: 'VENDOR_DOCUMENT_UPLOADED',
      entityType: 'Vendor',
      entityId: vendorId,
      actorId,
      after: { docType: input.docType, autoVerified },
    });
    return { id };
  }

  async verifyDocument(
    docId: string,
    decision: 'VERIFIED' | 'REJECTED',
    reason: string | null,
    actorId: string,
  ): Promise<{ ok: true }> {
    const doc = await this.prisma.client.vendorDocument.findUnique({
      where: { id: docId },
    });
    if (!doc) throw new NotFoundException('Document not found');
    await this.prisma.client.vendorDocument.update({
      where: { id: docId },
      data: {
        verificationStatus: decision === 'VERIFIED' ? 'MANUALLY_VERIFIED' : 'FAILED',
        verificationSource: 'MANUAL_REVIEW',
        verifiedBy: actorId,
        verifiedAt: new Date(),
        rejectionReason: decision === 'REJECTED' ? reason : null,
      },
    });
    await this.audit.record({
      action: 'VENDOR_DOCUMENT_VERIFIED',
      entityType: 'Vendor',
      entityId: doc.vendorId,
      actorId,
      after: { docId, decision },
    });
    return { ok: true };
  }

  /**
   * Nightly expiry scan. Warns on documents within 30 days of expiry and, once
   * a mandatory (category-required) document is past its validTo, marks it
   * EXPIRED and auto-suspends the vendor with reason DOC_EXPIRED.
   */
  async expireCheck(
    tenantId: string,
  ): Promise<{ warned: number; expired: number; suspended: number }> {
    const now = new Date();
    const soon = new Date(now.getTime() + 30 * 86_400_000);
    let warned = 0;
    let expired = 0;
    let suspended = 0;

    const docs = await this.prisma.client.vendorDocument.findMany({
      where: { tenantId, validTo: { not: null, lte: soon } },
      include: { vendor: true },
    });
    for (const doc of docs) {
      if (!doc.validTo) continue;
      if (doc.validTo.getTime() < now.getTime()) {
        if (doc.verificationStatus !== 'EXPIRED') {
          await this.prisma.client.vendorDocument.update({
            where: { id: doc.id },
            data: { verificationStatus: 'EXPIRED' },
          });
          expired += 1;
          const mandatory = this.isMandatory(doc.vendor.categoryConfigKey, doc.docType);
          await this.events.emit(VENDOR_EVENTS.DOCUMENT_EXPIRED, {
            vendorId: doc.vendorId,
            documentId: doc.id,
            docType: doc.docType,
            wasMandatory: mandatory,
          });
          if (mandatory && doc.vendor.lifecycleStatus === 'ACTIVE') {
            await this.autoSuspend(doc.vendorId, doc.docType);
            suspended += 1;
          }
        }
      } else {
        const daysRemaining = Math.ceil(
          (doc.validTo.getTime() - now.getTime()) / 86_400_000,
        );
        await this.prisma.client.vendorDocument.update({
          where: { id: doc.id },
          data: { reminderSentAt: now },
        });
        await this.events.emit(VENDOR_EVENTS.DOCUMENT_EXPIRING_WARNING, {
          vendorId: doc.vendorId,
          documentId: doc.id,
          docType: doc.docType,
          validTo: doc.validTo.toISOString(),
          daysRemaining,
        });
        warned += 1;
      }
    }
    return { warned, expired, suspended };
  }

  /**
   * Whether an expired document is serious enough to suspend the vendor over.
   *
   * The union of the two "required" sets: everything onboarding makes mandatory
   * for every vendor, plus whatever their category additionally asks for. A
   * category document is only ever on file because it was asked for, so letting
   * it lapse still matters even though it no longer blocks submission.
   */
  private isMandatory(categoryKey: string | null, docType: string): boolean {
    if (ONBOARDING_MANDATORY_DOCUMENTS.includes(docType as never)) return true;
    const config = categoryKey ? categoryConfig(categoryKey) : undefined;
    return config ? config.requiredDocuments.includes(docType as never) : false;
  }

  private async autoSuspend(vendorId: string, docType: string): Promise<void> {
    const vendor = await this.prisma.client.vendor.findUniqueOrThrow({
      where: { id: vendorId },
    });
    await this.prisma.client.vendorSuspension.create({
      data: {
        id: newId('vendorSuspension'),
        tenantId: vendor.tenantId,
        vendorId,
        suspensionType: 'TEMPORARY',
        reasonCode: 'DOC_EXPIRED',
        reasonNotes: `Mandatory document ${docType} expired`,
        imposedBy: 'system',
        liftConditions: 'Upload a renewed, verified document',
      },
    });
    await this.prisma.client.vendor.update({
      where: { id: vendorId },
      data: {
        lifecycleStatus: 'SUSPENDED',
        status: 'SUSPENDED',
        suspensionReason: `DOC_EXPIRED:${docType}`,
        suspendedAt: new Date(),
        suspendedBy: 'system',
      },
    });
    await this.audit.record({
      action: 'VENDOR_AUTO_SUSPENDED',
      entityType: 'Vendor',
      entityId: vendorId,
      actorType: 'SYSTEM',
      after: { reason: 'DOC_EXPIRED', docType },
    });
  }
}
