import { Injectable } from '@nestjs/common';

import { AuditLogService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Thin sourcing audit facade (Slice 6 §10). Reuses the Slice 2 hash-chained
 * AuditLogService — every RFQ / Quote / Award / QuoteOpenLog state transition
 * records an entry. QuoteOpenLog-linked entries carry the participant list so
 * the log proves the open was witnessed by the required parties.
 */
@Injectable()
export class SourcingAuditService {
  constructor(
    private readonly audit: AuditLogService,
    private readonly prisma: PrismaService,
  ) {}

  async rfq(
    action: string,
    rfqId: string,
    actorId: string,
    after?: Record<string, unknown>,
    before?: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      action,
      entityType: 'Rfq',
      entityId: rfqId,
      actorId,
      before: before ?? null,
      after: after ?? null,
    });
  }

  async quote(
    action: string,
    quoteId: string,
    actorId: string,
    after?: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      action,
      entityType: 'Quote',
      entityId: quoteId,
      actorId,
      after: after ?? null,
    });
  }

  async award(
    action: string,
    awardId: string,
    actorId: string,
    after?: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      action,
      entityType: 'Award',
      entityId: awardId,
      actorId,
      after: after ?? null,
    });
  }

  /** RFQ number generator: RFQ-<YYYY>-<NNNN> per tenant. */
  async nextRfqNumber(tenantId: string, year: number): Promise<string> {
    const prefix = `RFQ-${year}-`;
    const last = await this.prisma.client.rfq.findFirst({
      where: { tenantId, number: { startsWith: prefix } },
      orderBy: { number: 'desc' },
      select: { number: true },
    });
    const seq = last ? Number.parseInt(last.number.slice(prefix.length), 10) + 1 : 1;
    return `${prefix}${String(seq).padStart(4, '0')}`;
  }
}
