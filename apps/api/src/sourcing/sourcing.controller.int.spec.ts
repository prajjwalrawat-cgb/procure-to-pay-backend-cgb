import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ProblemExceptionFilter } from '../common/filters/problem.filter';
import { StorageService } from '../common/storage/storage.service';
import { AwardJustificationService } from './award-justification.service';
import { AwardService } from './award.service';
import { QuoteEvaluationService } from './quote-evaluation.service';
import { QuoteOpenService } from './quote-open.service';
import { QuoteService } from './quote.service';
import { ReverseAuctionService } from './reverse-auction.service';
import { RfqController } from './rfq.controller';
import { RfqQaService } from './rfq-qa.service';
import { RfqQueryService } from './rfq-query.service';
import { RfqService } from './rfq.service';
import { VendorRfqService } from './vendor-rfq.service';
import { VendorSourcingController } from './vendor-sourcing.controller';

/**
 * Controller-integration (mocked services) — verifies routing, Zod validation
 * and the guard wiring for the sourcing controllers (buyer + vendor).
 */
describe('Sourcing controllers (integration)', () => {
  let app: INestApplication;
  const rfq = {
    createDraft: vi.fn().mockResolvedValue({ id: 'rfq_new' }),
    addInvitation: vi.fn().mockResolvedValue({ added: 3 }),
    publish: vi.fn().mockResolvedValue({ status: 'Q_AND_A_OPEN' }),
  };
  const query = {
    list: vi.fn().mockResolvedValue({ items: [], nextCursor: null, totalEstimate: 0 }),
  };
  const open = { openTechnical: vi.fn().mockResolvedValue({ opened: 3 }) };
  const evaluation = { autoScore: vi.fn().mockResolvedValue({ scored: 2 }) };
  const award = { recommendAward: vi.fn().mockResolvedValue({ id: 'awd_1' }) };
  const vendorRfq = {
    listInvited: vi.fn().mockResolvedValue({ items: [] }),
    acknowledge: vi.fn().mockResolvedValue({ ok: true }),
  };
  const quotes = {
    submit: vi.fn().mockResolvedValue({ submissionHash: 'h', short: 'h…h' }),
  };
  const user = {
    userId: 'usr_harpreet',
    tenantId: 'ten_1',
    audience: 'buyer',
    roles: [],
    perms: [],
  };

  beforeAll(async () => {
    const noop = {};
    const moduleRef = await Test.createTestingModule({
      controllers: [RfqController, VendorSourcingController],
      providers: [
        { provide: RfqService, useValue: rfq },
        { provide: RfqQueryService, useValue: query },
        { provide: RfqQaService, useValue: noop },
        { provide: QuoteOpenService, useValue: open },
        { provide: QuoteEvaluationService, useValue: evaluation },
        { provide: ReverseAuctionService, useValue: noop },
        { provide: AwardService, useValue: award },
        { provide: AwardJustificationService, useValue: noop },
        { provide: VendorRfqService, useValue: vendorRfq },
        { provide: QuoteService, useValue: quotes },
        // The vendor controller streams quote attachments to storage on upload.
        { provide: StorageService, useValue: { put: vi.fn().mockResolvedValue(undefined) } },
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

  it('creates a draft RFQ', async () => {
    const res = await request(app.getHttpServer())
      .post('/rfq')
      .send({
        title: 'Cement mill liner segments Q3-26',
        category: 'Mechanical',
        rfqType: 'TWO_ENVELOPE',
        deliveryLocation: { stateCode: '17' },
        evaluationCriteria: [
          { key: 'price', label: 'Price', weight: 60, auto: true },
          { key: 'delivery', label: 'Delivery', weight: 20, auto: true },
          { key: 'quality', label: 'Quality', weight: 10, auto: false },
          { key: 'msme', label: 'MSME', weight: 10, auto: false },
        ],
        lines: [{ itemDesc: 'CrMo liner', uom: 'nos', qtyRequired: '24' }],
      });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'rfq_new' });
  });

  it('422s on invalid RFQ input (missing lines)', async () => {
    const res = await request(app.getHttpServer())
      .post('/rfq')
      .send({ title: 'x', category: 'y', rfqType: 'SINGLE_ENVELOPE' });
    expect(res.status).toBe(422);
  });

  it('lists RFQs', async () => {
    const res = await request(app.getHttpServer()).get('/rfq?tab=active');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
  });

  it('opens the technical envelope with participants', async () => {
    const res = await request(app.getHttpServer())
      .post('/rfq/rfq_1/open-technical')
      .send({ participantUserIds: ['usr_harpreet', 'usr_das'] });
    expect(res.status).toBe(201);
    expect(open.openTechnical).toHaveBeenCalledWith(
      'rfq_1',
      ['usr_harpreet', 'usr_das'],
      'usr_harpreet',
    );
  });

  it('recommends an award', async () => {
    const res = await request(app.getHttpServer())
      .post('/rfq/rfq_1/awards')
      .send({
        allocations: [
          { quoteId: 'qt_1', rfqLineId: 'l1', qtyAllocated: '16', unitPrice: '22400' },
        ],
        varianceFromL1Reason: 'x'.repeat(20),
      });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'awd_1' });
  });

  it('routes vendor list to the vendor service', async () => {
    const res = await request(app.getHttpServer()).get('/vendor/rfq');
    expect(res.status).toBe(200);
    expect(vendorRfq.listInvited).toHaveBeenCalledWith('usr_harpreet');
  });
});
