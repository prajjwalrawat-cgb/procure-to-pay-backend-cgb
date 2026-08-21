import type { ScanEventView } from '@procureflow/shared';

/**
 * Idempotency for scan submissions (Slice 13).
 *
 * The handset writes every scan to its local queue *before* it goes to the wire,
 * so a dropped response is indistinguishable from a dropped request: the queue
 * retries. Without a key, a warehouse with flaky wifi silently double-receives
 * stock — and the ledger is immutable, so the only fix is a correcting
 * ADJUSTMENT and an awkward conversation.
 *
 * The key is the client-generated `clientUuid`, unique per tenant at the
 * database level. Two paths must both hold:
 *   - the *read* path: a replay finds the original scan and returns its result
 *   - the *write* path: two simultaneous replays race, one loses on the unique
 *     index, and the loser re-reads instead of surfacing a 500
 */

/** Prisma's unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

/**
 * True when an error is the `(tenant_id, client_uuid)` unique violation — i.e.
 * a concurrent replay of the same scan beat us to the insert.
 */
export function isDuplicateScan(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code !== UNIQUE_VIOLATION) return false;
  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  return fields.some((f) => f.includes('client_uuid') || f.includes('clientUuid'));
}

/** Row shape every scan reconstruction needs. */
export interface StoredScan {
  id: string;
  scanType: string;
  productId: string;
  quantity: number;
  locationId: string | null;
  clientUuid: string;
  ledgerEntryId: string | null;
  createdAt: Date;
  syncedAt: Date | null;
}

/** Map a stored scan row to the wire view. */
export function toScanEventView(row: StoredScan): ScanEventView {
  return {
    id: row.id,
    scanType: row.scanType as ScanEventView['scanType'],
    productId: row.productId,
    quantity: row.quantity,
    locationId: row.locationId,
    clientUuid: row.clientUuid,
    ledgerEntryId: row.ledgerEntryId,
    createdAt: row.createdAt.toISOString(),
    syncedAt: row.syncedAt ? row.syncedAt.toISOString() : null,
  };
}

/** Columns to select when loading a scan for replay. */
export const SCAN_EVENT_SELECT = {
  id: true,
  scanType: true,
  productId: true,
  quantity: true,
  locationId: true,
  clientUuid: true,
  ledgerEntryId: true,
  createdAt: true,
  syncedAt: true,
} as const;
