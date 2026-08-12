import { DomainError } from '../common/errors/domain-error';

/**
 * The SKU code is chosen by the buyer, not generated, so a collision is a
 * routine user mistake rather than an internal fault. Without this the unique
 * index on (tenantId, skuCode) surfaces as a raw Prisma P2002, which the global
 * filter renders as an opaque 500.
 *
 * The offending field rides in `context.issues` — the same shape the validation
 * pipe uses — so the form can mark the SKU input instead of only toasting.
 */
export class DuplicateSkuError extends DomainError {
  readonly status = 409;
  readonly type = 'https://procureflow.io/errors/duplicate-sku';
  readonly title = 'SKU code already in use';

  constructor(skuCode: string, existingItemId?: string) {
    super(`SKU code "${skuCode}" is already used by another item.`, {
      skuCode,
      existingItemId,
      issues: [
        {
          path: 'skuCode',
          message: `"${skuCode}" is already used by another item. Choose a different code.`,
        },
      ],
    });
  }
}
