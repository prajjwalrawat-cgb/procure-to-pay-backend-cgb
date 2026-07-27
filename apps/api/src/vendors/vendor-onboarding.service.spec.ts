import { categoryConfig } from '@procureflow/shared';
import { describe, expect, it, vi } from 'vitest';

import type { ApprovalRoutingService } from '../approvals/approval-routing.service';
import type { AuditLogService } from '../audit/audit.service';
import type { DomainEventService } from '../common/events/domain-event.service';
import type { NotificationService } from '../approvals/notification.service';
import type { PrismaService } from '../prisma/prisma.service';
import { VendorOnboardingService } from './vendor-onboarding.service';
import type { VendorScorecardService } from './vendor-scorecard.service';
import type { VendorVerificationService } from './vendor-verification.service';
import { VendorValidationError } from './vendor.errors';

const CATEGORY = 'PROFESSIONAL_SERVICES';
const REQUIRED_DOCS = categoryConfig(CATEGORY)?.requiredDocuments ?? [];

function completeSteps(
  steps: number[],
): Record<string, { done: boolean; data: Record<string, unknown> }> {
  const out: Record<string, { done: boolean; data: Record<string, unknown> }> = {};
  for (const s of steps) out[`step${s}`] = { done: true, data: {} };
  return out;
}

function makeService(
  vendor: Record<string, unknown>,
  wizardSteps: number[],
): VendorOnboardingService {
  const submit = vi.fn().mockResolvedValue(undefined);
  const prisma = {
    currentTenantId: 'ten_1',
    client: {
      user: { findUnique: vi.fn().mockResolvedValue({ email: 'v@example.com' }) },
      vendorContact: { findFirst: vi.fn().mockResolvedValue({ vendorId: 'ven_1' }) },
      vendorOnboarding: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'vob_1',
          vendorId: 'ven_1',
          categoryConfigKey: CATEGORY,
          slaTargetHours: 48,
          wizardState: {
            currentStep: 6,
            completionPct: 100,
            steps: completeSteps(wizardSteps),
          },
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      vendor: { findUniqueOrThrow: vi.fn().mockResolvedValue(vendor) },
    },
  } as unknown as PrismaService;

  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuditLogService;
  const events = {
    emit: vi.fn().mockResolvedValue(undefined),
  } as unknown as DomainEventService;
  const notifications = {
    notify: vi.fn().mockResolvedValue(undefined),
  } as unknown as NotificationService;
  const routing = { submit, onApproved: vi.fn() } as unknown as ApprovalRoutingService;
  const verification = {} as unknown as VendorVerificationService;
  const scorecard = {} as unknown as VendorScorecardService;
  const mail = { send: vi.fn().mockResolvedValue(undefined) } as never;
  const storage = {
    presignedGetUrl: vi.fn().mockResolvedValue('https://signed.example/doc'),
    put: vi.fn().mockResolvedValue(''),
  } as never;
  const config = { get: vi.fn().mockReturnValue('http://localhost:3000') } as never;
  const pennyDrop = {
    verify: vi.fn().mockResolvedValue({ registeredName: 'x', matchScore: 1 }),
  } as never;
  const captcha = {
    verify: vi.fn(async (t: string) => ({
      ok: Boolean(t),
      reason: t ? undefined : 'Captcha required.',
    })),
  } as never;
  return new VendorOnboardingService(
    prisma,
    audit,
    events,
    notifications,
    routing,
    verification,
    scorecard,
    mail,
    storage,
    config,
    pennyDrop,
    captcha,
  );
}

describe('VendorOnboardingService.submitOnboarding guards', () => {
  const fullDocs = REQUIRED_DOCS.map((d) => ({ docType: d }));

  it('rejects when a required wizard step is incomplete', async () => {
    const svc = makeService(
      {
        id: 'ven_1',
        tenantId: 'ten_1',
        isMsme: false,
        cocAcknowledgedAt: new Date(),
        dataProcessingConsentAt: new Date(),
        documents: fullDocs,
      },
      [1, 2, 3, 5], // step 6 missing
    );
    await expect(svc.submitOnboarding('usr_v')).rejects.toBeInstanceOf(
      VendorValidationError,
    );
  });

  it('rejects when mandatory documents are missing', async () => {
    const svc = makeService(
      {
        id: 'ven_1',
        tenantId: 'ten_1',
        isMsme: false,
        cocAcknowledgedAt: new Date(),
        dataProcessingConsentAt: new Date(),
        documents: [],
      },
      [1, 2, 3, 5, 6],
    );
    await expect(svc.submitOnboarding('usr_v')).rejects.toBeInstanceOf(
      VendorValidationError,
    );
  });

  it('rejects when the code of conduct is not acknowledged', async () => {
    const svc = makeService(
      {
        id: 'ven_1',
        tenantId: 'ten_1',
        isMsme: false,
        cocAcknowledgedAt: null,
        dataProcessingConsentAt: new Date(),
        documents: fullDocs,
      },
      [1, 2, 3, 5, 6],
    );
    await expect(svc.submitOnboarding('usr_v')).rejects.toBeInstanceOf(
      VendorValidationError,
    );
  });

  it('routes through the approval engine when all guards pass', async () => {
    const svc = makeService(
      {
        id: 'ven_1',
        tenantId: 'ten_1',
        isMsme: false,
        cocAcknowledgedAt: new Date(),
        dataProcessingConsentAt: new Date(),
        documents: fullDocs,
      },
      [1, 2, 3, 5, 6],
    );
    await expect(svc.submitOnboarding('usr_v')).resolves.toEqual({ ok: true });
  });
});

describe('VendorOnboardingService.startSelfRegistration — tenant scoping', () => {
  function makeSvc(tenant: unknown): VendorOnboardingService {
    const prisma = {
      currentTenantId: null,
      tenant: { findUnique: vi.fn().mockResolvedValue(tenant) },
    } as unknown as PrismaService;
    const noop = {
      record: vi.fn(),
      emit: vi.fn(),
      notify: vi.fn(),
      onApproved: vi.fn(),
    } as never;
    const captcha = {
      verify: vi.fn(async (t: string) => ({
        ok: Boolean(t),
        reason: t ? undefined : 'Captcha required.',
      })),
    } as never;
    return new VendorOnboardingService(
      prisma,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop, // mail
      noop, // storage
      noop, // config
      noop, // pennyDrop
      captcha,
    );
  }

  const input = {
    tenantId: '00000000-0000-0000-0000-000000000000',
    legalEntityName: 'Acme Pumps',
    email: 'ap@example.com',
    phone: '9999999999',
    categoryKey: CATEGORY,
    captchaResponse: 'demo-captcha',
  } as never;

  it('rejects a registration whose tenantId matches no tenant (never a defaulted tenant)', async () => {
    const svc = makeSvc(null); // tenant.findUnique → null
    await expect(svc.startSelfRegistration(input)).rejects.toBeInstanceOf(
      VendorValidationError,
    );
  });

  it('rejects when the captcha is missing (before any tenant write)', async () => {
    const svc = makeSvc({ id: 'ten_x' });
    await expect(
      svc.startSelfRegistration({ ...input, captchaResponse: '' }),
    ).rejects.toBeInstanceOf(VendorValidationError);
  });
});
