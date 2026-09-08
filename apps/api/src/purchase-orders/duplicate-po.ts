import type { PoDuplicateRef } from '@procureflow/shared';
import Decimal from 'decimal.js';

/**
 * Duplicate-PO detection.
 *
 * The case this exists for: two buyers (or one buyer twice) raise the same order
 * against the same vendor days apart, and nothing in the create path notices —
 * both drafts route through approval independently and both get issued, so the
 * vendor ships twice and invoices twice.
 *
 * Matching is deliberately on the *lines*, not on the item master: a spot buy
 * carries no `itemId` at all, so the only thing two duplicate orders reliably
 * share is the description the buyer typed and the quantity. That text is typed
 * fresh each time — "SLEEVES" one day, "Sleeves" the next — so it is normalised
 * before comparison, and the line set is compared order-independently because
 * nothing forces a buyer to enter the lines in the same sequence twice.
 *
 * The result is advisory: a genuine repeat order to the same vendor is normal
 * procurement, so the caller warns and lets the buyer confirm rather than
 * blocking (see `DuplicatePurchaseOrderError`).
 */

/**
 * How far back a matching order is worth flagging.
 *
 * Deliberately short. Two orders to the same vendor for the same goods are a
 * routine repeat purchase — each with its own receipt and its own invoice — so
 * a long window would fire on ordinary work and train buyers to click the
 * warning away without reading it. A week catches the mistake this is actually
 * for: the same order keyed twice before anyone noticed the first.
 */
export const DUPLICATE_WINDOW_DAYS = 7;

/**
 * Statuses that mean the order no longer stands, so re-raising it is not a
 * duplicate but the intended correction. Everything else — including CLOSED —
 * still flags: a closed order re-entered by accident is exactly the mistake
 * this is here to catch.
 */
export const DUPLICATE_IGNORED_STATUSES = ['CANCELLED'] as const;

export interface FingerprintLine {
  itemDesc: string;
  /** Prisma.Decimal, decimal.js Decimal, or a plain numeric string. */
  qtyOrdered: { toString(): string };
}

/**
 * `  Packaging   Cover ` and `PACKAGING COVER` are the same item to a human, so
 * they must be the same token here. Case and whitespace are the only things
 * folded — punctuation and spelling are left alone, since collapsing those
 * starts matching lines that genuinely differ.
 */
function normalizeDesc(desc: string): string {
  return desc.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** `200` and `200.0000` are the same quantity. */
function normalizeQty(qty: { toString(): string }): string {
  try {
    return new Decimal(qty.toString()).toFixed(4);
  } catch {
    // A quantity that will not parse cannot be compared numerically; fall back
    // to the raw text so the line still participates in the fingerprint.
    return qty.toString();
  }
}

/**
 * Order-independent fingerprint of a PO's line set. Two POs are the same order
 * when their fingerprints match — same descriptions, same quantities, same
 * number of lines, in any sequence.
 *
 * Price is deliberately excluded: a re-quote at a different rate for the same
 * goods is still the same purchase, and the buyer should see the warning.
 *
 * The separators are control characters a typed description cannot contain, so
 * no two different line sets can concatenate into the same fingerprint.
 */
export function lineFingerprint(lines: readonly FingerprintLine[]): string {
  return lines
    .map((l) => `${normalizeDesc(l.itemDesc)}\u0000${normalizeQty(l.qtyOrdered)}`)
    .sort()
    .join('\u0001');
}

/** The earliest creation date still inside the duplicate window. */
export function duplicateWindowStart(now: Date = new Date()): Date {
  return new Date(now.getTime() - DUPLICATE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/** What the UI needs to name the order the new one collided with — shared with
 *  the frontend, which reads it back off the 409's problem+json. */
export type DuplicatePoRef = PoDuplicateRef;
