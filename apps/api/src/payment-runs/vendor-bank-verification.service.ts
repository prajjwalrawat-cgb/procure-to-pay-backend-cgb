import { Injectable, NotFoundException } from '@nestjs/common';

import { AuditLogService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

export interface PennyDropResult {
  ok: boolean;
  reference: string | null;
  reason: string | null;
}

/**
 * Vendor bank penny-drop verification (Slice 3 — mocked). A real NPCI/bank
 * penny-drop lands in a later slice. The stub verifies every bank except those
 * seeded with `pennyDropRef = 'STUB_FAIL'`, which exist to prove the failure UX.
 * The composer refuses to add invoices whose vendor bank is unverified.
 */
@Injectable()
export class VendorBankVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async pennyDrop(vendorBankId: string, actorId: string): Promise<PennyDropResult> {
    const bank = await this.prisma.client.vendorBank.findUnique({
      where: { id: vendorBankId },
    });
    if (!bank) throw new NotFoundException('Vendor bank not found');

    if (bank.pennyDropRef === 'STUB_FAIL') {
      await this.audit.record({
        action: 'vendor_bank.penny_drop_failed',
        entityType: 'VendorBank',
        entityId: vendorBankId,
        actorId,
        after: { ok: false },
      });
      return {
        ok: false,
        reference: null,
        reason: 'Penny-drop failed: name mismatch at beneficiary bank.',
      };
    }

    const reference = `PD-${vendorBankId.slice(-8).toUpperCase()}`;
    await this.prisma.client.vendorBank.update({
      where: { id: vendorBankId },
      data: { isVerified: true, verifiedAt: new Date(), pennyDropRef: reference },
    });
    await this.audit.record({
      action: 'vendor_bank.verified',
      entityType: 'VendorBank',
      entityId: vendorBankId,
      actorId,
      before: { isVerified: bank.isVerified },
      after: { isVerified: true, reference },
    });
    return { ok: true, reference, reason: null };
  }
}
