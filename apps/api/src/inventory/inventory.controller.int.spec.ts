import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ProblemExceptionFilter } from '../common/filters/problem.filter';
import { InventoryController } from './inventory.controller';
import { InventoryIssueService } from './inventory-issue.service';
import { InventoryOrderService } from './inventory-order.service';
import { InventoryQueryService } from './inventory-query.service';
import { InventoryReceiptService } from './inventory-receipt.service';
import { InsufficientStockError, PoRequiredError } from './inventory.errors';
import { LocationService } from './location.service';
import { ProductService } from './product.service';

const user = {
  userId: 'usr_1',
  tenantId: 'ten_1',
  audience: 'buyer',
  roles: [],
  perms: [],
};

describe('InventoryController (integration)', () => {
  let app: INestApplication;

  const products = {
    create: vi.fn().mockResolvedValue({ id: 'prd_1', code: 'HD-000001' }),
    update: vi.fn().mockResolvedValue({ ok: true }),
    deactivate: vi.fn().mockResolvedValue({ ok: true }),
  };
  const locations = {
    list: vi.fn().mockResolvedValue({ items: [] }),
    create: vi.fn().mockResolvedValue({ id: 'loc_1' }),
    update: vi.fn().mockResolvedValue({ ok: true }),
    deactivate: vi.fn().mockResolvedValue({ ok: true }),
  };
  const query = {
    listProducts: vi.fn().mockResolvedValue({ items: [], nextCursor: null, totalEstimate: 0 }),
    productDetail: vi.fn().mockResolvedValue({ id: 'prd_1', code: 'HD-000001' }),
    productStock: vi.fn().mockResolvedValue({ productId: 'prd_1', total: 950, locations: [] }),
    ledgerEntries: vi.fn().mockResolvedValue({ items: [], nextCursor: null, totalEstimate: 0 }),
    ledgerEntry: vi.fn().mockResolvedValue({ id: 'sle_1', productId: 'prd_1', signedQty: -12 }),
    pendingDispositions: vi.fn().mockResolvedValue({ qcPending: [], restockPending: [] }),
  };
  const receipts = {
    receive: vi.fn().mockResolvedValue({ id: 'sle_1' }),
    recordQc: vi.fn().mockResolvedValue({ ok: true, dispositionEntryId: null }),
    vendorReturn: vi.fn().mockResolvedValue({ id: 'sle_2' }),
    sampleInward: vi.fn().mockResolvedValue({ id: 'sle_3' }),
  };
  const issues = {
    issue: vi.fn().mockResolvedValue({ id: 'sle_4' }),
    recordReturn: vi.fn().mockResolvedValue({ id: 'sle_5', balanceQty: 5, status: 'OPEN' }),
  };
  const orders = {
    fulfill: vi.fn().mockResolvedValue({ id: 'sle_6' }),
    customerReturn: vi.fn().mockResolvedValue({ id: 'sle_7' }),
    restockDecision: vi.fn().mockResolvedValue({ ok: true, writeOffEntryId: null }),
    writeOffDamage: vi.fn().mockResolvedValue({ id: 'sle_8' }),
    adjust: vi.fn().mockResolvedValue({ id: 'sle_9' }),
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [InventoryController],
      providers: [
        { provide: ProductService, useValue: products },
        { provide: LocationService, useValue: locations },
        { provide: InventoryQueryService, useValue: query },
        { provide: InventoryReceiptService, useValue: receipts },
        { provide: InventoryIssueService, useValue: issues },
        { provide: InventoryOrderService, useValue: orders },
        { provide: APP_FILTER, useClass: ProblemExceptionFilter },
        {
          provide: APP_GUARD,
          useValue: {
            canActivate: (ctx: {
              switchToHttp: () => { getRequest: () => Record<string, unknown> };
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

  describe('reads', () => {
    it('lists products', async () => {
      await request(app.getHttpServer()).get('/inventory/products').expect(200);
      expect(query.listProducts).toHaveBeenCalled();
    });

    it('returns per-location stock for a product', async () => {
      const res = await request(app.getHttpServer())
        .get('/inventory/products/prd_1/stock')
        .expect(200);
      expect(res.body.total).toBe(950);
    });

    it('exposes the ledger with filters', async () => {
      await request(app.getHttpServer())
        .get('/inventory/ledger?txnType=VENDOR_INWARD&limit=10')
        .expect(200);
      expect(query.ledgerEntries).toHaveBeenCalledWith(
        expect.objectContaining({ txnType: 'VENDOR_INWARD', limit: 10 }),
      );
    });

    it('rejects an unknown txnType filter with 422', async () => {
      await request(app.getHttpServer()).get('/inventory/ledger?txnType=TELEPORT').expect(422);
    });

    it('returns one ledger entry so a correction can be pre-filled', async () => {
      const res = await request(app.getHttpServer())
        .get('/inventory/ledger/sle_1')
        .expect(200);
      expect(query.ledgerEntry).toHaveBeenCalledWith('sle_1');
      expect(res.body.signedQty).toBe(-12);
    });

    it('404s for a ledger entry that does not exist', async () => {
      query.ledgerEntry.mockResolvedValueOnce(null);
      await request(app.getHttpServer()).get('/inventory/ledger/sle_nope').expect(404);
    });
  });

  describe('movements', () => {
    it('posts a receipt against a PO', async () => {
      await request(app.getHttpServer())
        .post('/inventory/receipts')
        .send({ productId: 'prd_1', locationId: 'loc_1', qty: 250, purchaseOrderId: 'po_1' })
        .expect(201);
      expect(receipts.receive).toHaveBeenCalled();
    });

    it('rejects a receipt with no PO and no override at the schema boundary', async () => {
      await request(app.getHttpServer())
        .post('/inventory/receipts')
        .send({ productId: 'prd_1', locationId: 'loc_1', qty: 250 })
        .expect(422);
    });

    it('rejects a non-PO receipt with no reason', async () => {
      await request(app.getHttpServer())
        .post('/inventory/receipts')
        .send({ productId: 'prd_1', locationId: 'loc_1', qty: 250, nonPoReceipt: true })
        .expect(422);
    });

    it('renders a PoRequiredError as RFC 7807 problem+json', async () => {
      receipts.receive.mockRejectedValueOnce(new PoRequiredError('PO PO-1 is CLOSED'));
      const res = await request(app.getHttpServer())
        .post('/inventory/receipts')
        .send({ productId: 'prd_1', locationId: 'loc_1', qty: 1, purchaseOrderId: 'po_1' })
        .expect(422);
      expect(res.body.type).toContain('inventory-po-required');
    });

    it('rejects a fractional quantity', async () => {
      await request(app.getHttpServer())
        .post('/inventory/receipts')
        .send({ productId: 'prd_1', locationId: 'loc_1', qty: 2.5, purchaseOrderId: 'po_1' })
        .expect(422);
    });

    it('rejects damageQty greater than qty', async () => {
      await request(app.getHttpServer())
        .post('/inventory/receipts')
        .send({
          productId: 'prd_1',
          locationId: 'loc_1',
          qty: 10,
          damageQty: 11,
          purchaseOrderId: 'po_1',
        })
        .expect(422);
    });

    it('requires a disposition when rejecting at QC', async () => {
      await request(app.getHttpServer())
        .post('/inventory/receipts/sle_1/qc')
        .send({ qcStatus: 'REJECTED' })
        .expect(422);
    });

    it('surfaces an insufficient-stock block as 409', async () => {
      orders.fulfill.mockRejectedValueOnce(new InsufficientStockError('only 2 available'));
      const res = await request(app.getHttpServer())
        .post('/inventory/orders/fulfill')
        .send({ productId: 'prd_1', locationId: 'loc_1', qty: 5 })
        .expect(409);
      expect(res.body.type).toContain('inventory-insufficient-stock');
    });

    it('records an internal issue and its return', async () => {
      await request(app.getHttpServer())
        .post('/inventory/issues')
        .send({
          productId: 'prd_1',
          locationId: 'loc_1',
          qty: 10,
          issueDept: 'SALES',
          issuedToName: 'Mr. Gaurav',
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/inventory/issues/sle_4/return')
        .send({ qty: 5 })
        .expect(201);
      expect(res.body).toMatchObject({ balanceQty: 5, status: 'OPEN' });
    });

    it('rejects an unknown issue department', async () => {
      await request(app.getHttpServer())
        .post('/inventory/issues')
        .send({
          productId: 'prd_1',
          locationId: 'loc_1',
          qty: 1,
          issueDept: 'FINANCE',
          issuedToName: 'X',
        })
        .expect(422);
    });

    it('records a restock decision', async () => {
      await request(app.getHttpServer())
        .post('/inventory/returns/sle_7/restock-decision')
        .send({ restock: false })
        .expect(201);
      expect(orders.restockDecision).toHaveBeenCalled();
    });

    it('rejects a zero-quantity adjustment', async () => {
      await request(app.getHttpServer())
        .post('/inventory/adjustments')
        .send({ productId: 'prd_1', locationId: 'loc_1', signedQty: 0, reason: 'x' })
        .expect(422);
    });

    it('accepts a negative adjustment as a correction', async () => {
      await request(app.getHttpServer())
        .post('/inventory/adjustments')
        .send({
          productId: 'prd_1',
          locationId: 'loc_1',
          signedQty: -12,
          reason: 'Stock count',
          correctionOfId: 'sle_1',
        })
        .expect(201);
      expect(orders.adjust).toHaveBeenCalled();
    });
  });

  /**
   * Verification-checklist item: the ledger is insert-only, so no route may
   * update or delete an entry. This asserts it against the live router rather
   * than by reading the source.
   */
  describe('ledger immutability (business rule 6)', () => {
    it.each([
      ['put', '/inventory/ledger/sle_1'],
      ['patch', '/inventory/ledger/sle_1'],
      ['delete', '/inventory/ledger/sle_1'],
      ['put', '/inventory/receipts/sle_1'],
      ['patch', '/inventory/receipts/sle_1'],
      ['delete', '/inventory/receipts/sle_1'],
      ['delete', '/inventory/issues/sle_1'],
      ['patch', '/inventory/issues/sle_1'],
      ['delete', '/inventory/adjustments/sle_1'],
      ['delete', '/inventory/returns/sle_1'],
    ])('exposes no %s %s route', async (method, path) => {
      const server = app.getHttpServer();
      const res = await (
        request(server) as unknown as Record<string, (p: string) => request.Test>
      )[method](path).send({});
      expect(res.status).toBe(404);
    });

    it('mutation routes exist only for the catalogue, never the ledger', async () => {
      // Sanity check that a 404 above means "no such route", not "app is broken".
      await request(app.getHttpServer())
        .patch('/inventory/products/prd_1')
        .send({ name: 'Renamed' })
        .expect(200);
    });

    it('reading one entry does not make it writable', async () => {
      // GET /inventory/ledger/:id was added for the correction flow; the same
      // path must still reject every write verb.
      const server = app.getHttpServer();
      await request(server).get('/inventory/ledger/sle_1').expect(200);
      await request(server).patch('/inventory/ledger/sle_1').send({ qty: 1 }).expect(404);
      await request(server).delete('/inventory/ledger/sle_1').expect(404);
    });
  });

  /** Backs the product edit drawer: descriptive fields only, never stock. */
  describe('catalogue edits', () => {
    it('updates the descriptive fields of a product', async () => {
      await request(app.getHttpServer())
        .patch('/inventory/products/prd_1')
        .send({
          name: 'Ceramic Mug',
          category: 'Drinkware',
          colour: 'White',
          unit: 'pcs',
          reorderPoint: 25,
          remark: 'Reordered quarterly',
        })
        .expect(200);
      expect(products.update).toHaveBeenCalledWith(
        'prd_1',
        expect.objectContaining({ name: 'Ceramic Mug', reorderPoint: 25 }),
        'usr_1',
      );
    });

    it('rejects an unparseable image URL', async () => {
      await request(app.getHttpServer())
        .patch('/inventory/products/prd_1')
        .send({ imageUrl: 'not-a-url' })
        .expect(422);
    });

    it('retires and reactivates a product without touching its stock', async () => {
      const server = app.getHttpServer();
      await request(server).post('/inventory/products/prd_1/deactivate').expect(201);
      expect(products.deactivate).toHaveBeenCalledWith('prd_1', 'usr_1');

      await request(server)
        .patch('/inventory/products/prd_1')
        .send({ active: true })
        .expect(200);
    });
  });
});
