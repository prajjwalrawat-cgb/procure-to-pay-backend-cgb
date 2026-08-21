import { PERMISSIONS } from '@procureflow/shared';
import { describe, expect, it } from 'vitest';

import { REQUIRED_PERMISSION_KEY } from '../../auth/decorators';
import { ScanController } from './scan.controller';

/**
 * The authority map, asserted rather than assumed.
 *
 * Scanning is a new *input device*, not a new set of privileges: a scanned
 * receipt needs the same grant a keyed-in receipt needs, and approving a count
 * variance — the one scanner action that moves stock with no physical movement
 * behind it — needs the module's existing correction authority. A regression
 * here would silently widen who can move stock, which no integration test
 * exercising the happy path would ever catch.
 */
function permissionFor(method: keyof ScanController): string | string[] {
  const meta = Reflect.getMetadata(
    REQUIRED_PERMISSION_KEY,
    ScanController.prototype[method] as never,
  ) as { permission: string | string[] } | undefined;
  if (!meta) throw new Error(`${String(method)} carries no permission metadata`);
  return meta.permission;
}

describe('scan routes — required permissions', () => {
  it('gates receiving on the stores permission, not on a scanner permission', () => {
    expect(permissionFor('receive')).toBe(PERMISSIONS.STORES_RECEIVE_GOODS);
  });

  it('gates picking on fulfilment authority', () => {
    expect(permissionFor('pick')).toBe(PERMISSIONS.INVENTORY_FULFILL);
    expect(permissionFor('pickList')).toBe(PERMISSIONS.INVENTORY_FULFILL);
  });

  it('gates counting on the scanner permission', () => {
    expect(permissionFor('startCount')).toBe(PERMISSIONS.INVENTORY_SCAN);
    expect(permissionFor('countScan')).toBe(PERMISSIONS.INVENTORY_SCAN);
    expect(permissionFor('completeCount')).toBe(PERMISSIONS.INVENTORY_SCAN);
  });

  it('gates count approval on adjustment authority — a counter cannot approve', () => {
    // The step that writes ADJUSTMENT rows to an immutable ledger.
    expect(permissionFor('approveCount')).toBe(PERMISSIONS.INVENTORY_ADJUST);
    expect(permissionFor('approveCount')).not.toBe(permissionFor('countScan'));
  });

  it('gates putaway and transfer on the scanner permission', () => {
    expect(permissionFor('putaway')).toBe(PERMISSIONS.INVENTORY_SCAN);
    expect(permissionFor('transfer')).toBe(PERMISSIONS.INVENTORY_SCAN);
  });

  it('requires only read access to resolve a barcode', () => {
    expect(permissionFor('resolveBarcode')).toBe(PERMISSIONS.INVENTORY_READ);
  });

  it('admits batch sync on the scanner permission — per-item checks do the rest', () => {
    expect(permissionFor('batchSync')).toBe(PERMISSIONS.INVENTORY_SCAN);
  });
});

describe('cycle count permissions — the separation that matters', () => {
  it('never lets the counting permission alone approve its own variances', () => {
    const counting = permissionFor('countScan');
    const approving = permissionFor('approveCount');
    // Roles granted INVENTORY_SCAN for counting do not thereby gain the power to
    // accept the shortfall they just counted.
    expect(counting).not.toEqual(approving);
  });
});
