import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import {
  DOMAIN_EVENTS,
  type RmaCreditNoteInput,
  type RmaUpdateInput,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { AuditLogService } from '../audit/audit.service';
import { NotificationService } from '../approvals/notification.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { StorageService } from '../common/storage/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { RmaDocumentService } from './rma-document.service';
import { RmaStateError } from './grn.errors';

const REASON_FROM_REJECTION: Record<
  string,
  Prisma.ReturnMaterialAuthCreateInput['reasonCode']
> = {
  VISIBLE_DAMAGE: 'DAMAGED',
  WRONG_SPEC: 'WRONG_ITEM',
  QUALITY_FAIL_DIM: 'QUALITY_FAIL',
  QUANTITY_SHORT: 'OVER_SUPPLY',
  DOCUMENTATION_MISSING: 'WRONG_ITEM',
};

/**
 * RmaService (Slice 5). Return Material Authorisations are auto-created from a
 * posted GRN's rejected quantity, refined by the buyer, issued (PDF + vendor
 * notification), then closed once a credit note is recorded (ADR-016).
 */
@Injectable()
export class RmaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
    private readonly notifications: NotificationService,
    private readonly storage: StorageService,
    private readonly pdf: RmaDocumentService,
  ) {}

  /** Auto-create a DRAFT RMA covering a GRN's rejected lines. Idempotent. */
  async autoCreateFromGrn(
    grnId: string,
    actorId: string,
  ): Promise<{ id: string } | null> {
    const existing = await this.prisma.client.returnMaterialAuth.findFirst({
      where: { grnId, status: { notIn: ['CANCELLED'] } },
    });
    if (existing) return { id: existing.id };

    const grn = await this.prisma.client.goodsReceiptNote.findUnique({
      where: { id: grnId },
      include: { lines: { include: { poLine: true } }, po: true },
    });
    if (!grn) throw new NotFoundException('GRN not found');

    const rejectedLines = grn.lines.filter((l) =>
      new Decimal(l.qtyRejected.toString()).greaterThan(0),
    );
    if (rejectedLines.length === 0) return null;

    const lineData = rejectedLines.map((l) => {
      const qty = new Decimal(l.qtyRejected.toString());
      const unitPrice = new Decimal(l.poLine.unitPrice.toString());
      return {
        id: newId('returnMaterialAuthLine'),
        tenantId: this.tenantId(),
        grnLineId: l.id,
        qtyReturned: new Prisma.Decimal(qty.toFixed(4)),
        unitPrice: new Prisma.Decimal(unitPrice.toFixed(4)),
        lineTotal: new Prisma.Decimal(qty.times(unitPrice).toFixed(4)),
        returnReasonDetail: l.rejectionReason ?? null,
      };
    });
    const total = lineData.reduce(
      (a, l) => a.plus(l.lineTotal.toString()),
      new Decimal(0),
    );
    const firstReason = rejectedLines[0]?.rejectionReason ?? '';

    const id = newId('returnMaterialAuth');
    const number = await this.nextNumber();
    await this.prisma.client.returnMaterialAuth.create({
      data: {
        id,
        tenantId: this.tenantId(),
        number,
        grnId,
        poId: grn.poId,
        vendorId: grn.po.vendorId,
        reasonCode: REASON_FROM_REJECTION[firstReason] ?? 'DAMAGED',
        totalReturnValue: new Prisma.Decimal(total.toFixed(4)),
        status: 'DRAFT',
        createdBy: actorId,
        lines: { createMany: { data: lineData } },
      },
    });
    await this.audit.record({
      action: 'RMA_DRAFTED',
      entityType: 'ReturnMaterialAuth',
      entityId: id,
      actorId,
      after: { number, grnNumber: grn.number, total: total.toFixed(4) },
    });
    return { id };
  }

  async updateDraft(
    id: string,
    input: RmaUpdateInput,
    actorId: string,
  ): Promise<{ ok: true }> {
    const rma = await this.require(id);
    if (rma.status !== 'DRAFT') {
      throw new RmaStateError('Only a draft RMA can be edited.', { status: rma.status });
    }
    await this.prisma.client.returnMaterialAuth.update({
      where: { id },
      data: {
        reasonCode: input.reasonCode ?? undefined,
        reasonNotes: input.reasonNotes ?? undefined,
        returnFreightBorneBy: input.returnFreightBorneBy ?? undefined,
      },
    });
    await this.audit.record({
      action: 'RMA_UPDATED',
      entityType: 'ReturnMaterialAuth',
      entityId: id,
      actorId,
    });
    return { ok: true };
  }

  async issue(id: string, actorId: string): Promise<{ ok: true }> {
    const rma = await this.require(id);
    if (rma.status !== 'DRAFT') {
      throw new RmaStateError('Only a draft RMA can be issued.', { status: rma.status });
    }
    const { buffer, hash } = await this.pdf.generate(id);
    const s3Key = `${rma.tenantId}/rma/${id}/${rma.number}.pdf`;
    await this.storage.put(s3Key, buffer, 'application/pdf').catch(() => s3Key);
    await this.prisma.client.returnMaterialAuth.update({
      where: { id },
      data: {
        status: 'ISSUED',
        issuedAt: new Date(),
        pdfS3Key: s3Key,
        pdfGeneratedHash: hash,
      },
    });
    await this.notifyVendor(rma.vendorId, id, rma.number);
    await this.audit.record({
      action: 'RMA_ISSUED',
      entityType: 'ReturnMaterialAuth',
      entityId: id,
      actorId,
      after: { number: rma.number, pdfHash: hash },
    });
    await this.events.emit(DOMAIN_EVENTS.RMA_ISSUED, {
      rmaId: id,
      grnId: rma.grnId,
      vendorId: rma.vendorId,
      totalReturnValue: rma.totalReturnValue.toString(),
    });
    return { ok: true };
  }

  async schedulePickup(
    id: string,
    pickupAt: string,
    actorId: string,
  ): Promise<{ ok: true }> {
    const rma = await this.require(id);
    if (rma.status !== 'ISSUED') {
      throw new RmaStateError('Pickup can only be scheduled for an issued RMA.', {
        status: rma.status,
      });
    }
    await this.prisma.client.returnMaterialAuth.update({
      where: { id },
      data: { pickupScheduledAt: new Date(pickupAt) },
    });
    await this.audit.record({
      action: 'RMA_PICKUP_SCHEDULED',
      entityType: 'ReturnMaterialAuth',
      entityId: id,
      actorId,
      after: { pickupAt },
    });
    return { ok: true };
  }

  async recordPickup(
    id: string,
    vehicleOutNo: string,
    gatePassOutNo: string,
    actorId: string,
  ): Promise<{ ok: true }> {
    const rma = await this.require(id);
    if (rma.status !== 'ISSUED') {
      throw new RmaStateError('Only an issued RMA can be picked up.', {
        status: rma.status,
      });
    }
    await this.prisma.client.returnMaterialAuth.update({
      where: { id },
      data: {
        status: 'PICKED_UP',
        pickedUpAt: new Date(),
        vehicleOutNo,
        gatePassOutNo,
      },
    });
    await this.audit.record({
      action: 'RMA_PICKED_UP',
      entityType: 'ReturnMaterialAuth',
      entityId: id,
      actorId,
      after: { vehicleOutNo, gatePassOutNo },
    });
    return { ok: true };
  }

  async recordCreditNote(
    id: string,
    input: RmaCreditNoteInput,
    actorId: string,
  ): Promise<{ ok: true }> {
    const rma = await this.require(id);
    if (!['PICKED_UP', 'ISSUED'].includes(rma.status)) {
      throw new RmaStateError('A credit note can only be recorded after pickup.', {
        status: rma.status,
      });
    }
    await this.prisma.client.returnMaterialAuth.update({
      where: { id },
      data: {
        status: 'CREDIT_NOTE_RECEIVED',
        creditNoteRef: input.creditNoteRef,
        creditNoteAmount: new Prisma.Decimal(
          new Decimal(input.creditNoteAmount).toFixed(4),
        ),
        creditNoteS3Key: input.s3Key ?? null,
      },
    });
    await this.audit.record({
      action: 'RMA_CREDIT_NOTE_RECORDED',
      entityType: 'ReturnMaterialAuth',
      entityId: id,
      actorId,
      after: { creditNoteRef: input.creditNoteRef, amount: input.creditNoteAmount },
    });
    return { ok: true };
  }

  async close(id: string, actorId: string): Promise<{ ok: true }> {
    const rma = await this.require(id);
    if (rma.status !== 'CREDIT_NOTE_RECEIVED') {
      throw new RmaStateError('An RMA is closed once its credit note is recorded.', {
        status: rma.status,
      });
    }
    await this.prisma.client.returnMaterialAuth.update({
      where: { id },
      data: { status: 'CLOSED' },
    });
    await this.audit.record({
      action: 'RMA_CLOSED',
      entityType: 'ReturnMaterialAuth',
      entityId: id,
      actorId,
    });
    await this.events.emit(DOMAIN_EVENTS.RMA_CLOSED, {
      rmaId: id,
      vendorId: rma.vendorId,
      creditNoteRef: rma.creditNoteRef,
    });
    return { ok: true };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async notifyVendor(
    vendorId: string,
    rmaId: string,
    number: string,
  ): Promise<void> {
    const contacts = await this.prisma.client.vendorContact.findMany({
      where: { vendorId, email: { not: null } },
      select: { email: true },
    });
    const emails = contacts.map((c) => c.email).filter((e): e is string => !!e);
    if (emails.length === 0) return;
    const users = await this.prisma.client.user.findMany({
      where: { email: { in: emails } },
      select: { id: true },
    });
    for (const u of users) {
      await this.notifications.notify({
        userId: u.id,
        type: 'RMA_ISSUED',
        title: `Return authorisation ${number}`,
        entityType: 'ReturnMaterialAuth',
        entityId: rmaId,
        href: `/rma/${rmaId}`,
      });
    }
  }

  private async require(id: string) {
    const rma = await this.prisma.client.returnMaterialAuth.findUnique({ where: { id } });
    if (!rma) throw new NotFoundException('RMA not found');
    return rma;
  }

  private async nextNumber(): Promise<string> {
    const latest = await this.prisma.client.returnMaterialAuth.findMany({
      where: { number: { startsWith: 'RMA-' } },
      select: { number: true },
      orderBy: { number: 'desc' },
      take: 50,
    });
    let max = 0;
    for (const r of latest) {
      const n = Number.parseInt(r.number.replace('RMA-', ''), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `RMA-${String(max + 1).padStart(4, '0')}`;
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
