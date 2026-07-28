import { describe, expect, it, vi } from 'vitest';

import { InventoryReceiptService } from './inventory-receipt.service';
import { LedgerStateError, PoRequiredError } from './inventory.errors';

/** Every receipt input field the schema would have defaulted. */
const baseReceipt = {
  productId: 'prd_1',
  locationId: 'loc_1',
  qty: 250,
  nonPoReceipt: false,
  qcStatus: 'PENDING' as const,
  damageQty: 0,
};

function makeService(opts: { po?: { number: string; status: string } | null } = {}) {
  const posts: Record<string, unknown>[] = [];
  let n = 0;

  const client = {
    purchaseOrder: {
      findUnique: vi.fn(async () =>
        opts.po === undefined
          ? { id: 'po_1', number: 'PO-0481', status: 'ISSUED' }
          : opts.po,
      ),
    },
    stockLedgerEntry: { findUnique: vi.fn(), update: vi.fn(async () => ({})) },
  };

  const ledger = {
    post: vi.fn(async (input: Record<string, unknown>) => {
      posts.push(input);
      n += 1;
      return `sle_${n}`;
    }),
  } as never;

  const service = new InventoryReceiptService(
    { client, currentTenantId: 'ten_1' } as never,
    ledger,
    { require: vi.fn(async () => ({ id: 'prd_1' })) } as never,
    { require: vi.fn(async () => ({ id: 'loc_1' })) } as never,
    { record: vi.fn(async () => undefined) } as never,
    { emit: vi.fn(async () => undefined) } as never,
  );
  return { service, client, posts };
}

describe('receive — PO requirement (business rule 1)', () => {
  it('posts a VENDOR_INWARD against a receivable PO', async () => {
    const { service, posts } = makeService();
    await service.receive({ ...baseReceipt, purchaseOrderId: 'po_1' }, 'usr_1');
    expect(posts[0]).toMatchObject({ txnType: 'VENDOR_INWARD', qty: 250, purchaseOrderId: 'po_1' });
  });

  it('refuses a receipt with no PO and no override', async () => {
    const { service } = makeService();
    await expect(service.receive({ ...baseReceipt }, 'usr_1')).rejects.toBeInstanceOf(
      PoRequiredError,
    );
  });

  it('refuses a PO that does not exist', async () => {
    const { service } = makeService({ po: null });
    await expect(
      service.receive({ ...baseReceipt, purchaseOrderId: 'po_missing' }, 'usr_1'),
    ).rejects.toThrow(/does not exist/i);
  });

  it.each(['DRAFT', 'AWAITING_APPROVAL', 'CANCELLED', 'CLOSED'])(
    'refuses a PO in %s',
    async (status) => {
      const { service } = makeService({ po: { number: 'PO-0481', status } });
      await expect(
        service.receive({ ...baseReceipt, purchaseOrderId: 'po_1' }, 'usr_1'),
      ).rejects.toThrow(/cannot receive goods/i);
    },
  );

  it.each(['APPROVED', 'ISSUED', 'ACKNOWLEDGED', 'PARTIALLY_RECEIVED'])(
    'accepts a PO in %s',
    async (status) => {
      const { service, posts } = makeService({ po: { number: 'PO-0481', status } });
      await service.receive({ ...baseReceipt, purchaseOrderId: 'po_1' }, 'usr_1');
      expect(posts).toHaveLength(1);
    },
  );

  it('allows a Challan-only receipt behind the explicit override', async () => {
    const { service, client, posts } = makeService();
    await service.receive(
      { ...baseReceipt, nonPoReceipt: true, nonPoReason: 'Challan 3477, no PO raised' },
      'usr_1',
    );
    expect(client.purchaseOrder.findUnique).not.toHaveBeenCalled();
    // The exception is recorded on the entry so it stays auditable.
    expect(String(posts[0]?.remark)).toMatch(/Non-PO receipt: Challan 3477/);
  });
});

describe('receive — damaged and rejected stock never reaches sellable stock', () => {
  it('writes off the damaged portion of a receipt', async () => {
    const { service, posts } = makeService();
    await service.receive(
      { ...baseReceipt, purchaseOrderId: 'po_1', qty: 100, damageQty: 30 },
      'usr_1',
    );
    // Full 100 arrives (Total IN stays honest), then 30 is written back off.
    expect(posts[0]).toMatchObject({ txnType: 'VENDOR_INWARD', qty: 100, damageQty: 30 });
    expect(posts[1]).toMatchObject({ txnType: 'DAMAGE_WRITE_OFF', qty: 30 });
  });

  it('holds the whole consignment out of stock when rejected on arrival', async () => {
    const { service, posts } = makeService();
    await service.receive(
      { ...baseReceipt, purchaseOrderId: 'po_1', qty: 100, qcStatus: 'REJECTED' },
      'usr_1',
    );
    expect(posts[1]).toMatchObject({ txnType: 'DAMAGE_WRITE_OFF', qty: 100 });
    expect(String(posts[1]?.remark)).toMatch(/QC rejected on arrival/);
  });

  it('posts a single entry when nothing is damaged or rejected', async () => {
    const { service, posts } = makeService();
    await service.receive({ ...baseReceipt, purchaseOrderId: 'po_1' }, 'usr_1');
    expect(posts).toHaveLength(1);
  });
});

describe('recordQc — the QC gate (business rule 2)', () => {
  function withEntry(entry: Record<string, unknown>) {
    const made = makeService();
    made.client.stockLedgerEntry.findUnique.mockResolvedValue({
      id: 'sle_1',
      txnType: 'VENDOR_INWARD',
      qty: 100,
      productId: 'prd_1',
      locationId: 'loc_1',
      vendorId: 'ven_1',
      purchaseOrderId: 'po_1',
      grnNo: null,
      qcStatus: 'PENDING',
      ...entry,
    });
    return made;
  }

  it('routes rejected stock back to the vendor for repair', async () => {
    const { service, posts } = withEntry({});
    const res = await service.recordQc(
      'sle_1',
      { qcStatus: 'REJECTED', rejectedQty: 100, disposition: 'RETURN_TO_VENDOR' },
      'usr_1',
    );
    expect(posts[0]).toMatchObject({ txnType: 'VENDOR_RETURN_OUT', qty: 100, correctionOfId: 'sle_1' });
    expect(res.dispositionEntryId).toBe('sle_1');
  });

  it('writes rejected stock off when that is the disposition', async () => {
    const { service, posts } = withEntry({});
    await service.recordQc(
      'sle_1',
      { qcStatus: 'REJECTED', rejectedQty: 40, disposition: 'WRITE_OFF' },
      'usr_1',
    );
    expect(posts[0]).toMatchObject({ txnType: 'DAMAGE_WRITE_OFF', qty: 40 });
  });

  it('rejects the whole receipt when no partial quantity is given', async () => {
    const { service, posts } = withEntry({});
    await service.recordQc(
      'sle_1',
      { qcStatus: 'REJECTED', disposition: 'WRITE_OFF' },
      'usr_1',
    );
    expect(posts[0]).toMatchObject({ qty: 100 });
  });

  it('posts no disposition movement when QC passes', async () => {
    const { service, posts } = withEntry({});
    const res = await service.recordQc('sle_1', { qcStatus: 'OK' }, 'usr_1');
    expect(posts).toHaveLength(0);
    expect(res.dispositionEntryId).toBeNull();
  });

  it('refuses to re-decide a receipt that already has a verdict', async () => {
    const { service } = withEntry({ qcStatus: 'OK' });
    await expect(
      service.recordQc('sle_1', { qcStatus: 'REJECTED', disposition: 'WRITE_OFF' }, 'usr_1'),
    ).rejects.toBeInstanceOf(LedgerStateError);
  });

  it('refuses a rejected quantity larger than what was received', async () => {
    const { service } = withEntry({});
    await expect(
      service.recordQc(
        'sle_1',
        { qcStatus: 'REJECTED', rejectedQty: 500, disposition: 'WRITE_OFF' },
        'usr_1',
      ),
    ).rejects.toThrow(/exceeds the received quantity/i);
  });

  it('refuses QC on a movement that is not a receipt', async () => {
    const { service } = withEntry({ txnType: 'CUSTOMER_ORDER_OUT' });
    await expect(service.recordQc('sle_1', { qcStatus: 'OK' }, 'usr_1')).rejects.toThrow(
      /receipts only/i,
    );
  });
});
