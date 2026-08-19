/**
 * Slice 7 seed — vendor onboarding & lifecycle. Loads the 8 category configs
 * (mirroring @procureflow/shared), a LEGAL_OFFICER user for the blacklist
 * co-sign, the VENDOR_ONBOARDING approval matrix (standard · flagged/legal ·
 * related-party/MD), historical scorecards for the existing activated vendors,
 * and a handful of in-flight onboardings at various completion so the review
 * queue is populated.
 *
 * Idempotent. Connects on the DIRECT (owner) URL so it bypasses RLS.
 */
import { hash } from 'argon2';
import { Prisma, PrismaClient } from '@prisma/client';
import { ONBOARDING_STEP_COUNT, VENDOR_CATEGORY_CONFIGS } from '@procureflow/shared';

import { newId } from '../src/ids';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL },
  },
});

const VENDOR_PASSWORD = 'Slice0!Vendor';
const STAFF_PASSWORD = 'Slice0!Admin';

interface OnboardingSpec {
  code: string;
  name: string;
  legalEntityName: string;
  categoryKey: string;
  source: 'BUYER_INVITE_RFQ' | 'BUYER_INVITE_SPOT' | 'SELF_REGISTRATION';
  isMsme: boolean;
  lifecycleStatus: 'INVITED' | 'SELF_REGISTERED' | 'IN_ONBOARDING' | 'UNDER_REVIEW';
  completedSteps: number; // 0..ONBOARDING_STEP_COUNT
  submitted: boolean;
  contactEmail: string;
  contactName: string;
}

const ONBOARDINGS: OnboardingSpec[] = [
  {
    code: 'V-ONB-STEELTECH',
    name: 'SteelTech Fabricators',
    legalEntityName: 'SteelTech Fabricators Private Limited',
    categoryKey: 'MECHANICAL_SPARES',
    source: 'BUYER_INVITE_RFQ',
    isMsme: false,
    lifecycleStatus: 'UNDER_REVIEW',
    completedSteps: 4,
    submitted: true,
    contactEmail: 'onboarding@steeltech.example',
    contactName: 'N. Kulkarni',
  },
  {
    code: 'V-ONB-BENGALCHEM',
    name: 'Bengal Chemicals Co',
    legalEntityName: 'Bengal Chemicals Company LLP',
    categoryKey: 'CHEMICALS',
    source: 'SELF_REGISTRATION',
    isMsme: true,
    lifecycleStatus: 'IN_ONBOARDING',
    completedSteps: 3,
    submitted: false,
    contactEmail: 'accounts@bengalchem.example',
    contactName: 'S. Ghosh',
  },
  {
    code: 'V-ONB-NORTHLOG',
    name: 'Northeast Logistics',
    legalEntityName: 'Northeast Logistics Services',
    categoryKey: 'LOGISTICS',
    source: 'SELF_REGISTRATION',
    isMsme: true,
    lifecycleStatus: 'IN_ONBOARDING',
    completedSteps: 2,
    submitted: false,
    contactEmail: 'ops@nelogistics.example',
    contactName: 'T. Rabha',
  },
  {
    code: 'V-ONB-APEXIT',
    name: 'Apex IT Solutions',
    legalEntityName: 'Apex IT Solutions Private Limited',
    categoryKey: 'IT_SERVICES',
    source: 'BUYER_INVITE_SPOT',
    isMsme: false,
    lifecycleStatus: 'INVITED',
    completedSteps: 0,
    submitted: false,
    contactEmail: 'presales@apexit.example',
    contactName: 'V. Menon',
  },
];

/** Historical scorecards for the existing activated sourcing vendors. */
const SCORECARDS: Array<{
  code: string;
  otif: number;
  quality: number;
  responseHrs: number;
  disputePct: number;
  participationPct: number;
  winPct: number;
  transactions: number;
  spend: string;
  score: number;
  grade: string;
}> = [
  {
    code: 'V-BHILAI',
    otif: 92,
    quality: 94,
    responseHrs: 30,
    disputePct: 4,
    participationPct: 88,
    winPct: 45,
    transactions: 18,
    spend: '4820000.0000',
    score: 88.5,
    grade: 'A',
  },
  {
    code: 'V-CONTI',
    otif: 88,
    quality: 90,
    responseHrs: 42,
    disputePct: 6,
    participationPct: 80,
    winPct: 38,
    transactions: 12,
    spend: '3110000.0000',
    score: 82.0,
    grade: 'A',
  },
  {
    code: 'V-PRECIS',
    otif: 96,
    quality: 100,
    responseHrs: 22,
    disputePct: 1,
    participationPct: 92,
    winPct: 52,
    transactions: 9,
    spend: '2260000.0000',
    score: 93.0,
    grade: 'A+',
  },
];

async function main(): Promise<void> {
  const tenant = await prisma.tenant.findFirstOrThrow({
    where: { name: 'Star Cement Ltd' },
  });

  await seedCategoryConfigs(tenant.id);
  const legalOfficerId = await seedLegalOfficer(tenant.id);
  await seedOnboardingMatrix(tenant.id);
  await seedScorecards(tenant.id);

  const vendorRole = await prisma.role.findUniqueOrThrow({
    where: { name: 'VENDOR_USER' },
  });
  for (const spec of ONBOARDINGS) {
    await seedOnboarding(tenant.id, spec, vendorRole.id);
  }

  console.log('Slice 7 seed complete:');
  console.log(`  • ${VENDOR_CATEGORY_CONFIGS.length} vendor category configs`);
  console.log(`  • LEGAL_OFFICER user seeded (${legalOfficerId})`);
  console.log(
    '  • VENDOR_ONBOARDING matrix (standard · flagged+legal · related-party+MD)',
  );
  console.log(`  • ${SCORECARDS.length} historical scorecards`);
  console.log(`  • ${ONBOARDINGS.length} in-flight onboardings (1 awaiting review)`);
}

async function seedCategoryConfigs(tenantId: string): Promise<void> {
  for (const config of VENDOR_CATEGORY_CONFIGS) {
    await prisma.vendorCategoryConfig.upsert({
      where: { tenantId_categoryKey: { tenantId, categoryKey: config.categoryKey } },
      update: {
        displayName: config.displayName,
        description: config.description,
        requiredDocuments: config.requiredDocuments as unknown as Prisma.InputJsonValue,
        optionalDocuments: config.optionalDocuments as unknown as Prisma.InputJsonValue,
        requiredScreenings: config.requiredScreenings as unknown as Prisma.InputJsonValue,
        requiredCertifications:
          config.requiredCertifications as unknown as Prisma.InputJsonValue,
        approvalMatrixName: config.approvalMatrixName,
        slaHours: config.slaHours,
      },
      create: {
        id: newId('vendorCategoryConfig'),
        tenantId,
        categoryKey: config.categoryKey,
        displayName: config.displayName,
        description: config.description,
        requiredDocuments: config.requiredDocuments as unknown as Prisma.InputJsonValue,
        optionalDocuments: config.optionalDocuments as unknown as Prisma.InputJsonValue,
        requiredScreenings: config.requiredScreenings as unknown as Prisma.InputJsonValue,
        requiredCertifications:
          config.requiredCertifications as unknown as Prisma.InputJsonValue,
        approvalMatrixName: config.approvalMatrixName,
        slaHours: config.slaHours,
      },
    });
  }
}

async function seedLegalOfficer(tenantId: string): Promise<string> {
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'LEGAL_OFFICER' } });
  const email = 'legal@starcement.example';
  const argonHash = await hash(STAFF_PASSWORD, { type: 2 });
  const user = await prisma.user.upsert({
    where: { tenantId_email: { tenantId, email } },
    update: { isActive: true },
    create: {
      id: newId('user'),
      tenantId,
      email,
      name: 'L. Advani (Legal)',
      argonHash,
      isActive: true,
    },
  });
  const hasRole = await prisma.userRole.findFirst({
    where: { userId: user.id, roleId: role.id },
  });
  if (!hasRole) {
    await prisma.userRole.create({
      data: { id: newId('userRole'), tenantId, userId: user.id, roleId: role.id },
    });
  }
  return user.id;
}

async function seedOnboardingMatrix(tenantId: string): Promise<void> {
  const step = (stepNo: number, name: string, role: string, sla = 48): unknown => ({
    step_no: stepNo,
    name,
    role,
    scope: 'tenant',
    sla_hours: sla,
  });
  const matrices = [
    {
      // Related-party vendors: full governance chain.
      name: 'Vendor onboarding — related party',
      priority: 1,
      conditions: { all: [{ field: 'is_related_party', op: 'eq', value: true }] },
      steps: [
        step(1, 'Procurement Head', 'PROCUREMENT_HEAD'),
        step(2, 'Legal Officer', 'LEGAL_OFFICER'),
        step(3, 'Managing Director', 'MD', 72),
      ],
    },
    {
      // Any flagged screening → legal review.
      name: 'Vendor onboarding — compliance review',
      priority: 2,
      conditions: { all: [{ field: 'has_flagged_screening', op: 'eq', value: true }] },
      steps: [
        step(1, 'Procurement Head', 'PROCUREMENT_HEAD'),
        step(2, 'Legal Officer', 'LEGAL_OFFICER'),
      ],
    },
    {
      // Standard path (catch-all): procurement head approves.
      name: 'Vendor onboarding — standard',
      priority: 3,
      conditions: { all: [] },
      steps: [step(1, 'Procurement Head', 'PROCUREMENT_HEAD')],
    },
  ];
  for (const m of matrices) {
    const existing = await prisma.approvalMatrix.findFirst({
      where: { tenantId, name: m.name, documentType: 'VENDOR_ONBOARDING' },
    });
    if (existing) continue;
    await prisma.approvalMatrix.create({
      data: {
        id: newId('approvalMatrix'),
        tenantId,
        documentType: 'VENDOR_ONBOARDING',
        name: m.name,
        priority: m.priority,
        isActive: true,
        conditions: m.conditions as unknown as Prisma.InputJsonValue,
        steps: m.steps as unknown as Prisma.InputJsonValue,
      },
    });
  }

  // Material change requests reuse a simple single-step procurement-head chain.
  const changeMatrixName = 'Vendor change — material';
  const changeExisting = await prisma.approvalMatrix.findFirst({
    where: { tenantId, name: changeMatrixName, documentType: 'VENDOR_CHANGE' },
  });
  if (!changeExisting) {
    await prisma.approvalMatrix.create({
      data: {
        id: newId('approvalMatrix'),
        tenantId,
        documentType: 'VENDOR_CHANGE',
        name: changeMatrixName,
        priority: 1,
        isActive: true,
        conditions: { all: [] } as unknown as Prisma.InputJsonValue,
        steps: [
          step(1, 'Procurement Head', 'PROCUREMENT_HEAD'),
        ] as unknown as Prisma.InputJsonValue,
      },
    });
  }
}

async function seedScorecards(tenantId: string): Promise<void> {
  for (const sc of SCORECARDS) {
    const vendor = await prisma.vendor.findFirst({ where: { tenantId, code: sc.code } });
    if (!vendor) continue;
    const metrics = {
      otifPct: sc.otif,
      qualityPct: sc.quality,
      responseTimeAvgHrs: sc.responseHrs,
      disputeRatePct: sc.disputePct,
      paymentCycleDays: 34,
      rfqParticipationPct: sc.participationPct,
      winRatePct: sc.winPct,
    };
    await prisma.vendorScorecard.upsert({
      where: {
        vendorId_categoryKey_period: {
          vendorId: vendor.id,
          categoryKey: '',
          period: 'ROLLING_90D',
        },
      },
      update: {
        metrics: metrics as unknown as Prisma.InputJsonValue,
        score: new Prisma.Decimal(sc.score),
        grade: sc.grade,
        transactionCount: sc.transactions,
        spendAmount: new Prisma.Decimal(sc.spend),
      },
      create: {
        id: newId('vendorScorecard'),
        tenantId,
        vendorId: vendor.id,
        categoryKey: null,
        period: 'ROLLING_90D',
        metrics: metrics as unknown as Prisma.InputJsonValue,
        score: new Prisma.Decimal(sc.score),
        grade: sc.grade,
        transactionCount: sc.transactions,
        spendAmount: new Prisma.Decimal(sc.spend),
      },
    });
    // Denormalise a risk grade so the master list shows something.
    await prisma.vendor.update({
      where: { id: vendor.id },
      data: {
        lifecycleStatus: 'ACTIVE',
        riskGrade: 'B',
        riskScore: new Prisma.Decimal('78.00'),
        riskLastComputedAt: new Date(),
        categoryConfigKey: 'MECHANICAL_SPARES',
      },
    });
  }
}

async function seedOnboarding(
  tenantId: string,
  spec: OnboardingSpec,
  vendorRoleId: string,
): Promise<void> {
  const config = VENDOR_CATEGORY_CONFIGS.find((c) => c.categoryKey === spec.categoryKey);
  const slaHours = config?.slaHours ?? 120;

  const vendor = await prisma.vendor.upsert({
    where: { tenantId_code: { tenantId, code: spec.code } },
    update: { name: spec.name, lifecycleStatus: spec.lifecycleStatus },
    create: {
      id: newId('vendor'),
      tenantId,
      code: spec.code,
      name: spec.name,
      legalEntityName: spec.legalEntityName,
      status: 'PENDING_VERIFICATION',
      lifecycleStatus: spec.lifecycleStatus,
      preliminaryStatus: true,
      isMsme: spec.isMsme,
      categoryConfigKey: spec.categoryKey,
      onboardingStartedAt: new Date(),
      cocAcknowledgedAt: spec.submitted ? new Date() : null,
      dataProcessingConsentAt: spec.submitted ? new Date() : null,
    },
  });

  // Primary contact + portal user.
  const existingContact = await prisma.vendorContact.findFirst({
    where: { vendorId: vendor.id, email: spec.contactEmail },
  });
  if (!existingContact) {
    await prisma.vendorContact.create({
      data: {
        id: newId('vendorContact'),
        tenantId,
        vendorId: vendor.id,
        name: spec.contactName,
        email: spec.contactEmail,
        isPrimary: true,
      },
    });
  }
  const argonHash = await hash(VENDOR_PASSWORD, { type: 2 });
  const user = await prisma.user.upsert({
    where: { tenantId_email: { tenantId, email: spec.contactEmail } },
    update: { isActive: true },
    create: {
      id: newId('user'),
      tenantId,
      email: spec.contactEmail,
      name: spec.contactName,
      argonHash,
      isActive: true,
    },
  });
  const hasRole = await prisma.userRole.findFirst({
    where: { userId: user.id, roleId: vendorRoleId },
  });
  if (!hasRole) {
    await prisma.userRole.create({
      data: { id: newId('userRole'), tenantId, userId: user.id, roleId: vendorRoleId },
    });
  }

  // Wizard state at the requested completion.
  const steps: Record<string, { done: boolean; data: Record<string, unknown> }> = {};
  for (let i = 1; i <= spec.completedSteps; i += 1) {
    steps[`step${i}`] = { done: true, data: {} };
  }
  const completionPct = Math.round((spec.completedSteps / ONBOARDING_STEP_COUNT) * 100);
  const wizardState = {
    currentStep: Math.min(ONBOARDING_STEP_COUNT, spec.completedSteps + 1),
    completionPct,
    steps,
  };

  const existingOnboarding = await prisma.vendorOnboarding.findFirst({
    where: { vendorId: vendor.id },
  });
  const onboardingData = {
    invitationSource: spec.source,
    invitedBy: null,
    wizardState: wizardState as unknown as Prisma.InputJsonValue,
    categoryConfigKey: spec.categoryKey,
    slaTargetHours: slaHours,
    slaBreachAt: new Date(Date.now() + slaHours * 3_600_000),
    submittedAt: spec.submitted ? new Date() : null,
  };
  if (existingOnboarding) {
    await prisma.vendorOnboarding.update({
      where: { id: existingOnboarding.id },
      data: onboardingData,
    });
  } else {
    await prisma.vendorOnboarding.create({
      data: {
        id: newId('vendorOnboarding'),
        tenantId,
        vendorId: vendor.id,
        ...onboardingData,
      },
    });
  }

  // For the submitted one, add verified statutory docs + route it through the
  // approval engine so it lands in the Procurement Head's review queue.
  if (spec.submitted) {
    for (const docType of ['GST_CERT', 'PAN_CARD', 'CANCELLED_CHEQUE'] as const) {
      const has = await prisma.vendorDocument.findFirst({
        where: { vendorId: vendor.id, docType },
      });
      if (has) continue;
      await prisma.vendorDocument.create({
        data: {
          id: newId('vendorDocument'),
          tenantId,
          vendorId: vendor.id,
          docType,
          s3Key: `seed/${spec.code}/${docType}.pdf`,
          filename: `${docType}.pdf`,
          sizeBytes: 102400,
          fileHash: `seed-${docType}`,
          mimeType: 'application/pdf',
          uploadedBy: user.id,
          uploadedAt: new Date(),
          verificationStatus: 'AUTO_VERIFIED',
          verificationSource: 'AUTO_API',
          verifiedAt: new Date(),
        },
      });
    }
    await routeSubmittedOnboarding(tenantId, vendor.id);
  }
}

/**
 * Hand-route a pre-submitted seed onboarding: writes the standard matrix
 * snapshot and a pending step-1 Approval assigned to the Procurement Head, so
 * the review queue is populated at seed time (the live path does this via
 * ApprovalRoutingService.submit). Idempotent.
 */
async function routeSubmittedOnboarding(
  tenantId: string,
  vendorId: string,
): Promise<void> {
  const onboarding = await prisma.vendorOnboarding.findFirst({ where: { vendorId } });
  if (!onboarding) return;
  const already = await prisma.approval.count({
    where: { documentType: 'VENDOR_ONBOARDING', documentId: onboarding.id },
  });
  if (already > 0) return;

  const matrix = await prisma.approvalMatrix.findFirst({
    where: {
      tenantId,
      documentType: 'VENDOR_ONBOARDING',
      name: 'Vendor onboarding — standard',
    },
  });
  const head = await prisma.user.findFirst({
    where: { tenantId, email: 'harpreet@star-cement.example' },
  });
  if (!matrix || !head) return;

  const steps = [
    {
      step_no: 1,
      name: 'Procurement Head',
      role: 'PROCUREMENT_HEAD',
      scope: 'tenant',
      sla_hours: 48,
    },
  ];
  await prisma.vendorOnboarding.update({
    where: { id: onboarding.id },
    data: {
      reviewStartedAt: new Date(),
      approvalMatrixSnapshot: {
        matrixId: matrix.id,
        name: matrix.name,
        version: matrix.version,
        steps,
      } as unknown as Prisma.InputJsonValue,
    },
  });
  await prisma.approval.create({
    data: {
      id: newId('approval'),
      tenantId,
      documentType: 'VENDOR_ONBOARDING',
      documentId: onboarding.id,
      stepNo: 1,
      stepName: 'Procurement Head',
      scope: 'tenant',
      approverId: head.id,
      slaHours: 48,
      slaDueAt: new Date(Date.now() + 48 * 3_600_000),
      matrixSnapshotId: matrix.id,
    },
  });
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
