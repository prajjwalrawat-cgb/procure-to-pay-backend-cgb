import { PERMISSIONS } from '@procureflow/shared';

import type { AuthUser } from '../auth/auth.types';

/**
 * Who may read an invoice, and how much of the book they see (Master Context §5).
 *
 * `invoice:read:tenant` is the AP inbox: finance, audit, MD, tenant admin — the
 * whole book. Procurement and plant roles hold `invoice:read:assigned` instead,
 * which is not "nothing": a buyer must be able to follow the invoice their own
 * purchase order attracted, and route it once the match is clean. So the narrow
 * scope resolves to *my* invoices — assigned to me, billed against a PO I
 * raised, or routed to me for approval — and never to somebody else's supplier
 * bills. `invoice:read:team` widens that to the buyers a head oversees.
 */
export const INVOICE_READ_SCOPES = [
  PERMISSIONS.INVOICE_READ_TENANT,
  PERMISSIONS.INVOICE_READ_ASSIGNED,
  PERMISSIONS.INVOICE_READ_TEAM,
];

/** A caller's read scope. `null` means the whole tenant — no narrowing at all. */
export interface InvoiceScope {
  userId: string;
  /** Also see every procurement buyer's invoices, not just this user's. */
  team: boolean;
}

/**
 * Resolve a caller to a scope. Decided in one place rather than in every
 * handler, so a new route cannot quietly forget to narrow.
 */
export function invoiceScope(user: AuthUser): InvoiceScope | null {
  if (user.perms.includes(PERMISSIONS.INVOICE_READ_TENANT)) return null;
  return {
    userId: user.userId,
    team: user.perms.includes(PERMISSIONS.INVOICE_READ_TEAM),
  };
}
