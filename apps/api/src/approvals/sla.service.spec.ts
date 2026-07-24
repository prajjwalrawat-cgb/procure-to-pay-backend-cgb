import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';

import type { AuditLogService } from '../audit/audit.service';
import type { DomainEventService } from '../common/events/domain-event.service';
import type { Env } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import type { ApprovalContextService } from './approval-context.service';
import type { ApproverResolver } from './approver-resolver.service';
import type { NotificationService } from './notification.service';
import { SlaService } from './sla.service';

function makeSla(opts: {
  breached: unknown[];
  escalateTo?: { role: string; sla_hours: number };
}) {
  const create = vi.fn().mockResolvedValue(undefined);
  const update = vi.fn().mockResolvedValue(undefined);
  const prisma = {
    client: {
      approval: {
        findMany: vi.fn().mockResolvedValue(opts.breached),
        update,
        create,
      },
      invoice: {
        findUnique: vi.fn().mockResolvedValue({
          approvalMatrixSnapshot: {
            steps: [
              {
                step_no: 1,
                name: 'Plant Head',
                role: 'PLANT_HEAD',
                scope: 'tenant',
                sla_hours: 1,
                ...(opts.escalateTo ? { escalate_to: opts.escalateTo } : {}),
              },
            ],
          },
        }),
      },
    },
  } as unknown as PrismaService;
  const resolver = {
    candidatesForRole: vi.fn().mockResolvedValue(['usr_finance_head']),
  } as unknown as ApproverResolver;
  const context = {
    build: vi.fn().mockResolvedValue({ documentType: 'INVOICE' }),
  } as unknown as ApprovalContextService;
  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuditLogService;
  const events = {
    emit: vi.fn().mockResolvedValue(undefined),
  } as unknown as DomainEventService;
  const notifications = {
    notify: vi.fn().mockResolvedValue(undefined),
  } as unknown as NotificationService;
  const config = { get: vi.fn().mockReturnValue(true) } as unknown as ConfigService<
    Env,
    true
  >;
  const logger = { setContext: vi.fn(), error: vi.fn() } as unknown as PinoLogger;

  const service = new SlaService(
    config,
    prisma,
    resolver,
    context,
    audit,
    events,
    notifications,
    logger,
  );
  return { service, create, update, events };
}

const breachedApproval = {
  id: 'apr_1',
  documentType: 'INVOICE' as const,
  documentId: 'inv_1',
  stepNo: 1,
  matrixSnapshotId: 'amx_1',
};

describe('SlaService.sweepTenant', () => {
  it('adds an escalation approver when a breached step has escalate_to', async () => {
    const { service, create, update, events } = makeSla({
      breached: [breachedApproval],
      escalateTo: { role: 'FINANCE_HEAD', sla_hours: 24 },
    });
    const count = await service.sweepTenant('ten_1');
    expect(update).toHaveBeenCalled(); // marks original escalatedAt
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isEscalation: true,
          approverId: 'usr_finance_head',
        }),
      }),
    );
    expect(events.emit).toHaveBeenCalledWith('SlaBreached', expect.anything());
    expect(count).toBe(1);
  });

  it('does not escalate when the step has no escalate_to', async () => {
    const { service, create } = makeSla({ breached: [breachedApproval] });
    const count = await service.sweepTenant('ten_1');
    expect(create).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });

  it('never auto-decides', async () => {
    const { service, update } = makeSla({
      breached: [breachedApproval],
      escalateTo: { role: 'FINANCE_HEAD', sla_hours: 24 },
    });
    await service.sweepTenant('ten_1');
    const updates = (update as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    for (const u of updates) {
      expect(JSON.stringify(u)).not.toContain('APPROVED');
      expect(JSON.stringify(u)).not.toContain('REJECTED');
    }
  });
});
