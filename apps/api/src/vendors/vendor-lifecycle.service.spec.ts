import { describe, expect, it, vi } from 'vitest';

import type { NotificationService } from '../approvals/notification.service';
import type { AuditLogService } from '../audit/audit.service';
import type { DomainEventService } from '../common/events/domain-event.service';
import type { PrismaService } from '../prisma/prisma.service';
import { CosignRequiredError, VendorStateError } from './vendor.errors';
import { VendorLifecycleService } from './vendor-lifecycle.service';

/**
 * Roles keyed by "userId:roleName" → count. Lets a single mock resolve both the
 * MD check and the LEGAL_OFFICER co-sign check.
 */
function makeService(roles: Record<string, number>): {
  svc: VendorLifecycleService;
  rfqUpdateMany: ReturnType<typeof vi.fn>;
} {
  const rfqUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
  const prisma = {
    currentTenantId: 'ten_1',
    client: {
      vendor: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: 'ven_1',
          tenantId: 'ten_1',
          lifecycleStatus: 'ACTIVE',
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      vendorSuspension: { create: vi.fn().mockResolvedValue({}) },
      rfqInvitation: { updateMany: rfqUpdateMany },
      userRole: {
        count: vi
          .fn()
          .mockImplementation(
            (args: { where: { userId: string; role: { name: string } } }) => {
              const key = `${args.where.userId}:${args.where.role.name}`;
              return Promise.resolve(roles[key] ?? 0);
            },
          ),
      },
    },
  } as unknown as PrismaService;
  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuditLogService;
  const events = {
    emit: vi.fn().mockResolvedValue(undefined),
  } as unknown as DomainEventService;
  const notifications = {
    notify: vi.fn().mockResolvedValue(undefined),
  } as unknown as NotificationService;
  const svc = new VendorLifecycleService(prisma, audit, events, notifications);
  return { svc, rfqUpdateMany };
}

describe('VendorLifecycleService.blacklistVendor', () => {
  it('rejects a non-MD actor', async () => {
    const { svc } = makeService({});
    await expect(
      svc.blacklistVendor('ven_1', { reasonNotes: 'fraud' }, 'usr_officer'),
    ).rejects.toBeInstanceOf(VendorStateError);
  });

  it('requires a co-signer when the actor is the MD', async () => {
    const { svc } = makeService({ 'usr_md:MD': 1 });
    await expect(
      svc.blacklistVendor('ven_1', { reasonNotes: 'fraud' }, 'usr_md'),
    ).rejects.toBeInstanceOf(CosignRequiredError);
  });

  it('rejects a co-signer who is the same person as the MD (four-eyes)', async () => {
    // usr_md holds both MD and LEGAL_OFFICER, but cannot co-sign their own action.
    const { svc } = makeService({ 'usr_md:MD': 1, 'usr_md:LEGAL_OFFICER': 1 });
    await expect(
      svc.blacklistVendor(
        'ven_1',
        { reasonNotes: 'fraud', cosignerId: 'usr_md' },
        'usr_md',
      ),
    ).rejects.toBeInstanceOf(CosignRequiredError);
  });

  it('requires the co-signer to be a LEGAL_OFFICER', async () => {
    const { svc } = makeService({ 'usr_md:MD': 1, 'usr_x:LEGAL_OFFICER': 0 });
    await expect(
      svc.blacklistVendor(
        'ven_1',
        { reasonNotes: 'fraud', cosignerId: 'usr_x' },
        'usr_md',
      ),
    ).rejects.toBeInstanceOf(CosignRequiredError);
  });

  it('blacklists (and cancels open RFQ invitations) when the MD acts with a distinct LEGAL_OFFICER co-sign', async () => {
    const { svc, rfqUpdateMany } = makeService({
      'usr_md:MD': 1,
      'usr_legal:LEGAL_OFFICER': 1,
    });
    const result = await svc.blacklistVendor(
      'ven_1',
      { reasonNotes: 'fraud', cosignerId: 'usr_legal' },
      'usr_md',
    );
    expect(result.id).toBeTruthy();
    // Cascade parity with suspend: open invitations are declined.
    expect(rfqUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { vendorId: 'ven_1', status: { in: ['INVITED', 'ACKNOWLEDGED'] } },
        data: expect.objectContaining({ status: 'DECLINED' }),
      }),
    );
  });
});
