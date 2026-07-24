import { Injectable } from '@nestjs/common';
import { Prisma } from '@procureflow/db';
import type {
  ApprovalSidebarCounts,
  InboxFilter,
  InboxItem,
  InboxResponse,
} from '@procureflow/shared';

import { PrismaService } from '../prisma/prisma.service';

type ApprovalRow = Prisma.ApprovalGetPayload<Record<string, never>>;

/**
 * InboxService — "My approvals" queue (Slice 2). A pending approval only exists
 * once its step is active, so every pending approval assigned to a user is
 * actionable right now.
 */
@Injectable()
export class InboxService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, filter: InboxFilter['filter']): Promise<InboxResponse> {
    const where = this.whereFor(userId, filter);
    const approvals = await this.prisma.client.approval.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    const items = await this.toItems(approvals);

    const [waiting, toMe, byMe] = await Promise.all([
      this.prisma.client.approval.count({
        where: { approverId: userId, decision: 'PENDING' },
      }),
      this.prisma.client.approval.count({
        where: {
          approverId: userId,
          decision: 'PENDING',
          delegatedFromId: { not: null },
        },
      }),
      this.prisma.client.approval.count({
        where: { delegatedFromId: userId, decision: 'PENDING' },
      }),
    ]);

    return {
      items,
      counts: { waiting_on_me: waiting, delegated_to_me: toMe, delegated_by_me: byMe },
    };
  }

  async sidebarCounts(userId: string): Promise<ApprovalSidebarCounts> {
    const [invoices, paymentRuns, total] = await Promise.all([
      this.prisma.client.approval.count({
        where: { approverId: userId, decision: 'PENDING', documentType: 'INVOICE' },
      }),
      this.prisma.client.approval.count({
        where: { approverId: userId, decision: 'PENDING', documentType: 'PAYMENT_RUN' },
      }),
      this.prisma.client.approval.count({
        where: { approverId: userId, decision: 'PENDING' },
      }),
    ]);
    return { invoices, paymentRuns, total };
  }

  private whereFor(
    userId: string,
    filter: InboxFilter['filter'],
  ): Prisma.ApprovalWhereInput {
    switch (filter) {
      case 'waiting_on_me':
        return { approverId: userId, decision: 'PENDING' };
      case 'delegated_to_me':
        return {
          approverId: userId,
          decision: 'PENDING',
          delegatedFromId: { not: null },
        };
      case 'delegated_by_me':
        return { delegatedFromId: userId, decision: 'PENDING' };
      case 'all':
        return {
          decision: 'PENDING',
          OR: [{ approverId: userId }, { delegatedFromId: userId }],
        };
    }
  }

  private async toItems(approvals: ApprovalRow[]): Promise<InboxItem[]> {
    const idsOf = (t: string): string[] =>
      approvals.filter((a) => a.documentType === t).map((a) => a.documentId);
    const invoiceIds = idsOf('INVOICE');
    const runIds = idsOf('PAYMENT_RUN');
    const prIds = idsOf('REQUISITION');
    const poIds = idsOf('PURCHASE_ORDER');
    const [invoices, runs, requisitions, purchaseOrders] = await Promise.all([
      this.prisma.client.invoice.findMany({
        where: { id: { in: invoiceIds } },
        select: {
          id: true,
          number: true,
          grossAmount: true,
          currency: true,
          assignedToId: true,
        },
      }),
      this.prisma.client.paymentRun.findMany({
        where: { id: { in: runIds } },
        select: {
          id: true,
          number: true,
          name: true,
          grossAmount: true,
          currency: true,
          composedBy: true,
        },
      }),
      this.prisma.client.requisition.findMany({
        where: { id: { in: prIds } },
        select: {
          id: true,
          number: true,
          title: true,
          totalAmount: true,
          currency: true,
          requesterId: true,
        },
      }),
      this.prisma.client.purchaseOrder.findMany({
        where: { id: { in: poIds } },
        select: {
          id: true,
          number: true,
          totalAmount: true,
          currency: true,
          createdBy: true,
          vendor: { select: { name: true } },
        },
      }),
    ]);
    const invById = new Map(invoices.map((i) => [i.id, i]));
    const runById = new Map(runs.map((r) => [r.id, r]));
    const prById = new Map(requisitions.map((p) => [p.id, p]));
    const poById = new Map(purchaseOrders.map((p) => [p.id, p]));

    const userIds = [
      ...new Set(
        [
          ...invoices.map((i) => i.assignedToId),
          ...runs.map((r) => r.composedBy),
          ...requisitions.map((p) => p.requesterId),
          ...purchaseOrders.map((p) => p.createdBy),
          ...approvals.map((a) => a.delegatedFromId),
        ].filter((v): v is string => !!v),
      ),
    ];
    const users = await this.prisma.client.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    const now = Date.now();

    return approvals.map((a): InboxItem => {
      const inv = a.documentType === 'INVOICE' ? invById.get(a.documentId) : undefined;
      const run =
        a.documentType === 'PAYMENT_RUN' ? runById.get(a.documentId) : undefined;
      const pr = a.documentType === 'REQUISITION' ? prById.get(a.documentId) : undefined;
      const po =
        a.documentType === 'PURCHASE_ORDER' ? poById.get(a.documentId) : undefined;
      const submitterId =
        inv?.assignedToId ?? run?.composedBy ?? pr?.requesterId ?? po?.createdBy ?? null;
      const number =
        inv?.number ?? run?.number ?? pr?.number ?? po?.number ?? a.documentId;
      const amount =
        inv?.grossAmount ?? run?.grossAmount ?? pr?.totalAmount ?? po?.totalAmount;
      return {
        approvalId: a.id,
        documentType: a.documentType,
        documentId: a.documentId,
        title: run?.name ?? pr?.title ?? po?.vendor?.name ?? number,
        number,
        submitterName: submitterId ? (nameById.get(submitterId) ?? null) : null,
        amount: amount?.toString() ?? null,
        currency: inv?.currency ?? run?.currency ?? pr?.currency ?? po?.currency ?? 'INR',
        daysPending: Math.max(
          0,
          Math.floor((now - a.createdAt.getTime()) / (24 * 60 * 60 * 1000)),
        ),
        slaStatus: this.slaStatus(a.slaDueAt, a.slaHours, now),
        slaDueAt: a.slaDueAt?.toISOString() ?? null,
        delegatedFromName: a.delegatedFromId
          ? (nameById.get(a.delegatedFromId) ?? null)
          : null,
        href:
          a.documentType === 'INVOICE'
            ? `/invoices/${a.documentId}`
            : a.documentType === 'PAYMENT_RUN'
              ? `/payment-runs/${a.documentId}`
              : a.documentType === 'REQUISITION'
                ? `/requisitions/${a.documentId}`
                : a.documentType === 'PURCHASE_ORDER'
                  ? `/purchase-orders/${a.documentId}`
                  : `/${a.documentType.toLowerCase()}/${a.documentId}`,
      };
    });
  }

  private slaStatus(
    slaDueAt: Date | null,
    slaHours: number,
    now: number,
  ): InboxItem['slaStatus'] {
    if (!slaDueAt) return 'ok';
    const due = slaDueAt.getTime();
    if (now >= due) return 'breach';
    const windowMs = slaHours * 60 * 60 * 1000;
    const elapsed = now - (due - windowMs);
    return elapsed >= windowMs * 0.75 ? 'warn' : 'ok';
  }
}
