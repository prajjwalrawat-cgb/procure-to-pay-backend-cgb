import { Inject, Injectable } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import { VENDOR_EVENTS, compare, type ScreeningType } from '@procureflow/shared';

import { AuditLogService } from '../audit/audit.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  SCREENING_PROVIDER,
  screeningProviderName,
  type IScreeningProvider,
  type ScreeningInput,
} from './verification/screening.provider';

/** Refresh windows per screening type (days) — Slice 7 cadence (GSTIN monthly,
 *  sanctions quarterly, credit annually). Read by the Slice 10c refresh job. */
export const SCREENING_REFRESH_DAYS: Partial<Record<ScreeningType, number>> = {
  GSTIN_STATUS: 30,
  SANCTIONS_OFAC: 90,
  SANCTIONS_EU: 90,
  SANCTIONS_UK: 90,
  ADVERSE_MEDIA: 90,
  CREDIT_BUREAU: 365,
};

/**
 * VendorVerificationService (Slice 7). Runs statutory/compliance screenings and
 * records structured findings. Slice 10c swaps the mock providers for real
 * (simulator-backed) ones behind `SCREENING_PROVIDER` — the findings shape and
 * this service's row-writing contract are unchanged.
 */
@Injectable()
export class VendorVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
    @Inject(SCREENING_PROVIDER) private readonly screening: IScreeningProvider,
  ) {}

  /** Trigger a screening. The provider job is synchronous in Slice 7 (the stub
   *  returns immediately); the response is normalised into structured findings. */
  async runScreening(
    vendorId: string,
    screeningType: ScreeningType,
    actorId: string,
  ): Promise<{ id: string; status: string }> {
    const vendor = await this.prisma.client.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      include: { beneficialOwners: true },
    });
    const input: ScreeningInput = {
      gstin: vendor.gstin,
      pan: vendor.businessPan ?? vendor.pan,
      udyamNumber: vendor.udyamNumber,
      legalEntityName: vendor.legalEntityName ?? vendor.name,
      beneficialOwnerNames: vendor.beneficialOwners.map((o) => o.ownerName),
    };
    const result = await this.screening.screen(screeningType, input);
    const provider = screeningProviderName(screeningType);
    const id = newId('vendorScreening');
    const now = new Date();
    const refresh = SCREENING_REFRESH_DAYS[screeningType];
    await this.prisma.client.vendorScreening.create({
      data: {
        id,
        tenantId: vendor.tenantId,
        vendorId,
        screeningType,
        screeningProvider: provider,
        completedAt: now,
        status:
          result.status === 'CLEAR'
            ? 'CLEAR'
            : result.status === 'ERROR'
              ? 'ERROR'
              : 'FLAGGED',
        flagSeverity: result.severity ?? null,
        providerResponse: result.raw as Prisma.InputJsonValue,
        findings: result.findings as Prisma.InputJsonValue,
        nextScreeningDueAt: refresh
          ? new Date(now.getTime() + refresh * 86_400_000)
          : null,
      },
    });
    await this.audit.record({
      action: 'VENDOR_SCREENING_RUN',
      entityType: 'Vendor',
      entityId: vendorId,
      actorId,
      after: { screeningType, provider, status: result.status },
    });
    await this.events.emit(VENDOR_EVENTS.SCREENING_COMPLETED, {
      vendorId,
      screeningId: id,
      screeningType,
      status: result.status,
    });
    if (result.status === 'FLAGGED') {
      await this.events.emit(VENDOR_EVENTS.SCREENING_FLAGGED, {
        vendorId,
        screeningId: id,
        screeningType,
        severity: result.severity ?? 'MEDIUM',
      });
    }
    return { id, status: result.status };
  }

  /** Manual review of a FLAGGED screening. */
  async reviewScreeningFinding(
    screeningId: string,
    decision: 'CLEAR' | 'ACCEPT_RISK' | 'REJECT_VENDOR',
    notes: string | null,
    actorId: string,
  ): Promise<{ ok: true }> {
    const screening = await this.prisma.client.vendorScreening.findUniqueOrThrow({
      where: { id: screeningId },
    });
    await this.prisma.client.vendorScreening.update({
      where: { id: screeningId },
      data: {
        reviewedBy: actorId,
        reviewDecision: decision,
        reviewNotes: notes,
        status: decision === 'REJECT_VENDOR' ? 'FLAGGED' : 'CLEAR',
      },
    });
    await this.audit.record({
      action: 'VENDOR_SCREENING_REVIEWED',
      entityType: 'Vendor',
      entityId: screening.vendorId,
      actorId,
      after: { screeningId, decision, notes },
    });
    return { ok: true };
  }

  /** Penny-drop bank verification: returns the registered holder name and a
   *  fuzzy match score against the declared name. Deterministic mock. */
  pennyDrop(
    declaredHolderName: string,
    accountNumber: string,
  ): { registeredName: string; matchScore: number } {
    // Accounts starting 9999 simulate a name mismatch at the bank.
    const registeredName = accountNumber.startsWith('9999')
      ? 'MISMATCHED ACCOUNT HOLDER'
      : declaredHolderName;
    const { score } = compare(declaredHolderName, registeredName);
    return { registeredName, matchScore: score };
  }
}
