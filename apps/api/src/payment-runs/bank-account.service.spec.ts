import { describe, expect, it, vi } from 'vitest';

import type { AuditLogService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { BankAccountService } from './bank-account.service';
import { PaymentRunStateError } from './payment-run.errors';

const HDFC = {
  id: 'bank_1',
  bankName: 'HDFC Corporate',
  accountNoLast4: '7890',
  ifsc: 'HDFC0001234',
  holderName: 'ArtBox Solutions',
  formatKey: 'NEFT_BULK',
  dailyLimit: null,
  uploadConfig: { tenantCode: 'ARTBOX01' },
  isActive: true,
};

const input = {
  bankName: 'HDFC Corporate',
  accountNoLast4: '7890',
  ifsc: 'HDFC0001234',
  holderName: 'ArtBox Solutions',
  formatKey: 'NEFT_BULK' as const,
  dailyLimit: null,
  tenantCode: 'ARTBOX01',
};

function build(opts: { openRun?: { number: string } | null } = {}) {
  const client = {
    bankAccount: {
      findMany: vi.fn().mockResolvedValue([HDFC]),
      findUnique: vi.fn().mockResolvedValue(HDFC),
      create: vi.fn().mockResolvedValue(HDFC),
      update: vi.fn().mockResolvedValue(HDFC),
    },
    paymentRun: { findFirst: vi.fn().mockResolvedValue(opts.openRun ?? null) },
  };
  const prisma = { client } as unknown as PrismaService;
  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuditLogService;
  return { service: new BankAccountService(prisma, audit), client, audit };
}

describe('BankAccountService', () => {
  it('lists only active accounts for the run picker', async () => {
    const { service, client } = build();
    await service.list();
    expect(client.bankAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } }),
    );
  });

  it('includes retired accounts in the settings list', async () => {
    const { service, client } = build();
    await service.listAll();
    expect(client.bankAccount.findMany).toHaveBeenCalledWith(
      expect.not.objectContaining({ where: expect.anything() }),
    );
  });

  it('stores the corporate code in uploadConfig, where the formatter reads it', async () => {
    const { service, client } = build();
    await service.create('ten_1', input, 'usr_1');
    expect(client.bankAccount.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ uploadConfig: { tenantCode: 'ARTBOX01' } }),
      }),
    );
  });

  it('never writes account digits into the audit trail', async () => {
    const { service, audit } = build();
    await service.create('ten_1', input, 'usr_1');
    const logged = JSON.stringify(
      (audit.record as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0],
    );
    expect(logged).not.toContain('7890');
    expect(logged).toContain('HDFC');
  });

  it('refuses to retire an account with a run still open against it', async () => {
    const { service } = build({ openRun: { number: 'PR-2026-001' } });
    await expect(service.setActive('bank_1', false, 'usr_1')).rejects.toBeInstanceOf(
      PaymentRunStateError,
    );
  });

  it('retires an account once nothing is open against it', async () => {
    const { service, client } = build({ openRun: null });
    await service.setActive('bank_1', false, 'usr_1');
    expect(client.bankAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'bank_1' }, data: { isActive: false } }),
    );
  });

  it('restores without checking for open runs', async () => {
    const { service, client } = build({ openRun: { number: 'PR-2026-001' } });
    await service.setActive('bank_1', true, 'usr_1');
    expect(client.paymentRun.findFirst).not.toHaveBeenCalled();
    expect(client.bankAccount.update).toHaveBeenCalled();
  });

  it('exposes the corporate code on the view so an edit round-trips it', async () => {
    const { service } = build();
    const [view] = await service.listAll();
    expect(view!.tenantCode).toBe('ARTBOX01');
    expect(view!.accountNoLast4).toBe('7890');
  });
});
