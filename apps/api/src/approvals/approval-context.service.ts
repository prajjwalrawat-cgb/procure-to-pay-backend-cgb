import { Injectable, NotFoundException } from '@nestjs/common';
import type { ApprovalContext, DocumentType } from '@procureflow/shared';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Builds the `ApprovalContext` a matrix is evaluated against. Generic over
 * document type: Slice 2 wires INVOICE (and a minimal PAYMENT_RUN so the engine
 * is ready for Slice 3). Later slices add PR/PO/GRN/CONTRACT builders here.
 */
@Injectable()
export class ApprovalContextService {
  constructor(private readonly prisma: PrismaService) {}

  async build(documentType: DocumentType, documentId: string): Promise<ApprovalContext> {
    switch (documentType) {
      case 'INVOICE':
        return this.buildInvoice(documentId);
      case 'PAYMENT_RUN':
        return this.buildPaymentRun(documentId);
      case 'REQUISITION':
        return this.buildRequisition(documentId);
      case 'PURCHASE_ORDER':
        return this.buildPurchaseOrder(documentId);
      case 'RFQ_AWARD':
        return this.buildAward(documentId);
      case 'VENDOR_ONBOARDING':
        return this.buildVendorOnboarding(documentId);
      case 'VENDOR_CHANGE':
        return this.buildVendorChange(documentId);
      case 'CONTRACT':
        return this.buildContract(documentId);
      case 'CONTRACT_AMENDMENT':
        return this.buildContractAmendment(documentId);
      default:
        throw new NotFoundException(
          `Approval context for ${documentType} is not available yet.`,
        );
    }
  }

  /** The submitter of a document — used to skip self-approval steps. */
  async submitterOf(
    documentType: DocumentType,
    documentId: string,
  ): Promise<string | null> {
    if (documentType === 'INVOICE') {
      const inv = await this.prisma.client.invoice.findUnique({
        where: { id: documentId },
        select: { assignedToId: true },
      });
      return inv?.assignedToId ?? null;
    }
    if (documentType === 'PAYMENT_RUN') {
      const run = await this.prisma.client.paymentRun.findUnique({
        where: { id: documentId },
        select: { composedBy: true },
      });
      return run?.composedBy ?? null;
    }
    if (documentType === 'REQUISITION') {
      const pr = await this.prisma.client.requisition.findUnique({
        where: { id: documentId },
        select: { requesterId: true },
      });
      return pr?.requesterId ?? null;
    }
    if (documentType === 'PURCHASE_ORDER') {
      const po = await this.prisma.client.purchaseOrder.findUnique({
        where: { id: documentId },
        select: { createdBy: true },
      });
      return po?.createdBy ?? null;
    }
    if (documentType === 'RFQ_AWARD') {
      const award = await this.prisma.client.award.findUnique({
        where: { id: documentId },
        select: { recommendationBy: true },
      });
      return award?.recommendationBy ?? null;
    }
    if (documentType === 'VENDOR_ONBOARDING') {
      // The submitter is a vendor user (never an approver), so nothing to skip.
      return null;
    }
    if (documentType === 'VENDOR_CHANGE') {
      const cr = await this.prisma.client.vendorChangeRequest.findUnique({
        where: { id: documentId },
        select: { requestedBy: true },
      });
      return cr?.requestedBy ?? null;
    }
    if (documentType === 'CONTRACT') {
      const c = await this.prisma.client.contract.findUnique({
        where: { id: documentId },
        select: { createdBy: true },
      });
      return c?.createdBy ?? null;
    }
    if (documentType === 'CONTRACT_AMENDMENT') {
      const a = await this.prisma.client.contractAmendment.findUnique({
        where: { id: documentId },
        select: { requestedBy: true },
      });
      return a?.requestedBy ?? null;
    }
    return null;
  }

  private async buildContract(id: string): Promise<ApprovalContext> {
    const c = await this.prisma.client.contract.findUnique({
      where: { id },
      include: { vendor: { select: { isMsme: true, gstin: true } } },
    });
    if (!c) throw new NotFoundException('Contract not found');
    return {
      documentType: 'CONTRACT',
      documentId: id,
      total_amount: c.totalValueEstimate.toString(),
      currency: c.currency,
      category: c.category,
      contract_type: c.contractType,
      vendor: { is_msme: c.vendor?.isMsme ?? false, gstin: c.vendor?.gstin ?? null },
    };
  }

  private async buildContractAmendment(id: string): Promise<ApprovalContext> {
    const a = await this.prisma.client.contractAmendment.findUnique({
      where: { id },
      include: { contract: { select: { category: true, currency: true } } },
    });
    if (!a) throw new NotFoundException('Contract amendment not found');
    return {
      documentType: 'CONTRACT_AMENDMENT',
      documentId: id,
      // Amendment routing is scaled to the value of the CHANGE, not the whole
      // contract (Slice 9 §amend).
      total_amount: a.changeValue.toString(),
      currency: a.contract.currency,
      category: a.contract.category,
    };
  }

  private async buildVendorOnboarding(id: string): Promise<ApprovalContext> {
    const onboarding = await this.prisma.client.vendorOnboarding.findUnique({
      where: { id },
      include: {
        vendor: {
          include: { screenings: { where: { status: 'FLAGGED' }, select: { id: true } } },
        },
      },
    });
    if (!onboarding) throw new NotFoundException('Onboarding not found');
    const v = onboarding.vendor;
    return {
      documentType: 'VENDOR_ONBOARDING',
      documentId: id,
      category: v.categoryConfigKey,
      annual_turnover: v.annualTurnoverDeclared?.toString() ?? null,
      is_related_party: v.isRelatedParty,
      is_msme: v.isMsme,
      risk_grade: v.riskGrade ?? null,
      has_flagged_screening: v.screenings.length > 0,
      source: onboarding.invitationSource,
    };
  }

  private async buildVendorChange(id: string): Promise<ApprovalContext> {
    const cr = await this.prisma.client.vendorChangeRequest.findUnique({
      where: { id },
      include: { vendor: { select: { categoryConfigKey: true } } },
    });
    if (!cr) throw new NotFoundException('Change request not found');
    return {
      documentType: 'VENDOR_CHANGE',
      documentId: id,
      request_type: cr.requestType,
      requires_reverification: cr.requiresReverification,
      category: cr.vendor.categoryConfigKey,
    };
  }

  private async buildAward(id: string): Promise<ApprovalContext> {
    const award = await this.prisma.client.award.findUnique({
      where: { id },
      include: { rfq: { select: { category: true } } },
    });
    if (!award) throw new NotFoundException('Award not found');
    return {
      documentType: 'RFQ_AWARD',
      documentId: id,
      total_amount: award.totalValue.toString(),
      currency: 'INR',
      category: award.rfq.category,
    };
  }

  private async buildInvoice(id: string): Promise<ApprovalContext> {
    const inv = await this.prisma.client.invoice.findUnique({
      where: { id },
      include: {
        vendor: { select: { isMsme: true, gstin: true } },
        lines: { select: { id: true } },
        exceptions: { where: { resolvedAt: null }, select: { id: true } },
      },
    });
    if (!inv) throw new NotFoundException('Invoice not found');

    const agingDays = Math.max(
      0,
      Math.floor((Date.now() - inv.receivedAt.getTime()) / (24 * 60 * 60 * 1000)),
    );

    return {
      documentType: 'INVOICE',
      documentId: id,
      total_amount: inv.grossAmount.toString(),
      tax_amount: inv.taxAmount.toString(),
      net_amount: inv.netAmount.toString(),
      tds_amount: inv.tdsAmount.toString(),
      currency: inv.currency,
      category: null,
      aging_days: agingDays,
      line_count: inv.lines.length,
      has_exception: inv.exceptions.length > 0,
      dept_id: null,
      plant_id: null,
      assigned_to_id: inv.assignedToId ?? null,
      vendor: { is_msme: inv.vendor?.isMsme ?? false, gstin: inv.vendor?.gstin ?? null },
    };
  }

  private async buildPaymentRun(id: string): Promise<ApprovalContext> {
    const run = await this.prisma.client.paymentRun.findUnique({
      where: { id },
      include: { items: { select: { id: true } } },
    });
    if (!run) throw new NotFoundException('Payment run not found');
    return {
      documentType: 'PAYMENT_RUN',
      documentId: id,
      total_amount: run.grossAmount.toString(),
      net_amount: run.netAmount.toString(),
      currency: run.currency,
      item_count: run.items.length,
    };
  }

  private async buildRequisition(id: string): Promise<ApprovalContext> {
    const pr = await this.prisma.client.requisition.findUnique({
      where: { id },
      include: {
        lines: { select: { id: true, preferredVendorId: true } },
        costCenter: { select: { deptId: true } },
      },
    });
    if (!pr) throw new NotFoundException('Requisition not found');
    return {
      documentType: 'REQUISITION',
      documentId: id,
      total_amount: pr.totalAmount.toString(),
      tax_amount: pr.taxAmount.toString(),
      currency: pr.currency,
      category: null,
      priority: pr.priority,
      line_count: pr.lines.length,
      dept_id: pr.deptId,
      plant_id: pr.plantId,
      cost_center_id: pr.costCenterId,
      requester_id: pr.requesterId,
    };
  }

  private async buildPurchaseOrder(id: string): Promise<ApprovalContext> {
    const po = await this.prisma.client.purchaseOrder.findUnique({
      where: { id },
      include: {
        lines: { select: { id: true } },
        vendor: { select: { isMsme: true, gstin: true } },
      },
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    return {
      documentType: 'PURCHASE_ORDER',
      documentId: id,
      total_amount: po.totalAmount.toString(),
      tax_amount: po.taxAmount.toString(),
      currency: po.currency,
      po_type: po.poType,
      is_spot_buy: po.isSpotBuy,
      line_count: po.lines.length,
      vendor: { is_msme: po.vendor?.isMsme ?? false, gstin: po.vendor?.gstin ?? null },
    };
  }
}
