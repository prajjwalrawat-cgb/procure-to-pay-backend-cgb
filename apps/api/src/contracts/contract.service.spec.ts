import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import { NotificationService } from '../approvals/notification.service';
import { AuditLogService } from '../audit/audit.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { ContractDocumentService } from './contract-document.service';
import { ContractService } from './contract.service';

const future = new Date(Date.now() + 400 * 24 * 3600 * 1000);
const start = new Date(Date.now() + 1 * 24 * 3600 * 1000);

function build(contract: unknown) {
  const submit = vi.fn().mockResolvedValue(undefined);
  const client = {
    contract: { findUnique: vi.fn().mockResolvedValue(contract) },
  };
  const prisma = { client, currentTenantId: 'ten_1' } as unknown as PrismaService;
  const routing = { submit, onApproved: vi.fn() } as unknown as ApprovalRoutingService;
  const audit = { record: vi.fn() } as unknown as AuditLogService;
  const events = { emit: vi.fn() } as unknown as DomainEventService;
  const pdf = {} as ContractDocumentService;
  const notifications = {} as NotificationService;
  const svc = new ContractService(prisma, audit, events, routing, pdf, notifications);
  return { svc, submit };
}

const clause = (clauseType: string) => ({ clauseType });

describe('ContractService.submitForApproval — guards', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a contract with no rate card lines', async () => {
    const { svc } = build({
      status: 'DRAFT',
      validityStart: start,
      validityEnd: future,
      rateCards: [],
      clauses: [clause('PAYMENT_TERMS'), clause('DELIVERY_SLA'), clause('TERMINATION')],
    });
    await expect(svc.submitForApproval('ct_1', 'usr_1')).rejects.toThrow(/rate card/i);
  });

  it('rejects when a mandatory clause type is missing', async () => {
    const { svc } = build({
      status: 'DRAFT',
      validityStart: start,
      validityEnd: future,
      rateCards: [{ id: 'rc_1' }],
      clauses: [clause('PAYMENT_TERMS'), clause('DELIVERY_SLA')], // TERMINATION missing
    });
    await expect(svc.submitForApproval('ct_1', 'usr_1')).rejects.toThrow(/mandatory/i);
  });

  it('rejects when validity end is in the past', async () => {
    const { svc } = build({
      status: 'DRAFT',
      validityStart: new Date('2020-01-01'),
      validityEnd: new Date('2020-06-01'),
      rateCards: [{ id: 'rc_1' }],
      clauses: [clause('PAYMENT_TERMS'), clause('DELIVERY_SLA'), clause('TERMINATION')],
    });
    await expect(svc.submitForApproval('ct_1', 'usr_1')).rejects.toThrow();
  });

  it('rejects submitting a non-draft contract', async () => {
    const { svc } = build({
      status: 'ACTIVE',
      validityStart: start,
      validityEnd: future,
      rateCards: [{ id: 'rc_1' }],
      clauses: [clause('PAYMENT_TERMS'), clause('DELIVERY_SLA'), clause('TERMINATION')],
    });
    await expect(svc.submitForApproval('ct_1', 'usr_1')).rejects.toThrow(/draft/i);
  });

  it('routes a valid draft through the Slice 2 engine', async () => {
    const { svc, submit } = build({
      status: 'DRAFT',
      validityStart: start,
      validityEnd: future,
      rateCards: [{ id: 'rc_1' }],
      clauses: [clause('PAYMENT_TERMS'), clause('DELIVERY_SLA'), clause('TERMINATION')],
    });
    await expect(svc.submitForApproval('ct_1', 'usr_1')).resolves.toEqual({ ok: true });
    expect(submit).toHaveBeenCalledWith('CONTRACT', 'ct_1', 'usr_1');
  });
});
