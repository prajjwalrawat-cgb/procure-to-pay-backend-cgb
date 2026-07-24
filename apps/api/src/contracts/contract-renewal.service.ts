import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import { DOMAIN_EVENTS, type RenewalAlertAction } from '@procureflow/shared';

import { NotificationService } from '../approvals/notification.service';
import { AuditLogService } from '../audit/audit.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { crossedRenewalThresholds, daysBetween } from './contract-logic';

/**
 * ContractRenewalService (Slice 9). The proactive renewal risk tool: scans for
 * contracts crossing the 90/60/30-day thresholds, materialises alert rows +
 * notifications, and auto-expires contracts past their validity with no renewal
 * or termination action. Runs as a nightly job and lazily on calendar reads.
 */
@Injectable()
export class ContractRenewalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Scan live contracts, flip EXPIRING_SOON / EXPIRED, and create any newly
   * crossed alert rows. Idempotent (unique [contractId, alertType]).
   */
  async checkExpiringContracts(): Promise<{ scanned: number; alerted: number }> {
    const now = new Date();
    const contracts = await this.prisma.client.contract.findMany({
      where: { status: { in: ['ACTIVE', 'EXPIRING_SOON'] } },
    });
    let alerted = 0;
    for (const c of contracts) {
      const dte = daysBetween(now, c.validityEnd);

      if (dte < 0) {
        await this.prisma.client.contract.update({
          where: { id: c.id },
          data: { status: 'EXPIRED' },
        });
        await this.events.emit(DOMAIN_EVENTS.CONTRACT_EXPIRED, {
          contractId: c.id,
          vendorId: c.vendorId,
        });
        await this.audit.record({
          action: 'CONTRACT_EXPIRED',
          entityType: 'Contract',
          entityId: c.id,
          actorType: 'SYSTEM',
        });
      } else if (dte <= c.renewalNoticeDays && c.status === 'ACTIVE') {
        await this.prisma.client.contract.update({
          where: { id: c.id },
          data: { status: 'EXPIRING_SOON' },
        });
      }

      for (const alertType of crossedRenewalThresholds(dte)) {
        const created = await this.prisma.client.contractRenewalAlert.upsert({
          where: { contractId_alertType: { contractId: c.id, alertType } },
          update: {},
          create: {
            id: newId('contractRenewalAlert'),
            tenantId: c.tenantId,
            contractId: c.id,
            alertType,
          },
        });
        if (created.acknowledgedAt === null && c.createdBy) {
          alerted += 1;
          await this.notifications.notify({
            userId: c.createdBy,
            type: 'CONTRACT_RENEWAL',
            title: `Contract ${c.number} — ${alertType.replace('NOTICE_', '')} renewal window`,
            body: `${c.title} expires on ${c.validityEnd.toISOString().slice(0, 10)}.`,
            entityType: 'Contract',
            entityId: c.id,
            href: `/contracts/${c.id}`,
            tenantId: c.tenantId,
          });
        }
      }
    }
    return { scanned: contracts.length, alerted };
  }

  async acknowledgeAlert(
    alertId: string,
    actionTaken: RenewalAlertAction,
    actorId: string,
  ): Promise<{ ok: true }> {
    const alert = await this.prisma.client.contractRenewalAlert.findUnique({
      where: { id: alertId },
    });
    if (!alert) throw new NotFoundException('Renewal alert not found');
    await this.prisma.client.contractRenewalAlert.update({
      where: { id: alertId },
      data: {
        acknowledgedAt: new Date(),
        acknowledgedBy: actorId,
        actionTaken: actionTaken as Prisma.ContractRenewalAlertUpdateInput['actionTaken'],
      },
    });
    await this.audit.record({
      action: 'CONTRACT_RENEWAL_ACKNOWLEDGED',
      entityType: 'Contract',
      entityId: alert.contractId,
      actorId,
      after: { alertId, actionTaken },
    });
    return { ok: true };
  }
}
