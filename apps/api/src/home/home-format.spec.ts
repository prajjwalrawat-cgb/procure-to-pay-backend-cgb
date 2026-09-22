import { describe, expect, it } from 'vitest';

import {
  activityFromAudit,
  activityFromException,
  buildPipelineStages,
  humanizeEnum,
  mergeActivity,
  shortName,
  type AuditRowLike,
} from './home-format';

const audit = (over: Partial<AuditRowLike>): AuditRowLike => ({
  id: 'aud_1',
  timestamp: new Date('2026-09-21T10:00:00Z'),
  action: 'APPROVAL_DECIDED',
  entityType: 'PurchaseOrder',
  entityId: 'po_1',
  actorId: 'usr_1',
  actorType: 'USER',
  before: { approvalId: 'apr_1', stepNo: 2 },
  after: { decision: 'APPROVED', comment: null },
  ...over,
});

describe('buildPipelineStages', () => {
  it('always has Submitted, then one stage per later step labelled by the most common step name', () => {
    const stages = buildPipelineStages(
      [
        { step: 1, count: 4 },
        { step: 3, count: 1 },
        { step: 2, count: 2 },
      ],
      [
        { step: 2, name: 'Plant Head', count: 7 },
        { step: 2, name: 'HOD', count: 2 },
        { step: 3, name: 'Finance Head', count: 3 },
      ],
    );
    expect(stages).toEqual([
      { key: 'submitted', label: 'Submitted', count: 4 },
      { key: 'step_2', label: 'Plant Head', count: 2 },
      { key: 'step_3', label: 'Finance Head', count: 1 },
    ]);
  });

  it('falls back to "Step N" for unnamed steps and keeps an empty Submitted stage', () => {
    const stages = buildPipelineStages([{ step: 4, count: 1 }], []);
    expect(stages).toEqual([
      { key: 'submitted', label: 'Submitted', count: 0 },
      { key: 'step_4', label: 'Step 4', count: 1 },
    ]);
  });
});

describe('activityFromAudit', () => {
  it('maps APPROVAL_DECIDED by decision, with the document number, actor and href', () => {
    const item = activityFromAudit(audit({}), { ref: 'PO-0502' }, 'R. Das');
    expect(item).toMatchObject({
      kind: 'approval',
      title: 'PO-0502 approved at step 2',
      detail: 'by R. Das · Purchase order',
      href: '/purchase-orders/po_1',
    });
    expect(
      activityFromAudit(audit({ after: { decision: 'REJECTED' } }), { ref: 'PO-0502' }, null)?.kind,
    ).toBe('rejection');
    expect(
      activityFromAudit(audit({ after: { decision: 'CHANGES_REQUESTED' } }), undefined, null)?.title,
    ).toBe('Purchase order sent back for changes');
  });

  it('maps the other allow-listed actions to their kinds', () => {
    const k = (action: string, entityType: string) =>
      activityFromAudit(audit({ action, entityType, entityId: 'x_1' }), { ref: 'N-1' }, null)?.kind;
    expect(k('DOCUMENT_APPROVED', 'Requisition')).toBe('approval');
    expect(k('SUBMITTED_FOR_APPROVAL', 'Requisition')).toBe('submission');
    expect(k('CONTRACT_SUBMITTED_FOR_APPROVAL', 'Contract')).toBe('submission');
    expect(k('BANK_BATCH_CONFIRMED', 'PaymentRun')).toBe('payment');
    expect(k('PAYMENT_RECORDED', 'Invoice')).toBe('payment');
    expect(k('GRN_POSTED', 'GoodsReceiptNote')).toBe('receipt');
    expect(k('PO_ISSUED', 'PurchaseOrder')).toBe('order');
    expect(k('USER_LOGIN', 'User')).toBeUndefined();
  });

  it('links a contract amendment to its contract and labels system actors', () => {
    const item = activityFromAudit(
      audit({ action: 'PAYMENT_RECORDED', entityType: 'Invoice', actorId: null, actorType: 'SYSTEM' }),
      { ref: 'INV-9' },
      null,
    );
    expect(item?.detail).toBe('System · Invoice');
    const amend = activityFromAudit(
      audit({ action: 'DOCUMENT_APPROVED', entityType: 'ContractAmendment', entityId: 'cam_1' }),
      { ref: 'CT-1 amendment 2', hrefId: 'ct_1' },
      null,
    );
    expect(amend?.href).toBe('/contracts/ct_1');
  });
});

describe('activityFromException', () => {
  it('names the exception type and invoice', () => {
    const item = activityFromException(
      {
        id: 'exc_1',
        invoiceId: 'inv_1',
        exceptionType: 'PRICE_VARIANCE',
        severity: 'HIGH',
        raisedAt: new Date('2026-09-20T00:00:00Z'),
      },
      'INV-0042',
      null,
    );
    expect(item).toMatchObject({
      kind: 'exception',
      title: 'Price variance on INV-0042',
      detail: 'Auto-detected · High severity',
      href: '/invoices/inv_1',
    });
  });
});

describe('mergeActivity', () => {
  const it_ = (id: string, at: string) => ({
    id,
    at,
    kind: 'order' as const,
    title: id,
    detail: null,
    href: null,
  });
  it('sorts newest first and sets the cursor only when more remain', () => {
    const items = [it_('a', '2026-09-01T00:00:00.000Z'), it_('b', '2026-09-03T00:00:00.000Z'), it_('c', '2026-09-02T00:00:00.000Z')];
    const page = mergeActivity(items, 2);
    expect(page.items.map((i) => i.id)).toEqual(['b', 'c']);
    expect(page.nextBefore).toBe('2026-09-02T00:00:00.000Z');
    expect(mergeActivity(items, 3).nextBefore).toBeNull();
  });
});

describe('humanizeEnum', () => {
  it('sentence-cases and keeps acronyms', () => {
    expect(humanizeEnum('PRICE_VARIANCE')).toBe('Price variance');
    expect(humanizeEnum('GRN_MISSING')).toBe('GRN missing');
    expect(humanizeEnum('GSTIN_MISMATCH')).toBe('GSTIN mismatch');
  });
});

describe('shortName', () => {
  it('abbreviates the first name', () => {
    expect(shortName('Rahul Kumar Das')).toBe('R. Das');
    expect(shortName('Pratibha')).toBe('Pratibha');
    expect(shortName(null)).toBeNull();
  });
});
