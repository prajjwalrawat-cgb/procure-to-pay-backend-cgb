import { Injectable, NotFoundException } from '@nestjs/common';
import { newId, type Prisma } from '@procureflow/db';
import type { ContractClauseType, PoTermInput, PoTermView } from '@procureflow/shared';

import { AuditLogService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { PurchaseOrderStateError } from './purchase-order.errors';

/**
 * Once issued, the PDF is with the vendor and its hash is recorded on the PO.
 * Editing the terms afterwards would leave the stored document and the database
 * disagreeing about what was agreed — raise an amendment instead.
 */
const TERMS_LOCKED_STATES = new Set([
  'ISSUED',
  'ACKNOWLEDGED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'PARTIALLY_INVOICED',
  'INVOICED',
  'CLOSED',
  'CANCELLED',
]);

/**
 * The terms & conditions printed on a PO.
 *
 * Standard conditions come from the same ClauseLibrary that contracts use, so
 * legal maintains one set of wording. They are **copied** onto the PO at
 * selection time rather than referenced: re-issuing an old order must reproduce
 * what was actually agreed, and retiring or re-versioning a library clause must
 * not silently rewrite a PO already sent to a vendor. Special conditions are
 * free text on the order alone and never write back to the library.
 */
@Injectable()
export class PoTermsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async list(poId: string): Promise<PoTermView[]> {
    const rows = await this.prisma.client.purchaseOrderTerm.findMany({
      where: { poId },
      orderBy: { orderNo: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      clauseType: r.clauseType,
      title: r.title,
      contentText: r.contentText,
      isFromLibrary: r.isFromLibrary,
      libraryClauseId: r.libraryClauseId,
      orderNo: r.orderNo,
    }));
  }

  /** Replaces the whole set; array order becomes the printed order. */
  async set(poId: string, terms: PoTermInput[], actorId: string): Promise<PoTermView[]> {
    const po = await this.requirePo(poId);
    if (TERMS_LOCKED_STATES.has(po.status)) {
      throw new PurchaseOrderStateError(
        'Terms can only be changed while the purchase order is a draft or awaiting approval.',
        { status: po.status },
      );
    }

    const tenantId = this.tenantId();
    const rows = terms.map((t, idx) => ({
      id: newId('purchaseOrderTerm'),
      tenantId,
      poId,
      clauseType: t.clauseType as Prisma.PurchaseOrderTermCreateManyInput['clauseType'],
      title: t.title,
      contentText: t.contentText,
      isFromLibrary: t.isFromLibrary,
      libraryClauseId: t.libraryClauseId ?? null,
      orderNo: idx + 1,
    }));

    // Replace wholesale rather than diff: the set is small, order matters, and
    // a partial update would leave gaps in orderNo.
    await this.prisma.client.purchaseOrderTerm.deleteMany({ where: { poId } });
    if (rows.length > 0) {
      await this.prisma.client.purchaseOrderTerm.createMany({ data: rows });
    }

    await this.audit.record({
      action: 'PO_TERMS_SET',
      entityType: 'PurchaseOrder',
      entityId: poId,
      actorId,
      after: {
        count: rows.length,
        titles: rows.map((r) => r.title),
        special: rows.filter((r) => !r.isFromLibrary).map((r) => r.title),
      },
    });

    return this.list(poId);
  }

  /**
   * Seeds a new PO with every clause the library marks `isDefault`, so the
   * common case needs no ticking at all. Called at create time; silently does
   * nothing when the library is empty, in which case the PDF falls back to its
   * built-in wording.
   */
  async applyLibraryDefaults(poId: string, actorId: string): Promise<void> {
    const defaults = await this.prisma.client.clauseLibrary.findMany({
      where: { isDefault: true },
      orderBy: { clauseType: 'asc' },
    });
    if (defaults.length === 0) return;

    await this.set(
      poId,
      defaults.map((c) => ({
        clauseType: c.clauseType as ContractClauseType,
        title: c.title,
        contentText: c.contentText,
        isFromLibrary: true,
        libraryClauseId: c.id,
      })),
      actorId,
    );
  }

  private async requirePo(id: string): Promise<{ id: string; status: string }> {
    const po = await this.prisma.client.purchaseOrder.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    return po;
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
