import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@procureflow/db';
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  computeDocTax,
  taxKindLabel,
  type RoleName,
  type RequisitionCardView,
  type RequisitionDetailResponse,
  type RequisitionKanbanColumn,
  type RequisitionKanbanResponse,
  type RequisitionLineView,
  type RequisitionListQuery,
  type RequisitionListResponse,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import { BudgetService } from '../budgets/budget.service';
import { PrismaService } from '../prisma/prisma.service';
import { RequisitionAttachmentService } from './requisition-attachment.service';

const KANBAN_COLUMNS: RequisitionKanbanColumn[] = [
  'DRAFT',
  'AWAITING_APPROVAL',
  'SOURCING',
  'PO_ISSUED',
  'RECEIVED',
];

type PrWithRels = Prisma.RequisitionGetPayload<{
  include: {
    lines: true;
    costCenter: true;
    purchaseOrders: { include: { vendor: true } };
  };
}>;

/** Read-side for requisitions: kanban board, table list, and detail. */
@Injectable()
export class RequisitionQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: ApprovalRoutingService,
    private readonly budgets: BudgetService,
    private readonly attachments: RequisitionAttachmentService,
  ) {}

  async board(_userId: string): Promise<RequisitionKanbanResponse> {
    const prs = await this.prisma.client.requisition.findMany({
      where: { status: { notIn: ['REJECTED', 'WITHDRAWN', 'CANCELLED'] } },
      include: {
        lines: true,
        costCenter: true,
        purchaseOrders: { include: { vendor: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const vendorMsme = await this.msmeVendorMap(prs);

    const columns = Object.fromEntries(
      KANBAN_COLUMNS.map((c) => [c, [] as RequisitionCardView[]]),
    ) as Record<RequisitionKanbanColumn, RequisitionCardView[]>;

    for (const pr of prs) {
      const column = this.columnFor(pr);
      if (!column) continue;
      columns[column].push(this.toCard(pr, column, vendorMsme));
    }
    const counts = Object.fromEntries(
      KANBAN_COLUMNS.map((c) => [c, columns[c].length]),
    ) as Record<RequisitionKanbanColumn, number>;
    return { columns, counts };
  }

  async list(
    query: RequisitionListQuery,
    userId: string,
  ): Promise<RequisitionListResponse> {
    const where: Prisma.RequisitionWhereInput = {};
    switch (query.tab) {
      case 'draft':
        where.status = { in: ['DRAFT', 'BUDGET_BREACH_HELD'] };
        break;
      case 'rejected':
        where.status = { in: ['REJECTED', 'WITHDRAWN', 'CANCELLED'] };
        break;
      case 'closed':
        where.status = { in: ['CLOSED', 'FULLY_ISSUED'] };
        break;
      case 'my_approval':
        where.id = { in: await this.myApprovalPrIds(userId) };
        break;
      default:
        where.status = { notIn: ['REJECTED', 'WITHDRAWN', 'CANCELLED'] };
    }
    if (query.status) where.status = { in: query.status };
    if (query.requesterId) where.requesterId = query.requesterId;
    if (query.costCenterId) where.costCenterId = query.costCenterId;
    if (query.plantId) where.plantId = query.plantId;
    if (query.priority) where.priority = query.priority;
    if (query.hasPreferredVendor) {
      where.lines = { some: { preferredVendorId: { not: null } } };
    }

    const rows = await this.prisma.client.requisition.findMany({
      where,
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        lines: true,
        costCenter: true,
        purchaseOrders: { include: { vendor: true } },
      },
    });
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const vendorMsme = await this.msmeVendorMap(page);
    const total = await this.prisma.client.requisition.count({ where });

    return {
      items: page.map((pr) => this.toCard(pr, this.columnFor(pr) ?? 'DRAFT', vendorMsme)),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      totalEstimate: total,
    };
  }

  async detail(id: string, userId: string): Promise<RequisitionDetailResponse> {
    const pr = await this.prisma.client.requisition.findUnique({
      where: { id },
      include: {
        lines: {
          orderBy: { lineNo: 'asc' },
          include: { item: true, preferredVendor: true },
        },
        costCenter: { include: { department: true } },
        plant: true,
        purchaseOrders: { include: { vendor: true } },
        comments: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!pr) throw new NotFoundException('Requisition not found');

    const requester = await this.prisma.client.user.findUnique({
      where: { id: pr.requesterId },
      select: { id: true, name: true },
    });

    // Aggregate received qty per PR line from issued POs.
    const receivedByPrLine = await this.receivedByPrLine(id);

    const lines: RequisitionLineView[] = pr.lines.map((l) => {
      const qty = new Decimal(l.qty.toString());
      const issued = new Decimal(l.qtyIssued.toString());
      const received = receivedByPrLine.get(l.id) ?? new Decimal(0);
      return {
        id: l.id,
        lineNo: l.lineNo,
        itemId: l.itemId,
        skuCode: l.skuCode,
        itemDesc: l.itemDesc,
        hsnCode: l.hsnCode,
        uom: l.uom,
        qty: qty.toFixed(4),
        qtyIssued: issued.toFixed(4),
        qtyRemaining: qty.minus(issued).toFixed(4),
        qtyReceived: received.toFixed(4),
        unitPrice: l.unitPrice.toString(),
        discountPct: l.discountPct.toString(),
        taxRate: l.taxRate.toString(),
        taxAmount: l.taxAmount.toString(),
        lineTotal: l.lineTotal.toString(),
        category: l.category,
        preferredVendor: l.preferredVendor
          ? {
              id: l.preferredVendor.id,
              name: l.preferredVendor.name,
              isMsme: l.preferredVendor.isMsme,
            }
          : null,
        reasonCode: l.reasonCode,
        isCatalogued: !!l.itemId,
        itemCurrent: l.item
          ? {
              name: l.item.name,
              gstRate: l.item.gstRate.toString(),
              isActive: l.item.isActive,
            }
          : null,
      };
    });

    const docTax = computeDocTax(
      pr.lines.map((l) => ({
        qty: l.qty.toString(),
        unitPrice: l.unitPrice.toString(),
        discountPct: l.discountPct.toString(),
        taxRate: l.taxRate.toString(),
      })),
      { plantStateCode: pr.plant.stateCode, estimateWhenUnknown: true },
    );

    const budget = await this.budgets.checkAvailability(
      pr.costCenterId,
      pr.totalAmount.toString(),
    );
    const commitment = await this.prisma.client.budgetCommitment.findFirst({
      where: { requisitionId: id, sourceType: 'PR', status: { not: 'RELEASED' } },
    });

    const chain = await this.routing.getLiveChain('REQUISITION', id);
    const myStep = chain.find((s) => s.approverId === userId && s.decision === 'PENDING');
    const activity = await this.activity(id);
    const commentAuthors = await this.userNames(pr.comments.map((c) => c.authorId));
    const attachments = await this.attachments.list(id);
    const canAttach = await this.attachments.canAttach(
      { id: pr.id, status: pr.status, requesterId: pr.requesterId },
      userId,
    );

    // Action flags fold state together with the viewer's permissions so the UI
    // never offers a control that is guaranteed to 403.
    const { roles, perms } = await this.rolesAndPerms(userId);
    const isAdmin = roles.has('TENANT_ADMIN');
    const isRequester = pr.requesterId === userId;

    return {
      id: pr.id,
      number: pr.number,
      title: pr.title ?? pr.number,
      businessJustification: pr.businessJustification ?? '',
      status: pr.status,
      priority: pr.priority,
      neededBy: pr.neededBy?.toISOString() ?? null,
      agingDays: this.agingDays(pr.createdAt),
      createdAt: pr.createdAt.toISOString(),
      requester: {
        id: pr.requesterId,
        name: requester?.name ?? pr.requesterId,
        deptName: pr.costCenter.department?.name ?? null,
      },
      costCenter: {
        id: pr.costCenter.id,
        code: pr.costCenter.code,
        name: pr.costCenter.name,
      },
      plant: { id: pr.plant.id, name: pr.plant.name },
      deliveryLocation: pr.deliveryLocation,
      stages: this.stages(pr.status),
      lines,
      amounts: {
        subtotal: docTax.subtotal,
        taxAmount: docTax.taxAmount,
        taxKind: taxKindLabel(docTax.taxKind),
        total: docTax.total,
        currency: pr.currency,
      },
      budget,
      committedAmount: commitment?.amount.toString() ?? null,
      poConversions: pr.purchaseOrders.map((po) => ({
        id: po.id,
        number: po.number,
        vendorName: po.vendor.name,
        status: po.status,
        totalAmount: po.totalAmount.toString(),
      })),
      attachments,
      comments: pr.comments.map((c) => ({
        id: c.id,
        authorId: c.authorId,
        authorName: commentAuthors.get(c.authorId) ?? c.authorId,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
      })),
      activity,
      liveApprovalChain: chain,
      myApprovalId: myStep?.approvalId ?? null,
      canDecide: !!myStep,
      canCreatePo: pr.status === 'APPROVED' || pr.status === 'PARTIALLY_ISSUED',
      // Submit and cancel carry no ownership check in the service — permission
      // and document state are the whole rule. Edit additionally requires the
      // requester or a tenant admin, mirroring updateDraft().
      canSubmit:
        ['DRAFT', 'BUDGET_BREACH_HELD'].includes(pr.status) &&
        perms.has(PERMISSIONS.REQUISITION_SUBMIT),
      canEdit:
        pr.status === 'DRAFT' &&
        perms.has(PERMISSIONS.REQUISITION_UPDATE) &&
        (isRequester || isAdmin),
      canWithdraw:
        pr.status === 'AWAITING_APPROVAL' &&
        isRequester &&
        perms.has(PERMISSIONS.REQUISITION_SUBMIT),
      canCancel:
        !['FULLY_ISSUED', 'CANCELLED', 'CLOSED', 'REJECTED'].includes(pr.status) &&
        perms.has(PERMISSIONS.REQUISITION_CANCEL),
      canAttach,
      budgetBreachDetail:
        pr.status === 'BUDGET_BREACH_HELD'
          ? (pr.budgetBreachDetail as unknown as RequisitionDetailResponse['budgetBreachDetail'])
          : null,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Effective roles and permissions for a user, resolved from the DB rather
   * than the JWT: the read model is also reached by paths that do not carry the
   * caller's token claims. Mirrors AuthService.loadRolesAndPerms.
   */
  private async rolesAndPerms(
    userId: string,
  ): Promise<{ roles: Set<string>; perms: Set<string> }> {
    const userRoles = await this.prisma.client.userRole.findMany({
      where: { userId },
      include: { role: true },
    });
    const roles = new Set(userRoles.map((ur) => ur.role.name));
    const perms = new Set<string>();
    for (const role of roles) {
      for (const p of ROLE_PERMISSIONS[role as RoleName] ?? []) perms.add(p);
    }
    return { roles, perms };
  }

  private columnFor(pr: PrWithRels): RequisitionKanbanColumn | null {
    const s = pr.status;
    if (s === 'DRAFT' || s === 'BUDGET_BREACH_HELD') return 'DRAFT';
    if (s === 'AWAITING_APPROVAL' || s === 'PENDING_APPROVAL' || s === 'SUBMITTED') {
      return 'AWAITING_APPROVAL';
    }
    if (s === 'APPROVED') return 'SOURCING';
    if (s === 'PARTIALLY_ISSUED' || s === 'FULLY_ISSUED' || s === 'CONVERTED') {
      const received = pr.purchaseOrders.some((po) =>
        ['PARTIALLY_RECEIVED', 'RECEIVED', 'INVOICED', 'CLOSED'].includes(po.status),
      );
      return received ? 'RECEIVED' : 'PO_ISSUED';
    }
    if (s === 'CLOSED') return 'RECEIVED';
    return null;
  }

  private toCard(
    pr: PrWithRels,
    column: RequisitionKanbanColumn,
    vendorMsme: Set<string>,
  ): RequisitionCardView {
    const hasMsme = pr.lines.some(
      (l) => l.preferredVendorId && vendorMsme.has(l.preferredVendorId),
    );
    return {
      id: pr.id,
      number: pr.number,
      title: pr.title ?? pr.number,
      costCenter: {
        id: pr.costCenter.id,
        code: pr.costCenter.code,
        name: pr.costCenter.name,
      },
      totalAmount: pr.totalAmount.toString(),
      currency: pr.currency,
      status: pr.status,
      priority: pr.priority,
      neededBy: pr.neededBy?.toISOString() ?? null,
      agingDays: this.agingDays(pr.createdAt),
      requester: { id: pr.requesterId, name: pr.requesterId },
      lineCount: pr.lines.length,
      hasMsmeVendor: hasMsme,
      column,
    };
  }

  private async msmeVendorMap(prs: PrWithRels[]): Promise<Set<string>> {
    const ids = [
      ...new Set(
        prs.flatMap((p) =>
          p.lines.map((l) => l.preferredVendorId).filter((v): v is string => !!v),
        ),
      ),
    ];
    if (ids.length === 0) return new Set();
    const vendors = await this.prisma.client.vendor.findMany({
      where: { id: { in: ids }, isMsme: true },
      select: { id: true },
    });
    return new Set(vendors.map((v) => v.id));
  }

  private async receivedByPrLine(prId: string): Promise<Map<string, Decimal>> {
    const poLines = await this.prisma.client.purchaseOrderLine.findMany({
      where: { po: { requisitionId: prId }, prLineId: { not: null } },
      select: { prLineId: true, qtyReceived: true },
    });
    const map = new Map<string, Decimal>();
    for (const l of poLines) {
      if (!l.prLineId) continue;
      const prev = map.get(l.prLineId) ?? new Decimal(0);
      map.set(l.prLineId, prev.plus(l.qtyReceived.toString()));
    }
    return map;
  }

  private async myApprovalPrIds(userId: string): Promise<string[]> {
    const approvals = await this.prisma.client.approval.findMany({
      where: { documentType: 'REQUISITION', approverId: userId, decision: 'PENDING' },
      select: { documentId: true },
    });
    return approvals.map((a) => a.documentId);
  }

  private async activity(id: string): Promise<RequisitionDetailResponse['activity']> {
    const rows = await this.prisma.client.auditLog.findMany({
      where: { entityType: 'Requisition', entityId: id },
      orderBy: { timestamp: 'asc' },
      take: 100,
    });
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      actorId: r.actorId,
      at: r.timestamp.toISOString(),
    }));
  }

  private async userNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.client.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private stages(status: string): RequisitionDetailResponse['stages'] {
    const order = ['DRAFT', 'APPROVAL', 'SOURCING', 'PO_ISSUED', 'RECEIVED', 'CLOSED'];
    const currentIdx = ((): number => {
      if (status === 'DRAFT' || status === 'BUDGET_BREACH_HELD') return 0;
      if (status === 'AWAITING_APPROVAL') return 1;
      if (status === 'APPROVED') return 2;
      if (status === 'PARTIALLY_ISSUED' || status === 'FULLY_ISSUED') return 3;
      if (status === 'CLOSED') return 5;
      return 0;
    })();
    const labels: Record<string, string> = {
      DRAFT: 'Draft',
      APPROVAL: 'Approval',
      SOURCING: 'Sourcing',
      PO_ISSUED: 'PO(s) issued',
      RECEIVED: 'Received',
      CLOSED: 'Closed',
    };
    return order.map((key, idx) => ({
      key,
      label: labels[key] ?? key,
      state: idx < currentIdx ? 'done' : idx === currentIdx ? 'active' : 'todo',
    }));
  }

  private agingDays(createdAt: Date): number {
    return Math.max(
      0,
      Math.floor((Date.now() - createdAt.getTime()) / (24 * 60 * 60 * 1000)),
    );
  }
}
