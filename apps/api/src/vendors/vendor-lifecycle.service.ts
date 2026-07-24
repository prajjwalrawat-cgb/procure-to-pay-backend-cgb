import { Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '@procureflow/db';
import {
  VENDOR_EVENTS,
  type BlacklistVendorInput,
  type SuspendVendorInput,
} from '@procureflow/shared';

import { AuditLogService } from '../audit/audit.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { NotificationService } from '../approvals/notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { CosignRequiredError, VendorStateError } from './vendor.errors';

/**
 * VendorLifecycleService (Slice 7 §2, ADR-023). Suspend / lift / blacklist.
 * Vendors are never deleted — suspension blocks new POs but existing POs
 * continue; blacklist is terminal and requires MD + LEGAL_OFFICER co-sign.
 */
@Injectable()
export class VendorLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
    private readonly notifications: NotificationService,
  ) {}

  async suspendVendor(
    vendorId: string,
    input: SuspendVendorInput,
    actorId: string,
  ): Promise<{ id: string }> {
    const vendor = await this.prisma.client.vendor.findUniqueOrThrow({
      where: { id: vendorId },
    });
    if (vendor.lifecycleStatus === 'BLACKLISTED') {
      throw new VendorStateError('A blacklisted vendor cannot be suspended.');
    }
    const id = newId('vendorSuspension');
    await this.prisma.client.vendorSuspension.create({
      data: {
        id,
        tenantId: vendor.tenantId,
        vendorId,
        suspensionType: input.suspensionType,
        reasonCode: input.reasonCode,
        reasonNotes: input.reasonNotes,
        imposedBy: actorId,
        effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : new Date(),
        effectiveUntil: input.effectiveUntil ? new Date(input.effectiveUntil) : null,
        liftConditions: input.liftConditions ?? null,
      },
    });
    await this.prisma.client.vendor.update({
      where: { id: vendorId },
      data: {
        lifecycleStatus: 'SUSPENDED',
        status: 'SUSPENDED',
        suspensionReason: input.reasonNotes,
        suspendedBy: actorId,
        suspendedAt: new Date(),
      },
    });
    // Cancel active RFQ invitations (open RFQs). Existing POs continue.
    await this.prisma.client.rfqInvitation.updateMany({
      where: { vendorId, status: { in: ['INVITED', 'ACKNOWLEDGED'] } },
      data: { status: 'DECLINED', declineReason: 'Vendor suspended' },
    });
    await this.notifyVendorUser(vendorId, 'Your vendor account has been suspended');
    await this.audit.record({
      action: 'VENDOR_SUSPENDED',
      entityType: 'Vendor',
      entityId: vendorId,
      actorId,
      after: { reasonCode: input.reasonCode, type: input.suspensionType },
    });
    await this.events.emit(VENDOR_EVENTS.VENDOR_SUSPENDED, {
      vendorId,
      suspensionId: id,
      reasonCode: input.reasonCode,
      type: input.suspensionType,
    });
    return { id };
  }

  async liftSuspension(
    suspensionId: string,
    liftReason: string,
    actorId: string,
  ): Promise<{ ok: true }> {
    const suspension = await this.prisma.client.vendorSuspension.findUnique({
      where: { id: suspensionId },
    });
    if (!suspension) throw new NotFoundException('Suspension not found');
    if (!suspension.isActive)
      throw new VendorStateError('This suspension is already lifted.');
    if (suspension.suspensionType === 'BLACKLIST') {
      throw new VendorStateError('A blacklist can only be overturned by the MD.');
    }
    await this.prisma.client.vendorSuspension.update({
      where: { id: suspensionId },
      data: { isActive: false, liftedBy: actorId, liftedAt: new Date(), liftReason },
    });
    await this.prisma.client.vendor.update({
      where: { id: suspension.vendorId },
      data: {
        lifecycleStatus: 'ACTIVE',
        status: 'ACTIVE',
        suspensionReason: null,
        suspendedAt: null,
        suspendedBy: null,
      },
    });
    await this.audit.record({
      action: 'VENDOR_SUSPENSION_LIFTED',
      entityType: 'Vendor',
      entityId: suspension.vendorId,
      actorId,
      after: { suspensionId, liftReason },
    });
    return { ok: true };
  }

  async blacklistVendor(
    vendorId: string,
    input: BlacklistVendorInput,
    actorId: string,
  ): Promise<{ id: string }> {
    const isMd = await this.hasRole(actorId, 'MD');
    if (!isMd) throw new VendorStateError('Only the MD may blacklist a vendor.');
    // Co-sign: a LEGAL_OFFICER must co-sign.
    if (!input.cosignerId) {
      throw new CosignRequiredError('Blacklisting requires a LEGAL_OFFICER co-sign.', {
        need: 'LEGAL_OFFICER',
      });
    }
    // Four-eyes: the co-signer must be a different person, so a single user who
    // happens to hold both MD and LEGAL_OFFICER cannot self-cosign a blacklist.
    if (input.cosignerId === actorId) {
      throw new CosignRequiredError(
        'The co-signer must be a different person from the MD imposing the blacklist.',
      );
    }
    const cosignerIsLegal = await this.hasRole(input.cosignerId, 'LEGAL_OFFICER');
    if (!cosignerIsLegal) {
      throw new CosignRequiredError('The co-signer must be a LEGAL_OFFICER.');
    }
    const vendor = await this.prisma.client.vendor.findUniqueOrThrow({
      where: { id: vendorId },
    });
    const id = newId('vendorSuspension');
    await this.prisma.client.vendorSuspension.create({
      data: {
        id,
        tenantId: vendor.tenantId,
        vendorId,
        suspensionType: 'BLACKLIST',
        reasonCode: 'COMPLIANCE_BREACH',
        reasonNotes: input.reasonNotes,
        imposedBy: actorId,
        cosignedBy: input.cosignerId,
      },
    });
    await this.prisma.client.vendor.update({
      where: { id: vendorId },
      data: {
        lifecycleStatus: 'BLACKLISTED',
        status: 'BLOCKED',
        blacklistReason: input.reasonNotes,
        blacklistedBy: actorId,
        blacklistedAt: new Date(),
      },
    });
    // Cancel active RFQ invitations (parity with suspend) — a blacklisted vendor
    // must not remain live on any open RFQ.
    await this.prisma.client.rfqInvitation.updateMany({
      where: { vendorId, status: { in: ['INVITED', 'ACKNOWLEDGED'] } },
      data: { status: 'DECLINED', declineReason: 'Vendor blacklisted' },
    });
    await this.audit.record({
      action: 'VENDOR_BLACKLISTED',
      entityType: 'Vendor',
      entityId: vendorId,
      actorId,
      after: { cosignedBy: input.cosignerId, reason: input.reasonNotes },
    });
    await this.events.emit(VENDOR_EVENTS.VENDOR_BLACKLISTED, {
      vendorId,
      suspensionId: id,
    });
    return { id };
  }

  private async hasRole(userId: string, roleName: string): Promise<boolean> {
    const count = await this.prisma.client.userRole.count({
      where: { userId, role: { name: roleName } },
    });
    return count > 0;
  }

  private async notifyVendorUser(vendorId: string, title: string): Promise<void> {
    const contact = await this.prisma.client.vendorContact.findFirst({
      where: { vendorId, isPrimary: true },
      select: { email: true },
    });
    if (!contact?.email) return;
    const user = await this.prisma.client.user.findFirst({
      where: { tenantId: this.prisma.currentTenantId ?? undefined, email: contact.email },
      select: { id: true },
    });
    if (!user) return;
    await this.notifications.notify({
      userId: user.id,
      type: 'VENDOR_LIFECYCLE',
      title,
      entityType: 'Vendor',
      entityId: vendorId,
      href: '/profile',
    });
  }
}
