import { Global, Injectable, Module } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * Domain-event bus (Master Context §3 rule #9). Slice 1 persists events to the
 * `DomainEvent` table; cross-module consumers subscribe from Slice 2 onward.
 * Runs inside the caller's tenant context (or a supplied tenantId).
 */
@Injectable()
export class DomainEventService {
  constructor(private readonly prisma: PrismaService) {}

  async emit(
    eventType: string,
    payload: Record<string, unknown>,
    tenantId?: string,
  ): Promise<void> {
    const tid = tenantId ?? this.prisma.currentTenantId;
    if (!tid) throw new Error('DomainEventService.emit requires a tenant context.');
    await this.prisma.client.domainEvent.create({
      data: {
        id: newId('domainEvent'),
        tenantId: tid,
        eventType,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  }
}

@Global()
@Module({
  providers: [DomainEventService],
  exports: [DomainEventService],
})
export class DomainEventsModule {}
