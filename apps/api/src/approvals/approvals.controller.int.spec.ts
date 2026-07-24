import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ProblemExceptionFilter } from '../common/filters/problem.filter';
import {
  ApprovalMatrixController,
  ApprovalSimulateController,
} from './approval-matrix.controller';
import { ApprovalMatrixService } from './approval-matrix.service';
import { ApprovalRoutingService } from './approval-routing.service';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';

describe('Approvals controllers (integration)', () => {
  let app: INestApplication;
  const matrices = {
    list: vi.fn(),
    get: vi.fn(),
    simulate: vi.fn(),
  };
  const routing = { decide: vi.fn(), delegate: vi.fn() };
  const inbox = { list: vi.fn(), sidebarCounts: vi.fn() };
  const user = {
    userId: 'usr_das',
    tenantId: 'ten_1',
    audience: 'buyer',
    roles: [],
    perms: [],
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        ApprovalMatrixController,
        ApprovalSimulateController,
        InboxController,
      ],
      providers: [
        { provide: ApprovalMatrixService, useValue: matrices },
        { provide: ApprovalRoutingService, useValue: routing },
        { provide: InboxService, useValue: inbox },
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

  it('GET /approvals/matrices returns active rules for a document type', async () => {
    matrices.list.mockResolvedValueOnce([{ id: 'amx_1', name: 'Standard' }]);
    const res = await request(app.getHttpServer()).get(
      '/approvals/matrices?documentType=INVOICE',
    );
    expect(res.status).toBe(200);
    expect(res.body.documentType).toBe('INVOICE');
    expect(res.body.items[0].name).toBe('Standard');
    expect(matrices.list).toHaveBeenCalledWith('INVOICE');
  });

  it('POST /approvals/:id/decide delegates to the routing service', async () => {
    routing.decide.mockResolvedValueOnce(undefined);
    const res = await request(app.getHttpServer())
      .post('/approvals/apr_1/decide')
      .send({ decision: 'APPROVE', comment: 'ok' });
    expect(res.status).toBe(201);
    expect(routing.decide).toHaveBeenCalledWith('apr_1', 'APPROVE', 'ok', 'usr_das');
  });

  it('rejects an invalid decision as 422 problem+json', async () => {
    const res = await request(app.getHttpServer())
      .post('/approvals/apr_1/decide')
      .send({ decision: 'MAYBE' });
    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('POST /approvals/simulate dry-runs a rule', async () => {
    matrices.simulate.mockResolvedValueOnce({ matched: true, chain: [], trace: [] });
    const res = await request(app.getHttpServer())
      .post('/approvals/simulate')
      .send({
        documentType: 'INVOICE',
        conditions: { all: [{ field: 'total_amount', op: 'gte', value: '10000000' }] },
        steps: [{ step_no: 1, name: 'MD', role: 'MD', scope: 'tenant', sla_hours: 48 }],
        sampleDocument: { documentType: 'INVOICE', total_amount: '12000000' },
      });
    expect(res.status).toBe(201);
    expect(res.body.matched).toBe(true);
  });

  it('GET /inbox returns the queue for the current user', async () => {
    inbox.list.mockResolvedValueOnce({ items: [], counts: {} });
    const res = await request(app.getHttpServer()).get('/inbox?filter=waiting_on_me');
    expect(res.status).toBe(200);
    expect(inbox.list).toHaveBeenCalledWith('usr_das', 'waiting_on_me');
  });
});
