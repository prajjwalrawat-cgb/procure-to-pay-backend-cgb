import { Injectable } from '@nestjs/common';
import type { ActivityItem, ActivityQuery, ActivityResponse } from '@procureflow/shared';

import { AnalyticsDailyService } from '../analytics/analytics-daily.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ACTIVITY_ACTIONS,
  activityFromAudit,
  activityFromException,
  mergeActivity,
  shortName,
  type DocRef,
} from './home-format';

/**
 * HomeActivityService — the Home activity feed: allow-listed AuditLog events
 * UNION invoice exceptions (by raisedAt), newest first, cursor = `before`.
 * Document numbers and actor names are resolved in one query per entity type
 * (no N+1).
 */
@Injectable()
export class HomeActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly daily: AnalyticsDailyService,
  ) {}

  async getActivity(q: ActivityQuery): Promise<ActivityResponse> {
    const tenantId = this.prisma.currentTenantId;
    if (!tenantId) throw new Error('HomeActivityService requires a tenant context');
    await this.daily.ensureFresh(tenantId);
    const before = q.before ? new Date(q.before) : undefined;
    const take = q.limit + 1;

    const audits = await this.prisma.client.auditLog.findMany({
      where: {
        tenantId,
        action: { in: [...ACTIVITY_ACTIONS] },
        ...(before ? { timestamp: { lt: before } } : {}),
      },
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
      take,
      select: {
        id: true,
        timestamp: true,
        action: true,
        entityType: true,
        entityId: true,
        actorId: true,
        actorType: true,
        before: true,
        after: true,
      },
    });
    const exceptions = await this.prisma.client.invoiceException.findMany({
      where: { tenantId, ...(before ? { raisedAt: { lt: before } } : {}) },
      orderBy: [{ raisedAt: 'desc' }, { id: 'desc' }],
      take,
      select: {
        id: true,
        invoiceId: true,
        exceptionType: true,
        severity: true,
        raisedAt: true,
        raisedBy: true,
      },
    });

    // Bulk-resolve document numbers per entity type.
    const idsByType = new Map<string, Set<string>>();
    const want = (type: string, id: string) => {
      const s = idsByType.get(type) ?? new Set<string>();
      s.add(id);
      idsByType.set(type, s);
    };
    for (const a of audits) want(a.entityType, a.entityId);
    for (const e of exceptions) want('Invoice', e.invoiceId);
    const refs = await this.resolveRefs(idsByType);

    const actorIds = [
      ...new Set(
        [...audits.map((a) => a.actorId), ...exceptions.map((e) => e.raisedBy)].filter(
          (x): x is string => !!x,
        ),
      ),
    ];
    const users = actorIds.length
      ? await this.prisma.client.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameOf = new Map(users.map((u) => [u.id, shortName(u.name)]));

    const items: ActivityItem[] = [];
    for (const a of audits) {
      const item = activityFromAudit(
        a,
        refs.get(`${a.entityType}:${a.entityId}`),
        a.actorId ? (nameOf.get(a.actorId) ?? null) : null,
      );
      if (item) items.push(item);
    }
    for (const e of exceptions) {
      items.push(
        activityFromException(
          e,
          refs.get(`Invoice:${e.invoiceId}`)?.ref,
          nameOf.get(e.raisedBy) ?? null,
        ),
      );
    }
    return mergeActivity(items, q.limit);
  }

  private async resolveRefs(idsByType: Map<string, Set<string>>): Promise<Map<string, DocRef>> {
    const out = new Map<string, DocRef>();
    const ids = (t: string) => [...(idsByType.get(t) ?? [])];
    const put = (t: string, rows: { id: string; number: string }[]) => {
      for (const r of rows) out.set(`${t}:${r.id}`, { ref: r.number });
    };
    const c = this.prisma.client;
    const sel = { id: true, number: true } as const;
    if (ids('Requisition').length)
      put('Requisition', await c.requisition.findMany({ where: { id: { in: ids('Requisition') } }, select: sel }));
    if (ids('PurchaseOrder').length)
      put('PurchaseOrder', await c.purchaseOrder.findMany({ where: { id: { in: ids('PurchaseOrder') } }, select: sel }));
    if (ids('Invoice').length)
      put('Invoice', await c.invoice.findMany({ where: { id: { in: ids('Invoice') } }, select: sel }));
    if (ids('PaymentRun').length)
      put('PaymentRun', await c.paymentRun.findMany({ where: { id: { in: ids('PaymentRun') } }, select: sel }));
    if (ids('GoodsReceiptNote').length)
      put(
        'GoodsReceiptNote',
        await c.goodsReceiptNote.findMany({ where: { id: { in: ids('GoodsReceiptNote') } }, select: sel }),
      );
    if (ids('Contract').length)
      put('Contract', await c.contract.findMany({ where: { id: { in: ids('Contract') } }, select: sel }));
    if (ids('ContractAmendment').length) {
      const rows = await c.contractAmendment.findMany({
        where: { id: { in: ids('ContractAmendment') } },
        select: { id: true, contractId: true, amendmentNo: true },
      });
      const contracts = await c.contract.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.contractId))] } },
        select: sel,
      });
      const num = new Map(contracts.map((k) => [k.id, k.number]));
      for (const r of rows) {
        out.set(`ContractAmendment:${r.id}`, {
          ref: `${num.get(r.contractId) ?? 'Contract'} amendment ${r.amendmentNo}`,
          hrefId: r.contractId,
        });
      }
    }
    return out;
  }
}
