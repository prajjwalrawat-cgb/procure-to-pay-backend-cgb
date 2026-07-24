/**
 * Slice 10a seed — document & compliance integrations.
 *  1. Vendor email domains (inbound-email sender validation).
 *  2. One encrypted GSP credential (proves encryption-at-rest — the raw DB value
 *     is ciphertext, never plaintext).
 *  3. Two quarantined inbound emails (one PENDING_VENDOR_MATCH, one DEAD_LETTER)
 *     so the AP intake queues have data without POSTing the webhook.
 * Idempotent.
 */
import { createCipheriv, createHash, randomBytes } from 'node:crypto';

import { PrismaClient } from '@prisma/client';

import { newId } from '../src/ids';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? '' },
  },
});

const TENANT_NAME = 'Star Cement Ltd';

/** Mirrors apps/api CryptoService (AES-256-GCM, SHA-256-derived key). */
function encryptJson(obj: Record<string, string>): string {
  const raw =
    process.env.INTEGRATION_ENC_KEY ?? 'dev-only-integration-key-change-me-32b!';
  const key = createHash('sha256').update(raw).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

async function main(): Promise<void> {
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { name: TENANT_NAME } });
  const tenantId = tenant.id;

  // 1. Vendor email domains for inbound-email sender validation.
  const domains: Record<string, string[]> = {
    'V-PATEL': ['patel-eng.example'],
    'V-CONTI': ['continental-belt.example'],
    'V-JKPAP': ['jkpaper.example'],
    'V-RAJGY': ['rajgypsum.example'],
  };
  for (const [code, list] of Object.entries(domains)) {
    const v = await prisma.vendor.findFirst({ where: { tenantId, code } });
    if (v)
      await prisma.vendor.update({ where: { id: v.id }, data: { emailDomains: list } });
  }

  // 2. Encrypted GSP credential (sandbox account). Raw column is ciphertext.
  const existing = await prisma.tenantIntegrationCredential.findFirst({
    where: { tenantId, provider: 'GSP' },
  });
  if (!existing) {
    await prisma.tenantIntegrationCredential.create({
      data: {
        id: newId('tenantIntegrationCredential'),
        tenantId,
        provider: 'GSP',
        label: 'Star Cement GSP (sandbox)',
        ciphertext: encryptJson({
          clientId: 'gsp-sandbox-client',
          clientSecret: 'gsp-sandbox-secret',
        }),
      },
    });
  }

  // 3. Two quarantined inbound emails for the AP intake queues.
  const seedInbound = async (
    fromEmail: string,
    subject: string,
    status: 'PENDING_VENDOR_MATCH' | 'DEAD_LETTER',
    deadLetterReason?: string,
  ): Promise<void> => {
    const dup = await prisma.inboundEmail.findFirst({
      where: { tenantId, fromEmail, subject },
    });
    if (dup) return;
    await prisma.inboundEmail.create({
      data: {
        id: newId('inboundEmail'),
        tenantId,
        fromEmail,
        fromDomain: fromEmail.split('@')[1] ?? '',
        subject,
        status,
        deadLetterReason: deadLetterReason ?? null,
        attachmentName: status === 'PENDING_VENDOR_MATCH' ? 'invoice.pdf' : null,
      },
    });
  };
  await seedInbound(
    'accounts@unknown-supplier.example',
    'Invoice INV-99213',
    'PENDING_VENDOR_MATCH',
  );
  await seedInbound(
    'noreply@spam.example',
    '(no attachment)',
    'DEAD_LETTER',
    'NO_ATTACHMENT',
  );

  console.log('Slice 10a seed complete — email domains, GSP credential, intake queues.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
