import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ProblemExceptionFilter } from '../common/filters/problem.filter';
import { GrnQueryService } from './grn-query.service';
import { GrnController } from './grn.controller';
import { GrnService } from './grn.service';

const user = {
  userId: 'usr_1',
  tenantId: 'ten_1',
  audience: 'buyer',
  roles: [],
  perms: [],
};

describe('GrnController (integration)', () => {
  let app: INestApplication;
  const grn = {
    createDraft: vi.fn().mockResolvedValue({ id: 'grn_1' }),
    post: vi.fn().mockResolvedValue({ ok: true }),
    completeQc: vi.fn().mockResolvedValue({ ok: true }),
    recordQcSample: vi.fn().mockResolvedValue({ id: 'qcs_1', result: 'PASS' }),
    reverse: vi.fn().mockResolvedValue({ ok: true }),
    startQc: vi.fn().mockResolvedValue({ ok: true }),
    updateDraft: vi.fn(),
    submit: vi.fn(),
    hold: vi.fn(),
    addAttachment: vi.fn(),
  };
  const query = {
    list: vi
      .fn()
      .mockResolvedValue({ items: [], nextCursor: null, totalEstimate: 0, counts: {} }),
    detail: vi.fn().mockResolvedValue({ id: 'grn_1', number: 'GRN-0312' }),
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [GrnController],
      providers: [
        { provide: GrnService, useValue: grn },
        { provide: GrnQueryService, useValue: query },
        { provide: APP_FILTER, useClass: ProblemExceptionFilter },
        {
          provide: APP_GUARD,
          useValue: {
            canActivate: (ctx: {
              switchToHttp: () => { getRequest: () => { user: typeof user } };
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

  it('GET /grn lists receipts', async () => {
    const res = await request(app.getHttpServer()).get('/grn?tab=all');
    expect(res.status).toBe(200);
    expect(query.list).toHaveBeenCalled();
  });

  it('POST /grn creates a draft with the actor id from the token', async () => {
    const res = await request(app.getHttpServer())
      .post('/grn')
      .send({
        poId: 'po_1',
        packingCondition: 'OK',
        lines: [{ poLineId: 'pol_1', qtyReceived: '7.8' }],
      });
    expect(res.status).toBe(201);
    expect(grn.createDraft).toHaveBeenCalledWith(expect.any(Object), 'usr_1');
  });

  it('POST /grn rejects an invalid body with 422 problem+json', async () => {
    const res = await request(app.getHttpServer()).post('/grn').send({ poId: 'po_1' });
    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('POST /grn/:id/complete-qc forwards decisions', async () => {
    const res = await request(app.getHttpServer())
      .post('/grn/grn_1/complete-qc')
      .send({
        lines: [
          {
            grnLineId: 'grnl_1',
            qtyAccepted: '7.6',
            qtyRejected: '0.2',
            rejectionReason: 'VISIBLE_DAMAGE',
          },
        ],
      });
    expect(res.status).toBe(201);
    expect(grn.completeQc).toHaveBeenCalledWith('grn_1', expect.any(Object), 'usr_1');
  });

  it('POST /grn/:id/reverse requires a reason (422 when missing)', async () => {
    const res = await request(app.getHttpServer()).post('/grn/grn_1/reverse').send({});
    expect(res.status).toBe(422);
  });

  it('POST /grn/:id/post posts the receipt', async () => {
    const res = await request(app.getHttpServer()).post('/grn/grn_1/post').send({});
    expect(res.status).toBe(201);
    expect(grn.post).toHaveBeenCalledWith('grn_1', 'usr_1');
  });
});
