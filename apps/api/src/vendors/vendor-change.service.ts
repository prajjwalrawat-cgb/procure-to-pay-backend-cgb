import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import {
  VENDOR_EVENTS,
  type ChangeRequestType,
  type VendorChangeRequestInput,
} from '@procureflow/shared';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import { AuditLogService } from '../audit/audit.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { VendorVerificationService } from './vendor-verification.service';

/** Which change types need re-verification / approval (spec §7). */
const REVERIFY: Record<ChangeRequestType, boolean> = {
  BANK_CHANGE: true,
  GSTIN_CHANGE: true,
  OWNERSHIP_CHANGE: true,
  CATEGORY_ADD: false,
  CONTACT_UPDATE: false,
};
const NEEDS_APPROVAL: Record<ChangeRequestType, boolean> = {
  BANK_CHANGE: true,
  GSTIN_CHANGE: true,
  OWNERSHIP_CHANGE: true,
  CATEGORY_ADD: false,
  CONTACT_UPDATE: false,
};

/**
 * VendorChangeService (Slice 7 §7). Post-activation self-service changes.
 * Non-material updates auto-approve; material ones (bank/GSTIN/ownership) route
 * through the Slice 2 engine (VENDOR_CHANGE) and re-trigger verification on
 * approval — the old value is archived, never deleted.
 */
@Injectable()
export class VendorChangeService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
    private readonly routing: ApprovalRoutingService,
    private readonly verification: VendorVerificationService,
  ) {}

  onModuleInit(): void {
    // Material changes route through the Slice 2 engine; apply on full approval.
    this.routing.onApproved('VENDOR_CHANGE', (changeRequestId, actorId) =>
      this.applyChange(changeRequestId, actorId),
    );
  }

  async requestChange(
    vendorId: string,
    input: VendorChangeRequestInput,
    actorId: string,
  ): Promise<{ id: string; status: string }> {
    const vendor = await this.prisma.client.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      include: { banks: { where: { isArchived: false } } },
    });
    const currentValues = this.snapshot(input.requestType, vendor);
    const id = newId('vendorChangeRequest');
    const autoApprove = !NEEDS_APPROVAL[input.requestType];
    await this.prisma.client.vendorChangeRequest.create({
      data: {
        id,
        tenantId: vendor.tenantId,
        vendorId,
        requestedBy: actorId,
        requestType: input.requestType,
        proposedChanges: input.proposedChanges as Prisma.InputJsonValue,
        currentValues: currentValues as Prisma.InputJsonValue,
        status: autoApprove ? 'AUTO_APPROVED' : 'PENDING',
        requiresReverification: REVERIFY[input.requestType],
      },
    });
    await this.audit.record({
      action: 'VENDOR_CHANGE_REQUESTED',
      entityType: 'Vendor',
      entityId: vendorId,
      actorId,
      after: { requestType: input.requestType, autoApprove },
    });
    await this.events.emit(VENDOR_EVENTS.VENDOR_CHANGE_REQUESTED, {
      vendorId,
      changeRequestId: id,
      requestType: input.requestType,
    });
    if (autoApprove) {
      await this.applyChange(id, actorId);
      return { id, status: 'AUTO_APPROVED' };
    }
    await this.routing.submit('VENDOR_CHANGE', id, actorId);
    return { id, status: 'PENDING' };
  }

  /** Fired by the approval engine when a material change is fully approved. */
  private async applyChange(changeRequestId: string, actorId: string): Promise<void> {
    const cr = await this.prisma.client.vendorChangeRequest.findUniqueOrThrow({
      where: { id: changeRequestId },
    });
    await this.prisma.client.vendorChangeRequest.update({
      where: { id: changeRequestId },
      data: { decidedBy: actorId, decidedAt: new Date() },
    });
    const proposed = cr.proposedChanges as Record<string, unknown>;
    if (cr.requestType === 'CONTACT_UPDATE') {
      const contact = await this.prisma.client.vendorContact.findFirst({
        where: { vendorId: cr.vendorId, isPrimary: true },
      });
      if (contact) {
        await this.prisma.client.vendorContact.update({
          where: { id: contact.id },
          data: {
            phone: (proposed.phone as string | undefined) ?? contact.phone,
            // Lowercased: every vendor-portal route resolves the vendor by
            // matching this address against `User.email` exactly, so a capital
            // stored here would silently detach the supplier from their own
            // records. `proposedChanges` is free-form JSON with no zod pass,
            // which is why the normalisation has to happen at the write.
            email:
              (proposed.email as string | undefined)?.trim().toLowerCase() ??
              contact.email,
          },
        });
      }
    } else if (cr.requestType === 'BANK_CHANGE') {
      // Archive existing banks; add the new one; re-run penny-drop.
      await this.prisma.client.vendorBank.updateMany({
        where: { vendorId: cr.vendorId, isArchived: false },
        data: { isArchived: true },
      });
      const holderName = String(proposed.holderName ?? proposed.accountHolderName ?? '');
      const accountNumber = String(proposed.accountNumber ?? '');
      const { registeredName, matchScore } = this.verification.pennyDrop(
        holderName,
        accountNumber,
      );
      const vendor = await this.prisma.client.vendor.findUniqueOrThrow({
        where: { id: cr.vendorId },
      });
      await this.prisma.client.vendorBank.create({
        data: {
          id: newId('vendorBank'),
          tenantId: vendor.tenantId,
          vendorId: cr.vendorId,
          bankName: String(proposed.bankName ?? ''),
          accountNoEncrypted: `enc:xxxx${accountNumber.slice(-4)}`,
          ifsc: String(proposed.ifsc ?? ''),
          holderName,
          pennyDropCreditedAt: new Date(),
          pennyDropNameReturned: registeredName,
          nameMatchScore: new Prisma.Decimal(matchScore),
          nameMatchAlgorithm: 'HYBRID',
          isVerified: matchScore >= 0.85,
          verifiedAt: matchScore >= 0.85 ? new Date() : null,
        },
      });
    } else if (cr.requestType === 'GSTIN_CHANGE') {
      await this.prisma.client.vendor.update({
        where: { id: cr.vendorId },
        data: { gstin: String(proposed.gstin ?? '') },
      });
      await this.verification.runScreening(cr.vendorId, 'GSTIN_STATUS', actorId);
    }
    await this.audit.record({
      action: 'VENDOR_CHANGE_APPLIED',
      entityType: 'Vendor',
      entityId: cr.vendorId,
      actorId,
      after: { requestType: cr.requestType },
    });
  }

  private snapshot(
    type: ChangeRequestType,
    vendor: Prisma.VendorGetPayload<{ include: { banks: true } }>,
  ): Record<string, unknown> {
    if (type === 'BANK_CHANGE') {
      const bank = vendor.banks[0];
      return bank
        ? { bankName: bank.bankName, ifsc: bank.ifsc, holderName: bank.holderName }
        : {};
    }
    if (type === 'GSTIN_CHANGE') return { gstin: vendor.gstin };
    return {};
  }
}
