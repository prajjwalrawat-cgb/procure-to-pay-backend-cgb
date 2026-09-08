import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import {
  DOMAIN_EVENTS,
  type CallOffInput,
  type VolumeTrackingView,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { AuditLogService } from '../audit/audit.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { PurchaseOrderService } from '../purchase-orders/purchase-order.service';
import { CallOffRejectedError } from './contract.errors';
import { classifyVolumeTracking, commitmentPeriodKey } from './contract-logic';

/**
 * CallOffService (Slice 9). Issues POs against an active contract at locked
 * rates, maintains actual-vs-committed volume tracking, and surfaces take-or-pay
 * shortfall risk. Rate resolution + immutability live in
 * `PurchaseOrderService.createFromContract` (ADR-029).
 */
@Injectable()
export class CallOffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly poService: PurchaseOrderService,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
  ) {}

  async createCallOff(
    contractId: string,
    input: CallOffInput,
    actorId: string,
  ): Promise<{ id: string; poId: string }> {
    const contract = await this.prisma.client.contract.findUnique({
      where: { id: contractId },
      include: { rateCards: true },
    });
    if (!contract) throw new NotFoundException('Contract not found');
    if (contract.status !== 'ACTIVE') {
      throw new CallOffRejectedError(
        contract.status === 'EXPIRED'
          ? 'Contract has expired — initiate a renewal before calling off.'
          : 'Only an active contract can be called off against.',
        { status: contract.status },
      );
    }

    // Pre-check the per-call-off value cap before creating the PO (rates come
    // from the rate card, so we can price the call-off up front).
    const cardById = new Map(contract.rateCards.map((r) => [r.id, r]));
    let callOffValue = new Decimal(0);
    let callOffQty = new Decimal(0);
    for (const line of input.lines) {
      const card = cardById.get(line.contractRateCardId);
      if (!card) {
        throw new CallOffRejectedError('Rate card not found on this contract.', {
          rateCardId: line.contractRateCardId,
        });
      }
      const qty = new Decimal(line.qty);
      const lineValue = qty
        .times(card.unitRate.toString())
        .times(new Decimal(1).plus(card.taxRate.toString()));
      callOffValue = callOffValue.plus(lineValue);
      callOffQty = callOffQty.plus(qty);
    }
    if (
      contract.maxCallOffValue &&
      callOffValue.greaterThan(contract.maxCallOffValue.toString())
    ) {
      throw new CallOffRejectedError('Call-off exceeds the per-call-off value cap.', {
        cap: contract.maxCallOffValue.toString(),
        requested: callOffValue.toFixed(4),
      });
    }

    // Create + issue the PO (rate immutability + approval bypass enforced there).
    const { id: poId } = await this.poService.createFromContract(
      {
        kind: 'FROM_CONTRACT',
        contractId,
        deliveryAddress: input.deliveryLocation,
        deliveryTerms: 'DDP',
        expectedDeliveryDate: input.expectedDeliveryDate,
        lines: input.lines.map((l) => ({
          contractRateCardId: l.contractRateCardId,
          qtyOrdered: l.qty,
        })),
        // The call-off endpoint has no confirm-and-retry step, and repeat
        // call-offs against a running contract are the normal case — a match is
        // recorded on the audit trail rather than refused.
        confirmDuplicate: true,
      },
      actorId,
    );

    const primaryRateCard = input.lines[0]?.contractRateCardId ?? null;
    const callOffId = newId('contractCallOff');
    await this.prisma.client.contractCallOff.create({
      data: {
        id: callOffId,
        tenantId: contract.tenantId,
        contractId,
        poId,
        rateCardIdUsed: primaryRateCard,
        qty: new Prisma.Decimal(callOffQty.toFixed(4)),
        value: new Prisma.Decimal(callOffValue.toFixed(4)),
        calledOffBy: actorId,
      },
    });

    await this.updateVolumeTracking(contractId, callOffQty, callOffValue);

    await this.audit.record({
      action: 'CALL_OFF_CREATED',
      entityType: 'Contract',
      entityId: contractId,
      actorId,
      after: {
        callOffId,
        poId,
        qty: callOffQty.toFixed(4),
        value: callOffValue.toFixed(4),
      },
    });
    await this.events.emit(DOMAIN_EVENTS.CALL_OFF_CREATED, {
      contractId,
      poId,
      qty: callOffQty.toFixed(4),
      value: callOffValue.toFixed(4),
    });
    return { id: callOffId, poId };
  }

  /** Live volume-tracking view for the current commitment period. */
  async getVolumeTrackingStatus(contractId: string): Promise<VolumeTrackingView | null> {
    const contract = await this.prisma.client.contract.findUnique({
      where: { id: contractId },
    });
    if (!contract) throw new NotFoundException('Contract not found');
    const period = commitmentPeriodKey(contract.commitmentPeriod, new Date());
    const row = await this.prisma.client.contractVolumeTracking.findUnique({
      where: { contractId_period: { contractId, period } },
    });

    const committedQty = row?.committedQty ?? contract.minimumCommitmentQty;
    const committedValue = row?.committedValue ?? contract.minimumCommitmentValue;
    const actualQty = row?.actualQty ?? new Prisma.Decimal(0);
    const actualValue = row?.actualValue ?? new Prisma.Decimal(0);

    const elapsed = this.elapsedFraction(contract, period);
    const classify = classifyVolumeTracking({
      committedQty: committedQty ? Number(committedQty.toString()) : null,
      actualQty: Number(actualQty.toString()),
      elapsedFraction: elapsed,
    });
    const shortfall =
      committedValue &&
      new Decimal(actualValue.toString()).lessThan(committedValue.toString())
        ? new Decimal(committedValue.toString()).minus(actualValue.toString()).toFixed(4)
        : null;

    return {
      period,
      commitmentPeriod: contract.commitmentPeriod,
      committedQty: committedQty?.toString() ?? null,
      actualQty: actualQty.toString(),
      committedValue: committedValue?.toString() ?? null,
      actualValue: actualValue.toString(),
      commitmentUom: contract.commitmentUom,
      pctOfCommitment: classify.pctOfCommitment,
      projectedPctOfCommitment: classify.projectedPctOfCommitment,
      shortfallValue: shortfall,
      status: classify.status,
    };
  }

  private async updateVolumeTracking(
    contractId: string,
    qty: Decimal,
    value: Decimal,
  ): Promise<void> {
    const contract = await this.prisma.client.contract.findUnique({
      where: { id: contractId },
    });
    if (!contract) return;
    const period = commitmentPeriodKey(contract.commitmentPeriod, new Date());
    const row = await this.prisma.client.contractVolumeTracking.upsert({
      where: { contractId_period: { contractId, period } },
      update: {
        actualQty: { increment: new Prisma.Decimal(qty.toFixed(4)) },
        actualValue: { increment: new Prisma.Decimal(value.toFixed(4)) },
      },
      create: {
        id: newId('contractVolumeTracking'),
        tenantId: contract.tenantId,
        contractId,
        period,
        committedQty: contract.minimumCommitmentQty,
        committedValue: contract.minimumCommitmentValue,
        actualQty: new Prisma.Decimal(qty.toFixed(4)),
        actualValue: new Prisma.Decimal(value.toFixed(4)),
      },
    });

    const elapsed = this.elapsedFraction(contract, period);
    const classify = classifyVolumeTracking({
      committedQty: row.committedQty ? Number(row.committedQty.toString()) : null,
      actualQty: Number(row.actualQty.toString()),
      elapsedFraction: elapsed,
    });
    const shortfallValue =
      row.committedValue &&
      new Decimal(row.actualValue.toString()).lessThan(row.committedValue.toString())
        ? new Prisma.Decimal(
            new Decimal(row.committedValue.toString())
              .minus(row.actualValue.toString())
              .toFixed(4),
          )
        : null;
    await this.prisma.client.contractVolumeTracking.update({
      where: { contractId_period: { contractId, period } },
      data: { status: classify.status, shortfallValue },
    });

    if (classify.status !== 'ON_TRACK') {
      await this.events.emit(DOMAIN_EVENTS.VOLUME_TRACKING_SHORTFALL_DETECTED, {
        contractId,
        period,
        status: classify.status,
        shortfallValue: shortfallValue?.toString() ?? null,
      });
    }
  }

  /** Fraction of the commitment period elapsed (clamped 0..1). */
  private elapsedFraction(
    contract: { validityStart: Date; validityEnd: Date; commitmentPeriod: string },
    period: string,
  ): number {
    const now = Date.now();
    let start = contract.validityStart.getTime();
    let end = contract.validityEnd.getTime();
    if (contract.commitmentPeriod === 'ANNUAL' && period.startsWith('FY')) {
      const fyStartYear = Number(period.slice(2));
      const fyStart = Date.UTC(fyStartYear, 3, 1); // 1 April
      const fyEnd = Date.UTC(fyStartYear + 1, 2, 31); // 31 March
      start = Math.max(start, fyStart);
      end = Math.min(end, fyEnd);
    }
    if (end <= start) return 1;
    return Math.min(1, Math.max(0, (now - start) / (end - start)));
  }
}
