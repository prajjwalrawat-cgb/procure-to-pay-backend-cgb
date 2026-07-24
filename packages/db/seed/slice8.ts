/**
 * Slice 8 seed — analytics.
 *  1. TenantComplianceConfig (RBI reference rate + cost of capital).
 *  2. Populate the RLS-protected summary tables from real Slice-1 invoice data.
 *  3. A real mill-liner RFQ → split award (TATA baseline vs BHILAI/CONTI awarded)
 *     so the savings tracker has genuine baseline-vs-awarded data to compute from.
 * No fabricated aggregate numbers — everything is derived from seeded transactions.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? '' },
  },
});

const TENANT_NAME = 'Star Cement Ltd';
const uid = (p: string): string =>
  `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

async function main(): Promise<void> {
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { name: TENANT_NAME } });
  const tenantId = tenant.id;
  const harpreet = await prisma.user.findFirstOrThrow({
    where: { tenantId, email: 'harpreet@star-cement.example' },
  });

  // 1. Compliance config — RBI reference rate (as of 2026, cited) + cost of capital.
  await prisma.tenantComplianceConfig.upsert({
    where: { tenantId },
    create: {
      id: uid('tcc'),
      tenantId,
      rbiReferenceRatePct: '6.5000',
      rbiRateEffectiveFrom: new Date('2026-04-01T00:00:00Z'),
      rbiRateSource:
        'RBI bank rate (representative; verify each FY per Master Context §9)',
      costOfCapitalPct: '12.0000',
    },
    update: {},
  });

  // 2. Populate summary tables from real invoice data (mirrors AnalyticsRefreshService).
  const now = new Date();
  const tid = `'${tenantId}'::uuid`;
  await prisma.$executeRawUnsafe(
    `DELETE FROM "AnalyticsSpendMonthly" WHERE tenant_id = ${tid}`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "AnalyticsSpendMonthly"(id, tenant_id, month, gross_spend, tax_spend, net_spend, txn_count, refreshed_at)
     SELECT gen_random_uuid()::text, ${tid}, to_char("invoiceDate",'YYYY-MM'),
            SUM("grossAmount"), SUM("taxAmount"), SUM("netAmount"), COUNT(*), now()
     FROM "Invoice" WHERE tenant_id = ${tid}
       AND status NOT IN ('REJECTED','RECEIVED','OCR_PENDING','OCR_DONE')
     GROUP BY 3`,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "AnalyticsVendorMonthly" WHERE tenant_id = ${tid}`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "AnalyticsVendorMonthly"(id, tenant_id, vendor_id, month, gross_spend, net_spend, txn_count, refreshed_at)
     SELECT gen_random_uuid()::text, ${tid}, vendor_id, to_char("invoiceDate",'YYYY-MM'),
            SUM("grossAmount"), SUM("netAmount"), COUNT(*), now()
     FROM "Invoice" WHERE tenant_id = ${tid}
       AND status NOT IN ('REJECTED','RECEIVED','OCR_PENDING','OCR_DONE')
     GROUP BY 3, 4`,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "AnalyticsMsmeMonthly" WHERE tenant_id = ${tid}`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "AnalyticsMsmeMonthly"(id, tenant_id, month, breach_count, breach_exposure, refreshed_at)
     SELECT gen_random_uuid()::text, ${tid}, to_char(i."invoiceDate",'YYYY-MM'), COUNT(*),
            COALESCE(SUM(i."netAmount" * (6.5*3/100) * GREATEST(0,(CURRENT_DATE - i."msmeDueDate"::date))/365.0),0), now()
     FROM "Invoice" i JOIN "Vendor" v ON v.id = i.vendor_id AND v."isMsme"
     WHERE i.tenant_id = ${tid} AND i.status <> 'PAID' AND i."msmeDueDate" IS NOT NULL
       AND i."msmeDueDate"::date < CURRENT_DATE
     GROUP BY 3`,
  );
  for (const v of ['spend_monthly', 'vendor_monthly', 'msme_monthly']) {
    await prisma.analyticsRefreshLog.upsert({
      where: { tenantId_viewName: { tenantId, viewName: v } },
      create: {
        id: uid('arl'),
        tenantId,
        viewName: v,
        refreshedAt: now,
        trigger: 'SCHEDULED',
        status: 'OK',
      },
      update: { refreshedAt: now, trigger: 'SCHEDULED', status: 'OK' },
    });
  }

  // 3. Mill-liner RFQ → split award (idempotent by RFQ number).
  const RFQ_NUMBER = 'RFQ-8001';
  const existing = await prisma.rfq.findFirst({
    where: { tenantId, number: RFQ_NUMBER },
  });
  if (!existing) {
    const vTata = await prisma.vendor.findFirstOrThrow({
      where: { tenantId, code: 'V-TATA' },
    });
    const vBhilai = await prisma.vendor.findFirstOrThrow({
      where: { tenantId, code: 'V-BHILAI' },
    });
    const vConti = await prisma.vendor.findFirstOrThrow({
      where: { tenantId, code: 'V-CONTI' },
    });

    const rfqId = uid('rfq');
    const lineId = uid('rfql');
    await prisma.rfq.create({
      data: {
        id: rfqId,
        tenantId,
        number: RFQ_NUMBER,
        title: 'Mill liners & grinding media — Mill #3',
        category: 'Mechanical spares',
        rfqType: 'SINGLE_ENVELOPE',
        status: 'AWARDED',
        incotermDefault: 'DDP',
        deliveryLocation: { address: 'Lumshnong plant, Meghalaya', stateCode: '17' },
        paymentTermsDefault: JSON.stringify({ kind: 'NET_45' }),
        evaluationCriteria: { price: 100 },
        requiredDocuments: [],
        createdBy: harpreet.id,
        lines: {
          create: [
            {
              id: lineId,
              tenantId,
              lineNo: 1,
              itemDesc: 'Forged steel grinding balls 25mm',
              uom: 'tonne',
              qtyRequired: '24',
            },
          ],
        },
      },
    });

    // Three qualified quotes; TATA is the highest (baseline), BHILAI + CONTI awarded.
    const quote = async (vendorId: string, unit: string, total: string) => {
      const invId = uid('rfqi');
      await prisma.rfqInvitation.create({
        data: {
          id: invId,
          tenantId,
          rfqId,
          vendorId,
          invitedBy: harpreet.id,
          invitationSource: 'DIRECTORY',
          watermarkSeed: uid('wm'),
          status: 'QUOTE_SUBMITTED',
        },
      });
      const qId = uid('q');
      await prisma.quote.create({
        data: {
          id: qId,
          tenantId,
          rfqId,
          invitationId: invId,
          vendorId,
          envelopeType: 'COMBINED',
          incoterm: 'DDP',
          status: 'QUALIFIED',
          submittedAt: new Date('2026-06-20T10:00:00Z'),
          totalCommercialValue: total,
          lines: {
            create: [
              {
                id: uid('ql'),
                tenantId,
                rfqLineId: lineId,
                qtyQuoted: '24',
                unitPriceNative: unit,
                unitPriceInrLanded: unit,
                lineTotalNative: total,
                deliveryLeadDays: 21,
              },
            ],
          },
        },
      });
      return qId;
    };
    await quote(vTata.id, '142000', '3408000'); // baseline (highest), not awarded
    const qBhilai = await quote(vBhilai.id, '128500', '3084000');
    const qConti = await quote(vConti.id, '135000', '3240000');

    const awardId = uid('aw');
    await prisma.award.create({
      data: {
        id: awardId,
        tenantId,
        rfqId,
        recommendationBy: harpreet.id,
        recommendationNotes: 'Split award — lowest two qualified quotes.',
        totalValue: '3136000', // 128500*16 + 135000*8
        status: 'APPROVED',
        approvedAt: new Date('2026-06-25T10:00:00Z'),
        approvedBy: harpreet.id,
        allocations: {
          create: [
            {
              id: uid('awa'),
              tenantId,
              quoteId: qBhilai,
              vendorId: vBhilai.id,
              rfqLineId: lineId,
              qtyAllocated: '16',
              unitPrice: '128500',
              totalValue: '2056000',
            },
            {
              id: uid('awa'),
              tenantId,
              quoteId: qConti,
              vendorId: vConti.id,
              rfqLineId: lineId,
              qtyAllocated: '8',
              unitPrice: '135000',
              totalValue: '1080000',
            },
          ],
        },
      },
    });

    // Hard savings: baseline (142000) − awarded, per allocation × qty.
    const baseline = 142000;
    const savings = (baseline - 128500) * 16 + (baseline - 135000) * 8; // 216000 + 56000
    const baselineValue = baseline * 24; // 3,408,000
    const awardedValue = 128500 * 16 + 135000 * 8; // 3,136,000
    await prisma.savingsLedgerEntry.deleteMany({
      where: { tenantId, sourceType: 'RFQ_AWARD', sourceId: awardId },
    });
    await prisma.savingsLedgerEntry.create({
      data: {
        id: uid('sav'),
        tenantId,
        periodMonth: '2026-06',
        initiativeType: 'HARD_RFQ',
        sourceType: 'RFQ_AWARD',
        sourceId: awardId,
        category: 'Mechanical spares',
        baselineValue: String(baselineValue),
        awardedValue: String(awardedValue),
        savingsAmount: String(savings),
        savingsPct: ((savings / baselineValue) * 100).toFixed(4),
        buyerId: harpreet.id,
        status: 'CONFIRMED',
        notes: 'Mill-liner split award (RFQ-8001).',
        createdBy: harpreet.id,
      },
    });
    console.log(
      `  • Mill-liner award ${awardId} → hard savings ₹${savings.toLocaleString('en-IN')}`,
    );
  }

  console.log('Slice 8 seed complete:');
  console.log('  • TenantComplianceConfig (RBI 6.5% × 3, cost-of-capital 12%)');
  console.log('  • Summary tables populated from real invoice data');
  console.log(`  • Mill-liner RFQ ${RFQ_NUMBER} awarded + savings ledger backfilled`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
