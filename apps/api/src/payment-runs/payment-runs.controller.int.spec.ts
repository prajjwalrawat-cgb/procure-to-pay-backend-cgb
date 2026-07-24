import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ProblemExceptionFilter } from '../common/filters/problem.filter';
import { TdsService } from '../invoices/domain/tds.service';
import { BankAccountService } from './bank-account.service';
import { PaymentRunComposerService } from './payment-run-composer.service';
import { PaymentRunMsmeService } from './payment-run-msme.service';
import { PaymentRunQueryService } from './payment-run-query.service';
import { PaymentRunService } from './payment-run.service';
import { PaymentRunsController } from './payment-runs.controller';

describe('PaymentRunsController (integration)', () => {
  let app: INestApplication;
  const composer = {
    createDraft: vi.fn(),
    suggestInvoices: vi.fn(),
    addInvoice: vi.fn(),
    removeInvoice: vi.fn(),
    reorder: vi.fn(),
  };
  const runs = {
    submitForApproval: vi.fn(),
    decide: vi.fn(),
    cancelBatch: vi.fn(),
    previewFile: vi.fn(),
    retryFailedItems: vi.fn(),
  };
  const query = { list: vi.fn(), detail: vi.fn() };
  const bankAccounts = { list: vi.fn() };
  const msmeAudit = { runMsmeAudit: vi.fn() };
  const tds = { generateTdsReport: vi.fn() };
  const user = {
    userId: 'usr_iyer',
    tenantId: 'ten_1',
    audience: 'buyer',
    roles: [],
    perms: [],
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PaymentRunsController],
      providers: [
        { provide: PaymentRunComposerService, useValue: composer },
        { provide: PaymentRunService, useValue: runs },
        { provide: PaymentRunQueryService, useValue: query },
        { provide: BankAccountService, useValue: bankAccounts },
        { provide: PaymentRunMsmeService, useValue: msmeAudit },
        { provide: TdsService, useValue: tds },
        { provide: APP_FILTER, useClass: ProblemExceptionFilter },
        {
          provide: APP_GUARD,
          useValue: {
            canActivate: (ctx: {
              switchToHttp: () => { getRequest: () => { user: unknown } };
            }) => {
              ctx.switchToHttp().getRequest().user = user;
              return true;
            },
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /payment-runs creates a draft', async () => {
    composer.createDraft.mockResolvedValueOnce('pay_1');
    const res = await request(app.getHttpServer())
      .post('/payment-runs')
      .send({ cycleDate: '2026-06-14T00:00:00.000Z', bankAccountId: 'bank_1' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('pay_1');
    expect(composer.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ bankAccountId: 'bank_1' }),
      'usr_iyer',
    );
  });

  it('GET /payment-runs returns the list', async () => {
    query.list.mockResolvedValueOnce({ items: [], nextCursor: null, totalEstimate: 0 });
    const res = await request(app.getHttpServer()).get('/payment-runs?tab=draft');
    expect(res.status).toBe(200);
    expect(query.list).toHaveBeenCalledWith(expect.objectContaining({ tab: 'draft' }));
  });

  it('POST /payment-runs/:id/items adds an invoice', async () => {
    composer.addInvoice.mockResolvedValueOnce(undefined);
    const res = await request(app.getHttpServer())
      .post('/payment-runs/pay_1/items')
      .send({ invoiceId: 'inv_4408' });
    expect(res.status).toBe(201);
    expect(composer.addInvoice).toHaveBeenCalledWith('pay_1', 'inv_4408', 'usr_iyer');
  });

  it('POST /payment-runs/:id/submit-for-approval routes the run', async () => {
    runs.submitForApproval.mockResolvedValueOnce(undefined);
    const res = await request(app.getHttpServer()).post(
      '/payment-runs/pay_1/submit-for-approval',
    );
    expect(res.status).toBe(201);
    expect(runs.submitForApproval).toHaveBeenCalledWith('pay_1', 'usr_iyer');
  });

  it('POST /payment-runs/:id/decide validates the decision', async () => {
    const res = await request(app.getHttpServer())
      .post('/payment-runs/pay_1/decide')
      .send({ approvalId: 'apr_1', decision: 'NONSENSE' });
    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('POST /payment-runs/:id/decide forwards a valid decision', async () => {
    runs.decide.mockResolvedValueOnce(undefined);
    const res = await request(app.getHttpServer())
      .post('/payment-runs/pay_1/decide')
      .send({ approvalId: 'apr_1', decision: 'APPROVE', comment: 'ok' });
    expect(res.status).toBe(201);
    expect(runs.decide).toHaveBeenCalledWith('apr_1', 'APPROVE', 'ok', 'usr_iyer');
  });
});
