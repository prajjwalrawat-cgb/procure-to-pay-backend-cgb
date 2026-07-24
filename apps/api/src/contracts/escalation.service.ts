import { Injectable, NotFoundException } from '@nestjs/common';
import type { EscalationClause, EscalationProposalResponse } from '@procureflow/shared';
import Decimal from 'decimal.js';

import { PrismaService } from '../prisma/prisma.service';
import { ContractService } from './contract.service';
import { ContractValidationError } from './contract.errors';
import { computeEscalatedRate } from './contract-logic';

const FREQUENCY_MONTHS: Record<string, number> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  SEMI_ANNUAL: 6,
  ANNUAL: 12,
};

/**
 * EscalationService (Slice 9). Basic indexed escalation — proposes new rates from
 * a manually-entered index value and drafts an amendment for approval. Never
 * auto-applies (ADR-029: amendments are the only sanctioned price-change path).
 * Real index-feed integration is Slice 10+ territory.
 */
@Injectable()
export class EscalationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contracts: ContractService,
  ) {}

  /** Whether the review window has elapsed since the current rates took effect. */
  async checkEscalationDue(
    contractId: string,
  ): Promise<{ due: boolean; nextReviewAt: string | null }> {
    const contract = await this.prisma.client.contract.findUnique({
      where: { id: contractId },
      include: { rateCards: { orderBy: { effectiveFrom: 'desc' }, take: 1 } },
    });
    if (!contract) throw new NotFoundException('Contract not found');
    const clause = contract.escalationClause as unknown as EscalationClause | null;
    if (!clause || clause.type !== 'INDEXED' || !contract.rateCards[0]) {
      return { due: false, nextReviewAt: null };
    }
    const months = FREQUENCY_MONTHS[clause.reviewFrequency] ?? 12;
    const last = contract.rateCards[0].effectiveFrom;
    const next = new Date(last);
    next.setUTCMonth(next.getUTCMonth() + months);
    return { due: new Date() >= next, nextReviewAt: next.toISOString() };
  }

  /**
   * Compute proposed escalated rates from a new index value and draft an
   * amendment (routed for approval). Does not change any live rate.
   */
  async applyIndex(
    contractId: string,
    indexValue: string,
    actorId: string,
  ): Promise<EscalationProposalResponse> {
    const contract = await this.prisma.client.contract.findUnique({
      where: { id: contractId },
      include: { rateCards: { orderBy: [{ rateYear: 'asc' }, { lineNo: 'asc' }] } },
    });
    if (!contract) throw new NotFoundException('Contract not found');
    const clause = contract.escalationClause as unknown as EscalationClause | null;
    if (!clause || clause.type !== 'INDEXED') {
      throw new ContractValidationError('Contract has no indexed escalation clause.');
    }
    if (!clause.baseIndexValue) {
      throw new ContractValidationError(
        'Escalation clause is missing a base index value.',
      );
    }

    const proposals = contract.rateCards.map((rc) => {
      const result = computeEscalatedRate({
        currentRate: rc.unitRate.toString(),
        baseIndex: clause.baseIndexValue!,
        newIndex: indexValue,
        capPct: clause.capPct ?? null,
      });
      return {
        rateCardId: rc.id,
        itemDesc: rc.routeOrigin
          ? `${rc.routeOrigin} → ${rc.routeDest ?? ''}`
          : rc.itemDesc,
        currentRate: rc.unitRate.toString(),
        proposedRate: result.proposedRate,
        upliftPct: result.upliftPct,
        capped: result.capped,
      };
    });

    // Rough monetary magnitude of the change, for amendment approval routing.
    const avgUplift = proposals.length
      ? proposals
          .reduce((s, p) => s.plus(p.upliftPct), new Decimal(0))
          .dividedBy(proposals.length)
      : new Decimal(0);
    const changeValue = new Decimal(contract.totalValueEstimate.toString())
      .times(avgUplift.dividedBy(100))
      .toFixed(4);

    const { id: amendmentId } = await this.contracts.amend(
      contractId,
      {
        changeSummary: `Indexed escalation @ index ${indexValue} (base ${clause.baseIndexValue})`,
        effectiveFrom: new Date().toISOString(),
        changeValue,
        rateChanges: proposals.map((p) => ({
          rateCardId: p.rateCardId,
          newUnitRate: p.proposedRate,
        })),
        fieldChanges: {},
      },
      actorId,
    );

    return {
      contractId,
      indexValue,
      baseIndexValue: clause.baseIndexValue ?? null,
      capPct: clause.capPct ?? null,
      proposals,
      amendmentId,
    };
  }
}
