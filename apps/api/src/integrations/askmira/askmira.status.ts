import { UnprocessableEntityException } from '@nestjs/common';

import { clean } from './askmira.tokens';

/** Plain words people use for a status, as the documents' own statuses. */
const STATUS_WORDS: Record<string, string> = {
  PENDING: 'AWAITING_APPROVAL',
  WAITING: 'AWAITING_APPROVAL',
  FOR_APPROVAL: 'AWAITING_APPROVAL',
  PENDING_FOR_APPROVAL: 'AWAITING_APPROVAL',
  HOLD: 'ON_HOLD',
};

/**
 * The status asked for, checked against the document's own list. An unknown one is
 * refused with the list (a bad enum value would otherwise fail the whole query).
 */
export function statusOf<T extends string>(
  params: Record<string, unknown>,
  allowed: Record<string, T>,
  what: string,
): T | null {
  const raw = clean(params.status, 40);
  if (!raw) return null;
  const asked = raw.toUpperCase().replace(/[\s-]+/g, '_');
  const values = Object.values(allowed);
  const word = STATUS_WORDS[asked] ?? asked;
  // Invoices say HELD where orders say ON_HOLD.
  const hit = values.find((v) => v === word || (word === 'ON_HOLD' && v === 'HELD'));
  if (!hit) {
    throw new UnprocessableEntityException(
      `${what} have no status "${raw}". Use one of: ${values.join(', ')}.`,
    );
  }
  return hit;
}
