import { UnprocessableEntityException } from '@nestjs/common';
import { InvoiceStatus, PoStatus, RequisitionStatus } from '@procureflow/db';
import { describe, expect, it } from 'vitest';

import { statusOf } from './askmira.status';

describe('statusOf', () => {
  it('passes a status the document has, in any case or spacing', () => {
    expect(statusOf({ status: 'approved' }, InvoiceStatus, 'Invoices')).toBe('APPROVED');
    expect(statusOf({ status: 'awaiting approval' }, PoStatus, 'Purchase orders')).toBe(
      'AWAITING_APPROVAL',
    );
    expect(statusOf({ status: 'fully-issued' }, RequisitionStatus, 'Requisitions')).toBe(
      'FULLY_ISSUED',
    );
  });

  it('reads plain words as the status they mean', () => {
    expect(statusOf({ status: 'PENDING' }, InvoiceStatus, 'Invoices')).toBe('AWAITING_APPROVAL');
    expect(statusOf({ status: 'on hold' }, PoStatus, 'Purchase orders')).toBe('ON_HOLD');
    expect(statusOf({ status: 'on hold' }, InvoiceStatus, 'Invoices')).toBe('HELD');
  });

  it('is empty when no status is asked for', () => {
    expect(statusOf({}, InvoiceStatus, 'Invoices')).toBeNull();
    expect(statusOf({ status: '  ' }, InvoiceStatus, 'Invoices')).toBeNull();
  });

  it('refuses a status the document does not have, with the list', () => {
    expect(() => statusOf({ status: 'PAID' }, RequisitionStatus, 'Requisitions')).toThrow(
      UnprocessableEntityException,
    );
    expect(() => statusOf({ status: 'shipped' }, PoStatus, 'Purchase orders')).toThrow(
      /Purchase orders have no status "shipped". Use one of: DRAFT/,
    );
  });
});
