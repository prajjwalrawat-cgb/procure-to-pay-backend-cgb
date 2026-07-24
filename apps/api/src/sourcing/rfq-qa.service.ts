import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '@procureflow/db';
import type {
  RfqAnswerInput,
  RfqQuestionInput,
  RfqQuestionView,
} from '@procureflow/shared';

import { NotificationService } from '../approvals/notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { SourcingAuditService } from './sourcing-audit.service';
import { SourcingStateError } from './sourcing.errors';
import { VendorResolverService } from './vendor-resolver.service';

/**
 * RfqQaService (Slice 6 §3). Vendors ask clarifications; procurement answers,
 * optionally linking a corrigendum for material changes. Public answers are
 * visible to all invited vendors; private answers only to the asker.
 */
@Injectable()
export class RfqQaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: SourcingAuditService,
    private readonly notifications: NotificationService,
    private readonly vendors: VendorResolverService,
  ) {}

  async askQuestion(
    rfqId: string,
    input: RfqQuestionInput,
    actorId: string,
  ): Promise<{ id: string }> {
    const rfq = await this.prisma.client.rfq.findUnique({ where: { id: rfqId } });
    if (!rfq) throw new NotFoundException('RFQ not found');
    if (!['Q_AND_A_OPEN', 'BIDDING_OPEN'].includes(rfq.status)) {
      throw new SourcingStateError('The Q&A window is not open for this RFQ.', {
        status: rfq.status,
      });
    }
    const invitation = await this.prisma.client.rfqInvitation.findUnique({
      where: { id: input.invitationId },
    });
    if (!invitation || invitation.rfqId !== rfqId) {
      throw new NotFoundException('Invitation not found for this RFQ');
    }
    const vendorId = await this.vendors.resolveVendorId(actorId);
    if (invitation.vendorId !== vendorId) {
      throw new ForbiddenException('You may only ask questions on your own invitation.');
    }
    if (invitation.status === 'QUOTE_SUBMITTED') {
      throw new SourcingStateError('You have already submitted; Q&A is closed for you.');
    }

    const id = newId('rfqQuestion');
    await this.prisma.client.rfqQuestion.create({
      data: {
        id,
        tenantId: rfq.tenantId,
        rfqId,
        invitationId: input.invitationId,
        questionText: input.questionText,
        isPublic: input.isPublic,
        askedBy: actorId,
      },
    });
    await this.audit.rfq('RFQ_QUESTION_ASKED', rfqId, actorId, {
      questionId: id,
      isPublic: input.isPublic,
    });
    await this.notifyProcurement(rfq.createdBy, rfqId, 'A vendor asked a question');
    return { id };
  }

  async answerQuestion(
    questionId: string,
    input: RfqAnswerInput,
    actorId: string,
  ): Promise<{ ok: true }> {
    const question = await this.prisma.client.rfqQuestion.findUnique({
      where: { id: questionId },
      include: { rfq: true },
    });
    if (!question) throw new NotFoundException('Question not found');

    await this.prisma.client.rfqQuestion.update({
      where: { id: questionId },
      data: {
        answerText: input.answerText,
        answeredAt: new Date(),
        answeredBy: actorId,
        corrigendumIssued: input.corrigendumId ?? null,
      },
    });
    await this.audit.rfq('RFQ_QUESTION_ANSWERED', question.rfqId, actorId, {
      questionId,
      isPublic: question.isPublic,
    });

    // Public answer cascades to every invited vendor; private only to the asker.
    if (question.isPublic) {
      const invitations = await this.prisma.client.rfqInvitation.findMany({
        where: { rfqId: question.rfqId },
        select: { vendorId: true },
      });
      for (const inv of invitations) {
        await this.notifyVendor(inv.vendorId, question.rfqId, question.rfq.number);
      }
    } else {
      const asker = await this.prisma.client.rfqInvitation.findUnique({
        where: { id: question.invitationId },
        select: { vendorId: true },
      });
      if (asker)
        await this.notifyVendor(asker.vendorId, question.rfqId, question.rfq.number);
    }
    return { ok: true };
  }

  /** Procurement sees all; a vendor sees public Qs + their own private Qs. */
  async listQuestions(
    rfqId: string,
    viewer: { isVendor: boolean; userId: string },
  ): Promise<RfqQuestionView[]> {
    const rfq = await this.prisma.client.rfq.findUnique({ where: { id: rfqId } });
    if (!rfq) throw new NotFoundException('RFQ not found');

    let vendorId: string | null = null;
    if (viewer.isVendor) vendorId = await this.vendors.resolveVendorId(viewer.userId);

    const rows = await this.prisma.client.rfqQuestion.findMany({
      where: { rfqId },
      orderBy: { askedAt: 'asc' },
      include: { invitation: { include: { vendor: { select: { name: true } } } } },
    });
    return rows
      .filter((q) => {
        if (!viewer.isVendor) return true;
        if (q.isPublic) return true;
        return q.invitation.vendorId === vendorId;
      })
      .map((q) => ({
        id: q.id,
        invitationId: q.invitationId,
        vendorName: viewer.isVendor ? null : q.invitation.vendor.name,
        questionText: q.questionText,
        isPublic: q.isPublic,
        askedAt: q.askedAt.toISOString(),
        answerText: q.answerText,
        answeredAt: q.answeredAt?.toISOString() ?? null,
        corrigendumId: q.corrigendumIssued,
      }));
  }

  private async notifyProcurement(
    userId: string,
    rfqId: string,
    title: string,
  ): Promise<void> {
    await this.notifications.notify({
      userId,
      type: 'RFQ_QUESTION',
      title,
      entityType: 'Rfq',
      entityId: rfqId,
      href: `/sourcing/${rfqId}`,
    });
  }

  private async notifyVendor(
    vendorId: string,
    rfqId: string,
    rfqNumber: string,
  ): Promise<void> {
    const contact = await this.prisma.client.vendorContact.findFirst({
      where: { vendorId, isPrimary: true },
      select: { email: true },
    });
    if (!contact?.email) return;
    const user = await this.prisma.client.user.findFirst({
      where: { tenantId: this.prisma.currentTenantId ?? undefined, email: contact.email },
      select: { id: true },
    });
    if (!user) return;
    await this.notifications.notify({
      userId: user.id,
      type: 'RFQ_QA_ANSWER',
      title: `New answer published on ${rfqNumber}`,
      entityType: 'Rfq',
      entityId: rfqId,
      href: `/sourcing/${rfqId}`,
    });
  }
}
