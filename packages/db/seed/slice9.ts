/**
 * Slice 9 seed — contracts.
 *  1. Clause library — Star Cement's standard clauses.
 *  2. Approval matrices for CONTRACT and CONTRACT_AMENDMENT.
 *  3. Coal transport rate contract (2-year, route-based, fuel-indexed) — ACTIVE,
 *     against Northeast Logistics (activated from the Slice 7 onboarding queue).
 *  4. Gypsum framework agreement — born from a retroactive FRAMEWORK RFQ + award
 *     (Rajasthan Gypsum), ACTIVE.
 *  5. Packaging materials rate contract — JK Paper, volume-banded, ACTIVE.
 *  6. A near-expiry contract (60 days out) with a live renewal alert.
 * Idempotent by contract number / matrix name.
 */
import { hash } from 'argon2';
import { ContractClauseType, Prisma, PrismaClient } from '@prisma/client';

import { newId } from '../src/ids';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? '' },
  },
});

const TENANT_NAME = 'Star Cement Ltd';
const DAY = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { name: TENANT_NAME } });
  const tenantId = tenant.id;
  const harpreet = await prisma.user.findFirstOrThrow({
    where: { tenantId, email: 'harpreet@star-cement.example' },
  });

  await seedClauseLibrary(tenantId, harpreet.id);
  await seedContractMatrices(tenantId);
  const logistics = await activateLogisticsVendor(tenantId);
  await seedCoalContract(tenantId, harpreet.id, logistics.id);
  await seedGypsumFramework(tenantId, harpreet.id);
  await seedPackagingContract(tenantId, harpreet.id);
  await seedNearExpiryContract(tenantId, harpreet.id);

  console.log('Slice 9 seed complete — contracts, clause library, matrices.');
}

// ── 1. Clause library ─────────────────────────────────────────────────────────

async function seedClauseLibrary(tenantId: string, actorId: string): Promise<void> {
  const clauses: {
    clauseType: string;
    title: string;
    contentText: string;
    isDefault: boolean;
  }[] = [
    {
      clauseType: 'PAYMENT_TERMS',
      title: 'Payment terms — Net 45 (MSME)',
      contentText:
        'Payment shall be made within 45 days of receipt of a valid tax invoice and ' +
        'satisfactory 3-way match, in accordance with Section 15 of the MSMED Act, 2006.',
      isDefault: true,
    },
    {
      clauseType: 'PAYMENT_TERMS',
      title: 'Payment terms — Net 30 (standard)',
      contentText:
        'Payment shall be made within 30 days of receipt of a valid tax invoice and ' +
        'satisfactory 3-way match against the corresponding GRN.',
      isDefault: false,
    },
    {
      clauseType: 'DELIVERY_SLA',
      title: 'Delivery SLA',
      contentText:
        'Vendor shall deliver ordered quantities to the nominated plant within the ' +
        'lead time stated on each call-off. On-time-in-full (OTIF) performance below ' +
        '95% over any quarter constitutes a material breach.',
      isDefault: true,
    },
    {
      clauseType: 'QUALITY_STANDARD',
      title: 'Quality standard — AQL 1.0',
      contentText:
        'Goods shall conform to specification and pass acceptance sampling at AQL 1.0 ' +
        '(per the Buyer’s Slice-5 QC framework). Rejected lots are returnable at ' +
        'Vendor’s cost.',
      isDefault: true,
    },
    {
      clauseType: 'PENALTY',
      title: 'Liquidated damages — late delivery',
      contentText:
        'Liquidated damages of 0.5% of the delayed line value per week (capped at 5%) ' +
        'shall apply to deliveries received after the agreed date, without prejudice to ' +
        'the Buyer’s other remedies.',
      isDefault: true,
    },
    {
      clauseType: 'FORCE_MAJEURE',
      title: 'Force majeure',
      contentText:
        'Neither party shall be liable for failure to perform due to events beyond its ' +
        'reasonable control (acts of God, flood, strike, government action). The affected ' +
        'party shall notify the other within 7 days.',
      isDefault: true,
    },
    {
      clauseType: 'TERMINATION',
      title: 'Termination for convenience',
      contentText:
        'Either party may terminate this agreement on 30 days’ written notice. Call-off ' +
        'purchase orders already issued shall be honoured to completion.',
      isDefault: true,
    },
    {
      clauseType: 'CONFIDENTIALITY',
      title: 'Confidentiality',
      contentText:
        'Each party shall keep confidential all non-public information disclosed under ' +
        'this agreement and use it solely for performance hereunder.',
      isDefault: true,
    },
    {
      clauseType: 'INSURANCE',
      title: 'Insurance minimums',
      contentText:
        'Vendor shall maintain transit and public-liability insurance of not less than ' +
        'INR 1 crore for the duration of this agreement and furnish certificates on request.',
      isDefault: true,
    },
  ];
  for (const c of clauses) {
    const existing = await prisma.clauseLibrary.findFirst({
      where: { tenantId, clauseType: c.clauseType as never, title: c.title },
    });
    if (existing) continue;
    await prisma.clauseLibrary.create({
      data: {
        id: newId('clauseLibrary'),
        tenantId,
        clauseType: c.clauseType as never,
        title: c.title,
        contentText: c.contentText,
        isDefault: c.isDefault,
        createdBy: actorId,
      },
    });
  }
}

// ── 2. Approval matrices ───────────────────────────────────────────────────────

async function seedContractMatrices(tenantId: string): Promise<void> {
  const step = (stepNo: number, name: string, role: string, sla = 48): unknown => ({
    step_no: stepNo,
    name,
    role,
    scope: 'tenant',
    sla_hours: sla,
    ...(role === 'LEGAL_OFFICER' ? { parallel_group: 'legal-review' } : {}),
  });

  const contractMatrices = [
    {
      name: 'Contract — up to ₹25L',
      priority: 1,
      conditions: { all: [{ field: 'total_amount', op: 'lte', value: '2500000' }] },
      steps: [
        step(1, 'Procurement Head', 'PROCUREMENT_HEAD'),
        step(1, 'Legal Officer', 'LEGAL_OFFICER'),
      ],
    },
    {
      name: 'Contract — ₹25L to ₹1Cr',
      priority: 2,
      conditions: {
        all: [
          { field: 'total_amount', op: 'gt', value: '2500000' },
          { field: 'total_amount', op: 'lte', value: '10000000' },
        ],
      },
      steps: [
        step(1, 'Procurement Head', 'PROCUREMENT_HEAD'),
        step(1, 'Legal Officer', 'LEGAL_OFFICER'),
        step(2, 'Finance Head (CFO)', 'FINANCE_HEAD', 72),
      ],
    },
    {
      name: 'Contract — above ₹1Cr',
      priority: 3,
      conditions: { all: [{ field: 'total_amount', op: 'gt', value: '10000000' }] },
      steps: [
        step(1, 'Procurement Head', 'PROCUREMENT_HEAD'),
        step(1, 'Legal Officer', 'LEGAL_OFFICER'),
        step(2, 'Finance Head (CFO)', 'FINANCE_HEAD', 72),
        step(3, 'Managing Director', 'MD', 72),
      ],
    },
  ];

  const amendmentMatrices = [
    {
      name: 'Amendment — up to ₹25L change',
      priority: 1,
      conditions: { all: [{ field: 'total_amount', op: 'lte', value: '2500000' }] },
      steps: [
        step(1, 'Procurement Head', 'PROCUREMENT_HEAD'),
        step(1, 'Legal Officer', 'LEGAL_OFFICER'),
      ],
    },
    {
      name: 'Amendment — above ₹25L change',
      priority: 2,
      conditions: { all: [{ field: 'total_amount', op: 'gt', value: '2500000' }] },
      steps: [
        step(1, 'Procurement Head', 'PROCUREMENT_HEAD'),
        step(1, 'Legal Officer', 'LEGAL_OFFICER'),
        step(2, 'Finance Head (CFO)', 'FINANCE_HEAD', 72),
      ],
    },
  ];

  await upsertMatrices(tenantId, 'CONTRACT', contractMatrices);
  await upsertMatrices(tenantId, 'CONTRACT_AMENDMENT', amendmentMatrices);
}

async function upsertMatrices(
  tenantId: string,
  documentType: string,
  matrices: { name: string; priority: number; conditions: unknown; steps: unknown[] }[],
): Promise<void> {
  for (const m of matrices) {
    const existing = await prisma.approvalMatrix.findFirst({
      where: { tenantId, name: m.name, documentType: documentType as never },
    });
    if (existing) continue;
    await prisma.approvalMatrix.create({
      data: {
        id: newId('approvalMatrix'),
        tenantId,
        documentType: documentType as never,
        name: m.name,
        priority: m.priority,
        isActive: true,
        conditions: m.conditions as Prisma.InputJsonValue,
        steps: m.steps as Prisma.InputJsonValue,
      },
    });
  }
}

// ── Vendor activation ──────────────────────────────────────────────────────────

async function activateLogisticsVendor(tenantId: string): Promise<{ id: string }> {
  const vendor = await prisma.vendor.findFirst({
    where: { tenantId, code: 'V-ONB-NORTHLOG' },
  });
  if (!vendor) {
    // Fallback: reuse Continental Belt if the Slice 7 onboarding vendor is absent.
    const conti = await prisma.vendor.findFirstOrThrow({
      where: { tenantId, code: 'V-CONTI' },
    });
    await ensureVerifiedBank(tenantId, conti.id);
    await ensureVendorUser(
      tenantId,
      conti.id,
      'contracts@continental-belt.example',
      'Continental Belt — Contracts',
    );
    return { id: conti.id };
  }
  await prisma.vendor.update({
    where: { id: vendor.id },
    data: { status: 'ACTIVE', lifecycleStatus: 'ACTIVE' },
  });
  await ensureVerifiedBank(tenantId, vendor.id);
  await ensureVendorUser(
    tenantId,
    vendor.id,
    'ops@northeast-logistics.example',
    'Northeast Logistics — Operations',
  );
  return { id: vendor.id };
}

async function ensureVerifiedBank(tenantId: string, vendorId: string): Promise<void> {
  const existing = await prisma.vendorBank.findFirst({
    where: { vendorId, isVerified: true },
  });
  if (existing) return;
  await prisma.vendorBank.create({
    data: {
      id: newId('vendorBank'),
      tenantId,
      vendorId,
      bankName: 'HDFC Bank',
      accountNoEncrypted: 'enc::' + Math.random().toString(36).slice(2),
      ifsc: 'HDFC0001234',
      holderName: 'Northeast Logistics Services',
      isVerified: true,
      verifiedAt: new Date(),
      pennyDropRef: 'PD-SEED-NELOG',
    },
  });
}

async function ensureVendorUser(
  tenantId: string,
  vendorId: string,
  email: string,
  name: string,
): Promise<void> {
  const existing = await prisma.user.findUnique({
    where: { tenantId_email: { tenantId, email } },
  });
  const argon = await hash('Slice0!Vendor', { type: 2 });
  const user =
    existing ??
    (await prisma.user.create({
      data: { id: newId('user'), tenantId, email, name, argonHash: argon },
    }));
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'VENDOR_USER' } });
  const hasRole = await prisma.userRole.findFirst({
    where: { userId: user.id, roleId: role.id },
  });
  if (!hasRole) {
    await prisma.userRole.create({
      data: { id: newId('userRole'), tenantId, userId: user.id, roleId: role.id },
    });
  }
  const contact = await prisma.vendorContact.findFirst({ where: { vendorId, email } });
  if (!contact) {
    await prisma.vendorContact.create({
      data: {
        id: newId('vendorContact'),
        tenantId,
        vendorId,
        name,
        email,
        role: 'Operations',
        isPrimary: true,
      },
    });
  }
}

// ── 3. Coal transport contract ─────────────────────────────────────────────────

async function seedCoalContract(
  tenantId: string,
  actorId: string,
  vendorId: string,
): Promise<void> {
  const number = 'CT-2026-0001';
  if (await prisma.contract.findFirst({ where: { tenantId, number } })) return;

  const start = new Date('2026-04-01T00:00:00Z');
  const end = new Date('2028-03-31T00:00:00Z');
  const y1End = new Date('2027-03-31T00:00:00Z');
  const y2Start = new Date('2027-04-01T00:00:00Z');

  const routes = [
    { origin: 'Lumshnong', dest: 'Guwahati depot', y1: '2.85', y2: '3.05' },
    { origin: 'Lumshnong', dest: 'Shillong yard', y1: '2.40', y2: '2.60' },
    { origin: 'Lumshnong', dest: 'Silchar siding', y1: '3.20', y2: '3.45' },
  ];
  const rateCards = routes.flatMap((r, i) => [
    {
      id: newId('contractRateCard'),
      tenantId,
      lineNo: i + 1,
      itemDesc: `Coal haulage ${r.origin}→${r.dest}`,
      uom: 'tonne-km',
      rateYear: 1,
      unitRate: new Prisma.Decimal(r.y1),
      taxRate: new Prisma.Decimal('0.05'),
      routeOrigin: r.origin,
      routeDest: r.dest,
      effectiveFrom: start,
      effectiveTo: y1End,
    },
    {
      id: newId('contractRateCard'),
      tenantId,
      lineNo: i + 1,
      itemDesc: `Coal haulage ${r.origin}→${r.dest}`,
      uom: 'tonne-km',
      rateYear: 2,
      unitRate: new Prisma.Decimal(r.y2),
      taxRate: new Prisma.Decimal('0.05'),
      routeOrigin: r.origin,
      routeDest: r.dest,
      effectiveFrom: y2Start,
      effectiveTo: end,
    },
  ]);

  await prisma.contract.create({
    data: {
      id: newId('contract'),
      tenantId,
      number,
      title: 'Annual coal transport — Lumshnong routes',
      contractType: 'RATE_CONTRACT',
      vendorId,
      category: 'Logistics',
      status: 'ACTIVE',
      validityStart: start,
      validityEnd: end,
      autoRenew: false,
      renewalNoticeDays: 90,
      currency: 'INR',
      totalValueEstimate: new Prisma.Decimal('18500000'),
      minimumCommitmentQty: new Prisma.Decimal('240000'),
      minimumCommitmentValue: new Prisma.Decimal('9000000'),
      commitmentUom: 'tonne-km',
      commitmentPeriod: 'ANNUAL',
      paymentTermsSnapshot: { kind: 'NET_30' } as Prisma.InputJsonValue,
      escalationClause: {
        type: 'INDEXED',
        indexRef: 'HPCL_DIESEL_KOLKATA',
        baseIndexValue: '92.50',
        reviewFrequency: 'QUARTERLY',
        capPct: '10',
      } as Prisma.InputJsonValue,
      terminationNoticeDays: 30,
      governingLaw: 'Laws of India; Meghalaya jurisdiction',
      requireVendorCountersign: false,
      skipPoApprovalWithinContract: true,
      executedAt: new Date('2026-03-25T00:00:00Z'),
      executedBy: actorId,
      createdBy: actorId,
      rateCards: { createMany: { data: rateCards } },
      clauses: {
        createMany: {
          data: standardClauseRows(tenantId, [
            'Payment terms — Net 30 (standard)',
            'Delivery SLA',
            'Termination for convenience',
            'Liquidated damages — late delivery',
            'Force majeure',
            'Insurance minimums',
          ]),
        },
      },
      volumeTracking: {
        create: {
          id: newId('contractVolumeTracking'),
          tenantId,
          period: 'FY2026',
          committedQty: new Prisma.Decimal('240000'),
          committedValue: new Prisma.Decimal('9000000'),
          actualQty: new Prisma.Decimal('0'),
          actualValue: new Prisma.Decimal('0'),
          status: 'ON_TRACK',
        },
      },
    },
  });
}

// ── 4. Gypsum framework agreement (from a FRAMEWORK RFQ) ────────────────────────

async function seedGypsumFramework(tenantId: string, actorId: string): Promise<void> {
  const number = 'CT-2026-0002';
  if (await prisma.contract.findFirst({ where: { tenantId, number } })) return;
  const vendor = await prisma.vendor.findFirst({ where: { tenantId, code: 'V-RAJGY' } });
  if (!vendor) return;

  // Retroactive FRAMEWORK RFQ + award for narrative consistency.
  const rfqNumber = 'RFQ-9001';
  let rfq = await prisma.rfq.findFirst({
    where: { tenantId, number: rfqNumber },
    include: { lines: true },
  });
  if (!rfq) {
    const rfqId = newId('rfq');
    const lineId = newId('rfqLine');
    rfq = await prisma.rfq.create({
      data: {
        id: rfqId,
        tenantId,
        number: rfqNumber,
        title: 'Framework — gypsum supply FY26–27',
        category: 'Raw material',
        rfqType: 'FRAMEWORK',
        status: 'AWARDED',
        incotermDefault: 'DDP',
        deliveryLocation: {
          address: 'Lumshnong plant',
          stateCode: '17',
        } as Prisma.InputJsonValue,
        paymentTermsDefault: JSON.stringify({ kind: 'NET_45' }),
        evaluationCriteria: { price: 100 } as Prisma.InputJsonValue,
        requiredDocuments: [],
        createdBy: actorId,
        lines: {
          create: [
            {
              id: lineId,
              tenantId,
              lineNo: 1,
              itemDesc: 'Natural gypsum (min 80% purity)',
              uom: 'tonne',
              qtyRequired: new Prisma.Decimal('5000'),
            },
          ],
        },
      },
      include: { lines: true },
    });
    const quoteId = newId('quote');
    const invId = newId('rfqInvitation');
    await prisma.rfqInvitation.create({
      data: {
        id: invId,
        tenantId,
        rfqId,
        vendorId: vendor.id,
        invitedBy: actorId,
        invitationSource: 'DIRECTORY',
        watermarkSeed: newId('quoteAttachment'),
        status: 'QUOTE_SUBMITTED',
      },
    });
    await prisma.quote.create({
      data: {
        id: quoteId,
        tenantId,
        rfqId,
        invitationId: invId,
        vendorId: vendor.id,
        envelopeType: 'COMBINED',
        incoterm: 'DDP',
        status: 'QUALIFIED',
        submittedAt: new Date('2026-03-15T10:00:00Z'),
        totalCommercialValue: new Prisma.Decimal('4250000'),
        lines: {
          create: [
            {
              id: newId('quoteLine'),
              tenantId,
              rfqLineId: rfq.lines[0]!.id,
              qtyQuoted: new Prisma.Decimal('5000'),
              unitPriceNative: new Prisma.Decimal('850'),
              unitPriceInrLanded: new Prisma.Decimal('850'),
              lineTotalNative: new Prisma.Decimal('4250000'),
              deliveryLeadDays: 21,
            },
          ],
        },
      },
    });
    await prisma.award.create({
      data: {
        id: newId('award'),
        tenantId,
        rfqId,
        recommendationBy: actorId,
        recommendationNotes: 'Sole qualified framework bidder; rate locked for FY26–27.',
        totalValue: new Prisma.Decimal('4250000'),
        status: 'APPROVED',
        approvedAt: new Date('2026-03-20T00:00:00Z'),
        approvedBy: actorId,
        allocations: {
          create: [
            {
              id: newId('awardAllocation'),
              tenantId,
              quoteId,
              vendorId: vendor.id,
              rfqLineId: rfq.lines[0]!.id,
              qtyAllocated: new Prisma.Decimal('5000'),
              unitPrice: new Prisma.Decimal('850'),
              totalValue: new Prisma.Decimal('4250000'),
            },
          ],
        },
      },
    });
  }

  const start = new Date('2026-04-01T00:00:00Z');
  const end = new Date('2027-03-31T00:00:00Z');
  await prisma.contract.create({
    data: {
      id: newId('contract'),
      tenantId,
      number,
      title: 'Gypsum framework agreement FY26–27',
      contractType: 'FRAMEWORK_AGREEMENT',
      vendorId: vendor.id,
      category: 'Raw material',
      rfqId: rfq.id,
      status: 'ACTIVE',
      validityStart: start,
      validityEnd: end,
      renewalNoticeDays: 90,
      currency: 'INR',
      totalValueEstimate: new Prisma.Decimal('4250000'),
      commitmentPeriod: 'ANNUAL',
      paymentTermsSnapshot: { kind: 'NET_45' } as Prisma.InputJsonValue,
      terminationNoticeDays: 30,
      requireVendorCountersign: false,
      skipPoApprovalWithinContract: true,
      executedAt: new Date('2026-03-28T00:00:00Z'),
      executedBy: actorId,
      createdBy: actorId,
      rateCards: {
        create: [
          {
            id: newId('contractRateCard'),
            tenantId,
            lineNo: 1,
            itemDesc: 'Natural gypsum (min 80% purity)',
            uom: 'tonne',
            rateYear: 1,
            unitRate: new Prisma.Decimal('850'),
            taxRate: new Prisma.Decimal('0.05'),
            effectiveFrom: start,
            effectiveTo: end,
          },
        ],
      },
      clauses: {
        createMany: {
          data: standardClauseRows(tenantId, [
            'Payment terms — Net 45 (MSME)',
            'Delivery SLA',
            'Termination for convenience',
            'Quality standard — AQL 1.0',
          ]),
        },
      },
    },
  });
}

// ── 5. Packaging rate contract (volume-banded) ─────────────────────────────────

async function seedPackagingContract(tenantId: string, actorId: string): Promise<void> {
  const number = 'CT-2026-0003';
  if (await prisma.contract.findFirst({ where: { tenantId, number } })) return;
  const vendor = await prisma.vendor.findFirst({ where: { tenantId, code: 'V-JKPAP' } });
  if (!vendor) return;

  const start = new Date('2026-04-01T00:00:00Z');
  const end = new Date('2027-03-31T00:00:00Z');
  await prisma.contract.create({
    data: {
      id: newId('contract'),
      tenantId,
      number,
      title: 'Packaging materials rate contract FY26–27',
      contractType: 'RATE_CONTRACT',
      vendorId: vendor.id,
      category: 'Packaging',
      status: 'ACTIVE',
      validityStart: start,
      validityEnd: end,
      renewalNoticeDays: 90,
      currency: 'INR',
      totalValueEstimate: new Prisma.Decimal('6200000'),
      commitmentPeriod: 'ANNUAL',
      paymentTermsSnapshot: { kind: 'NET_30' } as Prisma.InputJsonValue,
      terminationNoticeDays: 30,
      requireVendorCountersign: false,
      skipPoApprovalWithinContract: true,
      executedAt: new Date('2026-03-26T00:00:00Z'),
      executedBy: actorId,
      createdBy: actorId,
      rateCards: {
        create: [
          {
            id: newId('contractRateCard'),
            tenantId,
            lineNo: 1,
            itemDesc: 'HDPE cement sacks — band ≤ 500t',
            uom: 'tonne',
            rateYear: 1,
            unitRate: new Prisma.Decimal('68500'),
            taxRate: new Prisma.Decimal('0.18'),
            volumeBandMin: new Prisma.Decimal('0'),
            volumeBandMax: new Prisma.Decimal('500'),
            effectiveFrom: start,
            effectiveTo: end,
          },
          {
            id: newId('contractRateCard'),
            tenantId,
            lineNo: 2,
            itemDesc: 'HDPE cement sacks — band > 500t',
            uom: 'tonne',
            rateYear: 1,
            unitRate: new Prisma.Decimal('65900'),
            taxRate: new Prisma.Decimal('0.18'),
            volumeBandMin: new Prisma.Decimal('500'),
            volumeBandMax: new Prisma.Decimal('5000'),
            effectiveFrom: start,
            effectiveTo: end,
          },
        ],
      },
      clauses: {
        createMany: {
          data: standardClauseRows(tenantId, [
            'Payment terms — Net 30 (standard)',
            'Delivery SLA',
            'Termination for convenience',
          ]),
        },
      },
    },
  });
}

// ── 6. Near-expiry contract (renewal demo) ─────────────────────────────────────

async function seedNearExpiryContract(tenantId: string, actorId: string): Promise<void> {
  const number = 'CT-2025-0007';
  if (await prisma.contract.findFirst({ where: { tenantId, number } })) return;
  const vendor = await prisma.vendor.findFirst({ where: { tenantId, code: 'V-SAURA' } });
  if (!vendor) return;

  const now = Date.now();
  const start = new Date(now - 305 * DAY);
  const end = new Date(now + 60 * DAY); // 60 days out → 60-day renewal bucket
  const contractId = newId('contract');
  await prisma.contract.create({
    data: {
      id: contractId,
      tenantId,
      number,
      title: 'Refractory supply — annual (expiring)',
      contractType: 'RATE_CONTRACT',
      vendorId: vendor.id,
      category: 'Refractory',
      status: 'EXPIRING_SOON',
      validityStart: start,
      validityEnd: end,
      renewalNoticeDays: 90,
      currency: 'INR',
      totalValueEstimate: new Prisma.Decimal('3800000'),
      commitmentPeriod: 'ANNUAL',
      paymentTermsSnapshot: { kind: 'NET_45' } as Prisma.InputJsonValue,
      terminationNoticeDays: 30,
      requireVendorCountersign: false,
      skipPoApprovalWithinContract: true,
      executedAt: start,
      executedBy: actorId,
      createdBy: actorId,
      rateCards: {
        create: [
          {
            id: newId('contractRateCard'),
            tenantId,
            lineNo: 1,
            itemDesc: 'High-alumina refractory bricks',
            uom: 'tonne',
            rateYear: 1,
            unitRate: new Prisma.Decimal('47500'),
            taxRate: new Prisma.Decimal('0.18'),
            effectiveFrom: start,
            effectiveTo: end,
          },
        ],
      },
      clauses: {
        createMany: {
          data: standardClauseRows(tenantId, [
            'Payment terms — Net 45 (MSME)',
            'Delivery SLA',
            'Termination for convenience',
          ]),
        },
      },
    },
  });
  // Live 60-day renewal alert so the calendar demo works without waiting.
  await prisma.contractRenewalAlert.create({
    data: {
      id: newId('contractRenewalAlert'),
      tenantId,
      contractId,
      alertType: 'NOTICE_60D',
    },
  });
}

// ── helpers ────────────────────────────────────────────────────────────────────

/** Snapshot library clauses by title into a contract (frozen at creation). */
function standardClauseRows(
  tenantId: string,
  titles: string[],
): {
  id: string;
  tenantId: string;
  clauseType: ContractClauseType;
  title: string;
  contentText: string;
  isFromLibrary: boolean;
  orderNo: number;
  isMandatory: boolean;
}[] {
  const catalogue: Record<
    string,
    { type: ContractClauseType; text: string; mandatory: boolean }
  > = {
    'Payment terms — Net 45 (MSME)': {
      type: 'PAYMENT_TERMS',
      text: 'Payment within 45 days per Section 15 of the MSMED Act, 2006.',
      mandatory: true,
    },
    'Payment terms — Net 30 (standard)': {
      type: 'PAYMENT_TERMS',
      text: 'Payment within 30 days of a valid invoice and 3-way match.',
      mandatory: true,
    },
    'Delivery SLA': {
      type: 'DELIVERY_SLA',
      text: 'OTIF ≥ 95% per quarter; delivery to nominated plant within stated lead time.',
      mandatory: true,
    },
    'Termination for convenience': {
      type: 'TERMINATION',
      text: 'Either party may terminate on 30 days’ notice; issued call-offs honoured.',
      mandatory: true,
    },
    'Liquidated damages — late delivery': {
      type: 'PENALTY',
      text: '0.5% of delayed line value per week, capped at 5%.',
      mandatory: false,
    },
    'Force majeure': {
      type: 'FORCE_MAJEURE',
      text: 'No liability for events beyond reasonable control; 7-day notice.',
      mandatory: false,
    },
    'Insurance minimums': {
      type: 'INSURANCE',
      text: 'Transit + public-liability cover ≥ INR 1 crore.',
      mandatory: false,
    },
    'Quality standard — AQL 1.0': {
      type: 'QUALITY_STANDARD',
      text: 'Acceptance sampling at AQL 1.0; rejected lots returnable at vendor cost.',
      mandatory: false,
    },
  };
  return titles.map((title, i) => {
    const c = catalogue[title]!;
    return {
      id: newId('contractClause'),
      tenantId,
      clauseType: c.type,
      title,
      contentText: c.text,
      isFromLibrary: true,
      orderNo: i,
      isMandatory: c.mandatory,
    };
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
