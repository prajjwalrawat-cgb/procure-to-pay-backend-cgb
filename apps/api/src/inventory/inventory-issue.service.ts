import { Injectable } from '@nestjs/common';
import type { IssueCreateInput, IssueReturnInput } from '@procureflow/shared';

import { AuditLogService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryLedgerService } from './inventory-ledger.service';
import { InventoryValidationError, LedgerStateError } from './inventory.errors';
import { LocationService } from './location.service';
import { ProductService } from './product.service';

/**
 * InventoryIssueService (Slice 12c). The internal issue lifecycle — stock going
 * out to the photoshoot team, a sales person, or another place/person, and
 * coming back in whole or in part (business rule 3).
 *
 * Balance handling deserves a note. `StockLedgerEntry.balanceQty` on the issue
 * row is an immutable *snapshot* of the quantity issued; the authoritative open
 * balance is always derived as `issued - SUM(linked INTERNAL_RETURN rows)`.
 * Decrementing a stored counter would mean mutating a posted ledger row, which
 * the insert-only design (and the DB trigger) forbids — and a counter can drift,
 * whereas a derivation cannot. Status is derived the same way: balance > 0 is
 * Open, 0 is Closed.
 */
@Injectable()
export class InventoryIssueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: InventoryLedgerService,
    private readonly products: ProductService,
    private readonly locations: LocationService,
    private readonly audit: AuditLogService,
  ) {}

  /** POST /inventory/issues — INTERNAL_ISSUE. */
  async issue(input: IssueCreateInput, actorId: string): Promise<{ id: string }> {
    await this.products.require(input.productId);
    await this.locations.require(input.locationId);
    await this.assertApprovalWhereRequired(input);

    const id = await this.ledger.post({
      productId: input.productId,
      locationId: input.locationId,
      txnType: 'INTERNAL_ISSUE',
      qty: input.qty,
      issueDept: input.issueDept,
      issuedToName: input.issuedToName.trim(),
      approvedById: input.approvedById ?? null,
      // Snapshot of what went out; never mutated (see the class comment).
      balanceQty: input.qty,
      tentativeReturnDate: input.tentativeReturnDate
        ? new Date(input.tentativeReturnDate)
        : null,
      customerName: input.customerName ?? null,
      performedById: actorId,
      remark: input.remark ?? null,
      txnDate: input.txnDate ? new Date(input.txnDate) : null,
    });

    await this.audit.record({
      action: 'INVENTORY_ISSUE_POSTED',
      entityType: 'StockLedgerEntry',
      entityId: id,
      actorId,
      after: {
        productId: input.productId,
        qty: input.qty,
        issueDept: input.issueDept,
        issuedToName: input.issuedToName,
        approvedById: input.approvedById ?? null,
      },
    });
    return { id };
  }

  /**
   * POST /inventory/issues/:id/return — INTERNAL_RETURN, partial or full.
   * Returns beyond the outstanding balance are refused, so the derived balance
   * can never go negative across any sequence of partial returns.
   */
  async recordReturn(
    issueEntryId: string,
    input: IssueReturnInput,
    actorId: string,
  ): Promise<{ id: string; balanceQty: number; status: 'OPEN' | 'CLOSED' }> {
    const issue = await this.prisma.client.stockLedgerEntry.findUnique({
      where: { id: issueEntryId },
    });
    if (!issue) throw new LedgerStateError(`Issue ${issueEntryId} not found.`);
    if (issue.txnType !== 'INTERNAL_ISSUE') {
      throw new LedgerStateError(
        `Entry ${issueEntryId} is a ${issue.txnType}, not an internal issue.`,
      );
    }

    const outstanding = await this.ledger.openBalanceForIssue(issueEntryId);
    if (outstanding <= 0) {
      throw new LedgerStateError('This issue is already fully returned.');
    }
    if (input.qty > outstanding) {
      throw new LedgerStateError(
        `Return quantity ${input.qty} exceeds the outstanding balance of ${outstanding}.`,
        { issueEntryId, outstanding, requested: input.qty },
      );
    }

    const locationId = input.locationId ?? issue.locationId;
    if (input.locationId) await this.locations.require(input.locationId);

    const id = await this.ledger.post({
      productId: issue.productId,
      locationId,
      txnType: 'INTERNAL_RETURN',
      qty: input.qty,
      issueDept: issue.issueDept,
      issuedToName: issue.issuedToName,
      issueEntryId,
      performedById: actorId,
      remark: input.remark ?? null,
      txnDate: input.txnDate ? new Date(input.txnDate) : null,
    });

    const balanceQty = outstanding - input.qty;
    await this.audit.record({
      action: 'INVENTORY_ISSUE_RETURNED',
      entityType: 'StockLedgerEntry',
      entityId: id,
      actorId,
      after: { issueEntryId, qty: input.qty, balanceQty },
    });
    return { id, balanceQty, status: balanceQty > 0 ? 'OPEN' : 'CLOSED' };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Business rule 3 — issues at or above the tenant's configured quantity or
   * value threshold require a named approver. Value is estimated from the most
   * recent inward rate for the product, since an issue carries no price of its
   * own; when no rate has ever been recorded only the quantity gate applies.
   */
  private async assertApprovalWhereRequired(input: IssueCreateInput): Promise<void> {
    if (input.approvedById) return;

    const tenant = await this.prisma.client.tenant.findUnique({
      where: { id: this.tenantId() },
      select: { inventoryIssueApprovalQty: true, inventoryIssueApprovalValue: true },
    });
    const qtyThreshold = tenant?.inventoryIssueApprovalQty ?? 50;
    const valueThreshold = Number(tenant?.inventoryIssueApprovalValue ?? 25_000);

    if (input.qty >= qtyThreshold) {
      throw new InventoryValidationError(
        `Issues of ${qtyThreshold} units or more require an approver (approvedById).`,
        { qty: input.qty, qtyThreshold },
      );
    }

    const lastRate = await this.prisma.client.stockLedgerEntry.findFirst({
      where: { productId: input.productId, rate: { not: null } },
      orderBy: [{ txnDate: 'desc' }, { id: 'desc' }],
      select: { rate: true },
    });
    if (!lastRate?.rate) return;

    const estimated = Number(lastRate.rate) * input.qty;
    if (estimated >= valueThreshold) {
      throw new InventoryValidationError(
        `Issues valued at ${valueThreshold} or more require an approver (approvedById). This issue is worth about ${estimated.toFixed(2)}.`,
        { estimatedValue: estimated, valueThreshold },
      );
    }
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
