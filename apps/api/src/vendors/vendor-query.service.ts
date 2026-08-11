import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@procureflow/db';
import {
  categoryConfig,
  type OnboardingDetailResponse,
  type VendorRiskGrade,
  type OnboardingListItem,
  type OnboardingListQuery,
  type RiskTrafficLight,
  type ScorecardPeriod,
  type Vendor360Response,
  type VendorChangeRequestView,
  type VendorDocumentView,
  type VendorListItem,
  type VendorListQuery,
  type VendorScorecardView,
  type VendorScreeningView,
  type VendorSuspensionView,
  type WizardStepSummary,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import { StorageService } from '../common/storage/storage.service';
import { PrismaService } from '../prisma/prisma.service';

const ACTIVE_PO_STATUSES: Prisma.PurchaseOrderWhereInput['status'] = {
  in: ['ISSUED', 'ACKNOWLEDGED', 'PARTIALLY_RECEIVED', 'PARTIALLY_INVOICED'],
};
const WIZARD_STEP_NAMES = [
  'Company basics',
  'Statutory identity',
  'Banking',
  'Certifications',
  'Capabilities',
  'Ownership & UBO',
];
const COLD_START_MIN = 3;

interface WizardState {
  currentStep: number;
  completionPct: number;
  steps: Record<string, { done: boolean; data: Record<string, unknown> }>;
}

/**
 * VendorQueryService (Slice 7). Read models for the buyer console: vendor master
 * list, onboarding queue + review detail (with risk traffic-lights), and the
 * Vendor 360 profile. All money is serialised as a 4-dp string (§3 rule #4).
 */
@Injectable()
export class VendorQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: ApprovalRoutingService,
    private readonly storage: StorageService,
  ) {}

  // ── Vendor master list ───────────────────────────────────────────────────

  async listVendors(query: VendorListQuery): Promise<{
    items: VendorListItem[];
    nextCursor: string | null;
    totalEstimate: number;
  }> {
    const where: Prisma.VendorWhereInput = {
      ...tabFilter(query.tab),
      ...(query.category ? { categoryConfigKey: query.category } : {}),
      ...(query.riskGrade ? { riskGrade: query.riskGrade } : {}),
      ...(query.msme != null ? { isMsme: query.msme } : {}),
    };
    const take = query.limit ?? 50;
    const vendors = await this.prisma.client.vendor.findMany({
      where,
      orderBy: { name: 'asc' },
      take: take + 1,
      ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
    });
    const hasMore = vendors.length > take;
    const page = hasMore ? vendors.slice(0, take) : vendors;

    // Slice 11a — batch the four per-row lookups across the whole page (was an
    // N+1: 4 queries × up-to-50 rows ≈ 200 queries/request). Now 4 queries total,
    // constant regardless of page size.
    const ids = page.map((v) => v.id);
    const fyStart = fyStartDate(new Date());
    const [scorecards, spendAgg, poCounts, grns] = await Promise.all([
      this.prisma.client.vendorScorecard.findMany({
        where: { vendorId: { in: ids }, categoryKey: null, period: 'ROLLING_90D' },
        select: { vendorId: true, grade: true },
      }),
      this.prisma.client.purchaseOrder.groupBy({
        by: ['vendorId'],
        where: {
          vendorId: { in: ids },
          issuedAt: { gte: fyStart },
          status: { notIn: ['DRAFT', 'CANCELLED'] },
        },
        _sum: { totalAmount: true },
      }),
      this.prisma.client.purchaseOrder.groupBy({
        by: ['vendorId'],
        where: { vendorId: { in: ids }, status: ACTIVE_PO_STATUSES },
        _count: { _all: true },
      }),
      this.prisma.client.goodsReceiptNote.findMany({
        where: { po: { vendorId: { in: ids } } },
        select: { receivedAt: true, po: { select: { vendorId: true } } },
        orderBy: { receivedAt: 'desc' },
      }),
    ]);
    const gradeBy = new Map(scorecards.map((s) => [s.vendorId, s.grade]));
    const spendBy = new Map(spendAgg.map((s) => [s.vendorId, s._sum.totalAmount]));
    const poCountBy = new Map(poCounts.map((c) => [c.vendorId, c._count._all]));
    const lastGrnBy = new Map<string, Date>();
    for (const g of grns) {
      if (!lastGrnBy.has(g.po.vendorId)) lastGrnBy.set(g.po.vendorId, g.receivedAt);
    }

    const items = page.map((v): VendorListItem => ({
      id: v.id,
      code: v.code,
      name: v.name,
      legalEntityName: v.legalEntityName,
      isMsme: v.isMsme,
      category: v.categoryConfigKey,
      lifecycleStatus: v.lifecycleStatus,
      riskGrade: v.riskGrade as VendorRiskGrade | null,
      scorecardGrade: gradeBy.get(v.id) ?? null,
      lastTransactionAt: lastGrnBy.get(v.id)?.toISOString() ?? null,
      fytdSpend: new Decimal(spendBy.get(v.id)?.toString() ?? '0').toFixed(4),
      activePoCount: poCountBy.get(v.id) ?? 0,
    }));
    const totalEstimate = await this.prisma.client.vendor.count({ where });
    return {
      items,
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      totalEstimate,
    };
  }

  // ── Onboarding queue ─────────────────────────────────────────────────────

  async listOnboardings(
    query: OnboardingListQuery,
    viewerId: string,
    /** Whether the viewer may withdraw invitations at all — admin-only, since
     *  the queue is shared across every procurement officer. */
    viewerCanCancel = false,
  ): Promise<{ items: OnboardingListItem[] }> {
    let where: Prisma.VendorOnboardingWhereInput =
      query.tab === 'in_progress'
        ? // A withdrawn invitation is not in progress — it must drop out of this
          // tab, which is the whole point of cancelling it.
          { submittedAt: null, reviewDecision: null }
        : query.tab === 'approved'
          ? { reviewDecision: 'APPROVED' }
          : query.tab === 'rejected'
            ? // Cancelled invites live here too: "not proceeding" is where an
              // officer looks for an invite that has disappeared from the queue.
              { reviewDecision: { in: ['REJECTED', 'CANCELLED'] } }
            : {};
    if (query.tab === 'my_review') {
      // Approvals are a generic table (documentType/documentId), not a relation.
      const mine = await this.prisma.client.approval.findMany({
        where: {
          documentType: 'VENDOR_ONBOARDING',
          approverId: viewerId,
          decision: 'PENDING',
        },
        select: { documentId: true },
      });
      where = { id: { in: mine.map((a) => a.documentId) }, reviewDecision: null };
    }
    const onboardings = await this.prisma.client.vendorOnboarding.findMany({
      where,
      include: {
        vendor: { include: { documents: true } },
      },
      orderBy: { startedAt: 'desc' },
      take: query.limit ?? 50,
    });
    const now = Date.now();
    const items = onboardings.map((ob): OnboardingListItem => {
      const state = ob.wizardState as unknown as WizardState;
      const config = categoryConfig(ob.categoryConfigKey);
      const docsRequired = config?.requiredDocuments.length ?? 0;
      const docsVerified = ob.vendor.documents.filter(
        (d) =>
          d.verificationStatus === 'AUTO_VERIFIED' ||
          d.verificationStatus === 'MANUALLY_VERIFIED',
      ).length;
      const daysOpen = Math.floor((now - ob.startedAt.getTime()) / 86_400_000);
      const lastActivity = ob.submittedAt ?? ob.startedAt;
      const stalled =
        !ob.submittedAt &&
        !ob.reviewDecision &&
        now - lastActivity.getTime() > 7 * 86_400_000;
      return {
        id: ob.id,
        vendorId: ob.vendorId,
        vendorName: ob.vendor.name,
        category: ob.vendor.categoryConfigKey,
        isMsme: ob.vendor.isMsme,
        invitationSource: ob.invitationSource,
        completionPct: state?.completionPct ?? 0,
        docsVerified,
        docsRequired,
        daysOpen,
        stalled,
        riskGrade: ob.vendor.riskGrade as OnboardingListItem['riskGrade'],
        lifecycleStatus: ob.vendor.lifecycleStatus,
        slaTargetHours: ob.slaTargetHours,
        slaBreachAt: ob.slaBreachAt?.toISOString() ?? null,
        reviewDecision: ob.reviewDecision,
        inviteAccepted: !!ob.emailVerifiedAt,
        // Only ever offered for an invitation the vendor never accepted. Once
        // they have a working login there is a review path for them instead —
        // they submit and you approve or reject — so the queue does not offer
        // to pull the rug out mid-application.
        canCancel:
          !ob.submittedAt && !ob.reviewDecision && !ob.emailVerifiedAt && viewerCanCancel,
      };
    });
    return { items };
  }

  async onboardingDetail(
    onboardingId: string,
    viewerId: string,
  ): Promise<OnboardingDetailResponse> {
    const ob = await this.prisma.client.vendorOnboarding.findUnique({
      where: { id: onboardingId },
      include: {
        vendor: {
          include: {
            documents: { orderBy: { uploadedAt: 'desc' } },
            screenings: { orderBy: { requestedAt: 'desc' } },
            beneficialOwners: true,
          },
        },
      },
    });
    if (!ob) throw new NotFoundException('Onboarding not found');
    const v = ob.vendor;
    const state = ob.wizardState as unknown as WizardState;
    const now = Date.now();

    const chain = await this.routing.getLiveChain('VENDOR_ONBOARDING', onboardingId);
    const myStep = chain.find(
      (s) => s.approverId === viewerId && s.decision === 'PENDING' && s.isCurrent,
    );

    const steps: WizardStepSummary[] = WIZARD_STEP_NAMES.map((name, i) => {
      const key = `step${i + 1}`;
      const s = state?.steps?.[key];
      return {
        step: i + 1,
        name,
        done: s?.done ?? false,
        completionPct: state?.completionPct ?? 0,
        data: s?.data ?? null,
      };
    });

    return {
      id: ob.id,
      vendorId: v.id,
      vendorName: v.name,
      legalEntityName: v.legalEntityName,
      category: v.categoryConfigKey,
      isMsme: v.isMsme,
      lifecycleStatus: v.lifecycleStatus,
      invitationSource: ob.invitationSource,
      completionPct: state?.completionPct ?? 0,
      daysOpen: Math.floor((now - ob.startedAt.getTime()) / 86_400_000),
      slaTargetHours: ob.slaTargetHours,
      slaBreachAt: ob.slaBreachAt?.toISOString() ?? null,
      startedAt: ob.startedAt.toISOString(),
      submittedAt: ob.submittedAt?.toISOString() ?? null,
      steps,
      documents: await this.toDocViews(v.documents),
      screenings: v.screenings.map(toScreeningView),
      beneficialOwners: v.beneficialOwners.map((o) => ({
        id: o.id,
        ownerName: o.ownerName,
        ownerPan: o.ownerPan,
        ownershipPct: o.ownershipPct.toString(),
        isPep: o.isPep,
        sanctionsScreeningStatus: o.sanctionsScreeningStatus,
      })),
      riskLights: this.riskLights(v),
      cocAcknowledgedAt: v.cocAcknowledgedAt?.toISOString() ?? null,
      canReview: !!myStep,
      myApprovalId: myStep?.approvalId ?? null,
      returnForInfoItems: (ob.returnForInfoItems as string[] | null) ?? [],
    };
  }

  // ── Vendor 360 ───────────────────────────────────────────────────────────

  async vendor360(vendorId: string): Promise<Vendor360Response> {
    const v = await this.prisma.client.vendor.findUnique({
      where: { id: vendorId },
      include: {
        documents: { orderBy: { uploadedAt: 'desc' } },
        beneficialOwners: true,
        contacts: { where: { isPrimary: true }, take: 1 },
        banks: { where: { isArchived: false }, take: 1 },
        suspensions: { orderBy: { imposedAt: 'desc' } },
        changeRequests: { orderBy: { requestedAt: 'desc' } },
      },
    });
    if (!v) throw new NotFoundException('Vendor not found');
    const contact = v.contacts[0];
    const bank = v.banks[0];
    const scorecard = await this.scorecardView(vendorId, null, 'ROLLING_90D');
    const fytdSpend = await this.fytdSpend(vendorId);

    return {
      id: v.id,
      code: v.code,
      name: v.name,
      legalEntityName: v.legalEntityName,
      legalEntityType: v.legalEntityType,
      isMsme: v.isMsme,
      msmeCategory: v.msmeCategory,
      lifecycleStatus: v.lifecycleStatus,
      riskGrade: v.riskGrade as VendorRiskGrade | null,
      riskScore: v.riskScore?.toString() ?? null,
      gstin: v.gstin,
      pan: v.pan,
      category: v.categoryConfigKey,
      categoryTags: v.categoryTags,
      capabilityTags: v.capabilityTags,
      activatedAt: v.activatedAt?.toISOString() ?? null,
      scorecard,
      fytdSpend,
      avgPaymentCycleDays: scorecard.metrics.paymentCycleDays,
      primaryContact: contact
        ? { name: contact.name, email: contact.email, phone: contact.phone }
        : null,
      bank: bank
        ? {
            bankName: bank.bankName,
            accountNoLast4: bank.accountNoEncrypted.slice(-4),
            ifsc: bank.ifsc,
            verifiedAt: bank.verifiedAt?.toISOString() ?? null,
          }
        : null,
      beneficialOwners: v.beneficialOwners.map((o) => ({
        id: o.id,
        ownerName: o.ownerName,
        ownerPan: o.ownerPan,
        ownershipPct: o.ownershipPct.toString(),
        isPep: o.isPep,
        sanctionsScreeningStatus: o.sanctionsScreeningStatus,
      })),
      documents: await this.toDocViews(v.documents),
      suspensions: v.suspensions.map(toSuspensionView),
      changeRequests: v.changeRequests.map(toChangeView),
    };
  }

  async scorecardView(
    vendorId: string,
    categoryKey: string | null,
    period: ScorecardPeriod,
  ): Promise<VendorScorecardView> {
    const sc = await this.prisma.client.vendorScorecard.findFirst({
      where: { vendorId, categoryKey, period },
    });
    const metrics = (sc?.metrics as VendorScorecardView['metrics'] | undefined) ?? {
      otifPct: null,
      qualityPct: null,
      responseTimeAvgHrs: null,
      disputeRatePct: null,
      paymentCycleDays: null,
      rfqParticipationPct: null,
      winRatePct: null,
    };
    return {
      categoryKey,
      period,
      score: sc?.score ? Number(sc.score) : null,
      grade: sc?.grade ?? 'N/A',
      insufficientData: (sc?.transactionCount ?? 0) < COLD_START_MIN,
      transactionCount: sc?.transactionCount ?? 0,
      spendAmount: sc?.spendAmount?.toString() ?? '0.0000',
      metrics,
    };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async fytdSpend(vendorId: string): Promise<string> {
    const fyStart = fyStartDate(new Date());
    const agg = await this.prisma.client.purchaseOrder.aggregate({
      where: {
        vendorId,
        issuedAt: { gte: fyStart },
        status: { notIn: ['DRAFT', 'CANCELLED'] },
      },
      _sum: { totalAmount: true },
    });
    return new Decimal(agg._sum.totalAmount?.toString() ?? '0').toFixed(4);
  }

  private riskLights(
    v: Prisma.VendorGetPayload<{ include: { screenings: true; documents: true } }>,
  ): RiskTrafficLight[] {
    const screening = (
      types: string[],
      flagState: RiskTrafficLight['state'],
    ): RiskTrafficLight['state'] => {
      const relevant = v.screenings.filter((s) => types.includes(s.screeningType));
      if (relevant.some((s) => s.status === 'FLAGGED')) return flagState;
      if (relevant.length === 0 || relevant.some((s) => s.status === 'PENDING'))
        return 'amber';
      return 'green';
    };
    const now = Date.now();
    const anyExpired = v.documents.some(
      (d) =>
        d.verificationStatus === 'EXPIRED' || (d.validTo && d.validTo.getTime() < now),
    );
    return [
      {
        key: 'statutory',
        label: 'Statutory (GSTIN/PAN)',
        state: screening(['GSTIN_STATUS', 'PAN_STATUS'], 'red'),
      },
      {
        key: 'financial',
        label: 'Financial',
        state: screening(['CREDIT_BUREAU', 'RBI_DEFAULTER'], 'amber'),
      },
      { key: 'compliance', label: 'Compliance', state: anyExpired ? 'red' : 'green' },
      {
        key: 'sanctions',
        label: 'Sanctions',
        state: screening(['SANCTIONS_OFAC', 'SANCTIONS_EU', 'SANCTIONS_UK'], 'red'),
      },
      {
        key: 'operational',
        label: 'Adverse media',
        state: screening(['ADVERSE_MEDIA'], 'amber'),
      },
    ];
  }

  /** Attach a short-lived presigned URL so a reviewer can open each document.
   *  A presigner failure degrades to an empty url rather than failing the page. */
  private async toDocViews(
    docs: Prisma.VendorDocumentGetPayload<Record<string, never>>[],
  ): Promise<VendorDocumentView[]> {
    return Promise.all(
      docs.map(async (d) => ({
        id: d.id,
        docType: d.docType as VendorDocumentView['docType'],
        filename: d.filename ?? d.s3Key,
        documentNumber: d.documentNumber,
        verificationStatus: d.verificationStatus,
        validTo: d.validTo?.toISOString() ?? null,
        uploadedAt: d.uploadedAt?.toISOString() ?? '',
        url: await this.storage.presignedGetUrl(d.s3Key).catch(() => ''),
        sizeBytes: d.sizeBytes ?? 0,
      })),
    );
  }
}


function toScreeningView(
  s: Prisma.VendorScreeningGetPayload<Record<string, never>>,
): VendorScreeningView {
  return {
    id: s.id,
    screeningType: s.screeningType,
    provider: s.screeningProvider,
    status: s.status,
    flagSeverity: s.flagSeverity,
    findings: (s.findings as Record<string, unknown> | null) ?? null,
    completedAt: s.completedAt?.toISOString() ?? null,
    nextDueAt: s.nextScreeningDueAt?.toISOString() ?? null,
  };
}

function toSuspensionView(
  s: Prisma.VendorSuspensionGetPayload<Record<string, never>>,
): VendorSuspensionView {
  return {
    id: s.id,
    suspensionType: s.suspensionType,
    reasonCode: s.reasonCode,
    reasonNotes: s.reasonNotes,
    imposedAt: s.imposedAt.toISOString(),
    effectiveUntil: s.effectiveUntil?.toISOString() ?? null,
    liftConditions: s.liftConditions,
    liftedAt: s.liftedAt?.toISOString() ?? null,
  };
}

function toChangeView(
  c: Prisma.VendorChangeRequestGetPayload<Record<string, never>>,
): VendorChangeRequestView {
  return {
    id: c.id,
    requestType: c.requestType,
    status: c.status,
    proposedChanges: c.proposedChanges as Record<string, unknown>,
    currentValues: c.currentValues as Record<string, unknown>,
    requiresReverification: c.requiresReverification,
    requestedAt: c.requestedAt.toISOString(),
    decidedAt: c.decidedAt?.toISOString() ?? null,
  };
}

/** Map the master-list tab onto a lifecycle-status filter. */
function tabFilter(tab: VendorListQuery['tab']): Prisma.VendorWhereInput {
  switch (tab) {
    case 'active':
      return { lifecycleStatus: 'ACTIVE' };
    case 'suspended':
      return { lifecycleStatus: 'SUSPENDED' };
    case 'blacklisted':
      return { lifecycleStatus: 'BLACKLISTED' };
    case 'archived':
      return { lifecycleStatus: 'ARCHIVED' };
    case 'onboarding':
      return {
        lifecycleStatus: {
          in: ['INVITED', 'SELF_REGISTERED', 'IN_ONBOARDING', 'UNDER_REVIEW'],
        },
      };
    case 'all':
    default:
      return {};
  }
}

/** Indian financial year starts 1 April. */
function fyStartDate(now: Date): Date {
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return new Date(Date.UTC(year, 3, 1));
}
