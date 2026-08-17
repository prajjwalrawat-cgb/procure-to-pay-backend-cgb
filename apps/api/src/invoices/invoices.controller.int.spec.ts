import { NotFoundException, type INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PERMISSIONS } from '@procureflow/shared';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ProblemExceptionFilter } from '../common/filters/problem.filter';
import { StorageService } from '../common/storage/storage.service';
import { InvoiceQueryService } from './invoice-query.service';
import { InvoiceService } from './invoice.service';
import { InvoicesController } from './invoices.controller';
import { MatchService } from './match.service';

/** Integration: InvoicesController wired through Nest with mocked services. */
describe('InvoicesController (integration)', () => {
  let app: INestApplication;
  const query = {
    find: vi.fn(),
    getTabCounts: vi.fn(),
    findById: vi.fn(),
    assertVisible: vi.fn(),
  };
  const invoices = { resolveAndRoute: vi.fn() };
  const match = { resolveException: vi.fn(), runFor: vi.fn() };
  const user = {
    userId: 'usr_1',
    tenantId: 'ten_1',
    audience: 'buyer',
    roles: [],
    perms: [PERMISSIONS.INVOICE_READ_TENANT] as string[],
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InvoicesController],
      providers: [
        { provide: InvoiceService, useValue: invoices },
        { provide: InvoiceQueryService, useValue: query },
        { provide: MatchService, useValue: match },
        { provide: StorageService, useValue: { put: vi.fn(), presignedGetUrl: vi.fn() } },
        { provide: APP_FILTER, useClass: ProblemExceptionFilter },
        // Global guard stub that authenticates the request as a fixed AP user.
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

  afterEach(() => {
    user.perms = [PERMISSIONS.INVOICE_READ_TENANT];
    query.assertVisible.mockReset();
  });

  it('GET /invoices returns the filtered list', async () => {
    query.find.mockResolvedValueOnce({
      items: [{ number: 'INV-4471' }],
      nextCursor: null,
      totalEstimate: 1,
    });
    const res = await request(app.getHttpServer()).get('/invoices?tab=exceptions');
    expect(res.status).toBe(200);
    expect(res.body.items[0].number).toBe('INV-4471');
    // Second arg is the scope: null = the whole tenant's AP book.
    expect(query.find).toHaveBeenCalledWith(
      expect.objectContaining({ tab: 'exceptions' }),
      null,
    );
  });

  it('narrows the list to the caller when they only hold the assigned scope', async () => {
    user.perms = [PERMISSIONS.INVOICE_READ_ASSIGNED];
    query.find.mockResolvedValueOnce({ items: [], nextCursor: null, totalEstimate: 0 });
    const res = await request(app.getHttpServer()).get('/invoices?tab=all');
    expect(res.status).toBe(200);
    expect(query.find).toHaveBeenCalledWith(expect.objectContaining({ tab: 'all' }), {
      userId: 'usr_1',
      team: false,
    });
  });

  it('flags the team scope for a head so their officers’ invoices come back', async () => {
    user.perms = [PERMISSIONS.INVOICE_READ_ASSIGNED, PERMISSIONS.INVOICE_READ_TEAM];
    query.find.mockResolvedValueOnce({ items: [], nextCursor: null, totalEstimate: 0 });
    await request(app.getHttpServer()).get('/invoices?tab=all');
    expect(query.find).toHaveBeenCalledWith(expect.anything(), {
      userId: 'usr_1',
      team: true,
    });
  });

  it('404s an action on an invoice outside the caller’s scope', async () => {
    user.perms = [PERMISSIONS.INVOICE_READ_ASSIGNED, PERMISSIONS.INVOICE_RESOLVE_EXCEPTION];
    query.assertVisible.mockRejectedValueOnce(new NotFoundException('Invoice not found'));
    const res = await request(app.getHttpServer()).post(
      '/invoices/inv_someone_else/resolve-and-route',
    );
    expect(res.status).toBe(404);
    expect(invoices.resolveAndRoute).not.toHaveBeenCalledWith(
      'inv_someone_else',
      'usr_1',
    );
  });

  it('POST /invoices/:id/exceptions/:excId/resolve delegates to MatchService', async () => {
    match.resolveException.mockResolvedValueOnce(undefined);
    const res = await request(app.getHttpServer())
      .post('/invoices/inv_4471/exceptions/exc_1/resolve')
      .send({ action: 'ACCEPT_VARIANCE', notes: 'within tolerance' });
    expect(res.status).toBe(201);
    expect(match.resolveException).toHaveBeenCalledWith(
      'inv_4471',
      'exc_1',
      'ACCEPT_VARIANCE',
      'within tolerance',
      'usr_1',
    );
  });

  it('rejects an invalid resolution action as 422 problem+json', async () => {
    const res = await request(app.getHttpServer())
      .post('/invoices/inv_4471/exceptions/exc_1/resolve')
      .send({ action: 'NONSENSE' });
    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('POST /invoices/:id/resolve-and-route delegates to InvoiceService', async () => {
    invoices.resolveAndRoute.mockResolvedValueOnce(undefined);
    const res = await request(app.getHttpServer()).post(
      '/invoices/inv_4471/resolve-and-route',
    );
    expect(res.status).toBe(201);
    expect(invoices.resolveAndRoute).toHaveBeenCalledWith('inv_4471', 'usr_1');
  });
});
