import { describe, expect, it, vi } from 'vitest';

import type { ApprovalRoutingService } from '../approvals/approval-routing.service';
import type { NotificationService } from '../approvals/notification.service';
import type { AuditLogService } from '../audit/audit.service';
import type { DomainEventService } from '../common/events/domain-event.service';
import type { MailService } from '../common/mail/mail.service';
import type { StorageService } from '../common/storage/storage.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ICaptchaProvider } from './verification/captcha.provider';
import type { IPennyDropProvider } from './verification/penny-drop.provider';
import type { VendorKycService } from './vendor-kyc.service';
import type { VendorScorecardService } from './vendor-scorecard.service';
import type { VendorVerificationService } from './vendor-verification.service';
import { VendorOnboardingService } from './vendor-onboarding.service';
import { VendorValidationError } from './vendor.errors';

const GSTIN = '27AAPFU0939F1ZV';
const PAN = 'AAPFU0939F';

const STEP1 = {
  legalEntityType: 'PARTNERSHIP' as const,
  legalEntityName: 'Umang Fabricators',
  businessPan: PAN,
  addressLine1: '14 Industrial Estate',
  city: 'Mumbai',
  stateCode: '27',
  pincode: '400069',
  primaryContactName: 'R. Shah',
  primaryContactEmail: 'ops@umang.example',
  primaryContactPhone: '9820000000',
};

interface Fixture {
  wizardState?: Record<string, unknown>;
  vendor?: Record<string, unknown>;
  documents?: { docType: string }[];
  onboarding?: Record<string, unknown>;
  /** The vendor's bank row, or null for a vendor who has not reached step 3. */
  bank?: Record<string, unknown> | null;
}

/** Step 1 cannot be saved without these, so they are the fixture default. */
const STATUTORY_DOCS = [{ docType: 'GST_CERT' }, { docType: 'PAN_CARD' }];
const ALL_MANDATORY_DOCS = [
  ...STATUTORY_DOCS,
  { docType: 'CANCELLED_CHEQUE' },
  { docType: 'AUDITED_FINANCIALS' },
];

function makeService(fixture: Fixture = {}) {
  const onboardingUpdate = vi.fn().mockResolvedValue({});
  const vendorUpdate = vi.fn().mockResolvedValue({});
  const runScreening = vi.fn().mockResolvedValue({ id: 's1', status: 'CLEAR' });
  const vendor = {
    id: 'ven_1',
    tenantId: 'ten_1',
    name: 'Umang',
    lifecycleStatus: 'IN_ONBOARDING',
    gstin: null,
    businessPan: null,
    pan: null,
    isMsme: false,
    dataProcessingConsentAt: new Date(),
    documents: fixture.documents ?? STATUTORY_DOCS,
    screenings: [],
    ...fixture.vendor,
  };
  const bank =
    fixture.bank === undefined
      ? null
      : fixture.bank === null
        ? null
        : {
            id: 'vbk_1',
            bankName: 'HDFC Bank',
            accountNoEncrypted: 'enc:xxxx6789',
            ifsc: 'HDFC0001234',
            holderName: 'Umang Fabricators',
            isVerified: true,
            pennyDropNameReturned: null,
            nameMatchScore: null,
            manualOverrideReason: null,
            ...fixture.bank,
          };
  const prisma = {
    currentTenantId: 'ten_1',
    client: {
      user: {
        findUnique: vi.fn().mockResolvedValue({ email: 'ops@umang.example' }),
      },
      vendorContact: { findFirst: vi.fn().mockResolvedValue({ vendorId: 'ven_1' }) },
      vendor: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(vendor),
        update: vendorUpdate,
      },
      vendorOnboarding: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'onb_1',
          vendorId: 'ven_1',
          submittedAt: null,
          reviewDecision: null,
          categoryConfigKey: 'RAW_MATERIALS',
          slaTargetHours: 120,
          wizardState: fixture.wizardState ?? {
            currentStep: 1,
            completionPct: 0,
            steps: {},
          },
          ...fixture.onboarding,
        }),
        update: onboardingUpdate,
      },
      vendorDocument: {
        findMany: vi.fn().mockResolvedValue(fixture.documents ?? STATUTORY_DOCS),
      },
      vendorBank: {
        deleteMany: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
        findFirst: vi.fn().mockResolvedValue(bank),
      },
    },
  } as unknown as PrismaService;

  const svc = new VendorOnboardingService(
    prisma,
    { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLogService,
    { emit: vi.fn().mockResolvedValue(undefined) } as unknown as DomainEventService,
    { notify: vi.fn() } as unknown as NotificationService,
    { onApproved: vi.fn(), submit: vi.fn() } as unknown as ApprovalRoutingService,
    { runScreening } as unknown as VendorVerificationService,
    { computeScorecard: vi.fn() } as unknown as VendorScorecardService,
    {} as unknown as VendorKycService,
    { send: vi.fn() } as unknown as MailService,
    {} as unknown as StorageService,
    { get: vi.fn().mockReturnValue('http://localhost:3000') } as never,
    {} as unknown as IPennyDropProvider,
    {} as unknown as ICaptchaProvider,
  );
  return { svc, onboardingUpdate, vendorUpdate, runScreening };
}

/** The wizard state the update call was given. */
function savedState(update: ReturnType<typeof vi.fn>): {
  completionPct: number;
  currentStep: number;
} {
  return update.mock.calls.at(-1)![0].data.wizardState;
}

describe('saveStep — four-step wizard', () => {
  it('reports completion out of four steps', async () => {
    const { svc, onboardingUpdate } = makeService();
    await svc.saveStep('usr_1', 1, STEP1);
    expect(savedState(onboardingUpdate).completionPct).toBe(25);
  });

  it('does not run past the last step', async () => {
    const { svc, onboardingUpdate } = makeService({
      documents: ALL_MANDATORY_DOCS,
    });
    await svc.saveStep('usr_1', 4, { documentsConfirmed: true });
    expect(savedState(onboardingUpdate).currentStep).toBe(4);
  });

  it('never reports over 100% for a wizard begun under the old six steps', async () => {
    const { svc, onboardingUpdate } = makeService({
      wizardState: {
        currentStep: 6,
        completionPct: 83,
        steps: {
          step1: { done: true, data: {} },
          step2: { done: true, data: {} },
          step3: { done: true, data: {} },
          step5: { done: true, data: {} },
          step6: { done: true, data: {} },
        },
      },
    });
    await svc.saveStep('usr_1', 1, STEP1);
    expect(savedState(onboardingUpdate).completionPct).toBe(75);
  });
});

describe('saveStep — step 4 requires its documents', () => {
  it('refuses to mark the step done while a mandatory document is missing', async () => {
    const { svc } = makeService({
      documents: [{ docType: 'GST_CERT' }, { docType: 'PAN_CARD' }],
    });
    await expect(
      svc.saveStep('usr_1', 4, { documentsConfirmed: true }),
    ).rejects.toBeInstanceOf(VendorValidationError);
  });

  it('names the documents the vendor still has to upload', async () => {
    const { svc } = makeService({ documents: [{ docType: 'CANCELLED_CHEQUE' }] });
    await expect(svc.saveStep('usr_1', 4, { documentsConfirmed: true })).rejects.toThrow(
      /audited financials/i,
    );
  });

  it('accepts the step once both are on file', async () => {
    const { svc, onboardingUpdate } = makeService({
      documents: ALL_MANDATORY_DOCS,
    });
    await expect(svc.saveStep('usr_1', 4, { documentsConfirmed: true })).resolves.toEqual(
      { ok: true },
    );
    expect(onboardingUpdate).toHaveBeenCalled();
  });
});

describe('saveStep — a verified value cannot be typed over', () => {
  const extracted = {
    businessPan: { value: PAN, source: 'DERIVED', verified: true, confidence: 1 },
    legalEntityName: {
      value: 'Umang Fabricators',
      source: 'OCR',
      verified: false,
      confidence: 0.75,
    },
  };
  const wizardState = { currentStep: 1, completionPct: 0, steps: {}, extracted };

  it('rejects an edit to a field the registry confirmed', async () => {
    const { svc } = makeService({ wizardState });
    await expect(
      svc.saveStep('usr_1', 1, { ...STEP1, businessPan: 'AFMFS3755D' }),
    ).rejects.toThrow(/cannot be changed here/);
  });

  it('lets the vendor correct a value that was only read off the page', async () => {
    const { svc, vendorUpdate } = makeService({ wizardState });
    await svc.saveStep('usr_1', 1, {
      ...STEP1,
      legalEntityName: 'Umang Fabricators LLP',
    });
    expect(vendorUpdate.mock.calls[0]![0].data.legalEntityName).toBe(
      'Umang Fabricators LLP',
    );
  });
});

describe('saveStep — PAN and GSTIN must describe one entity', () => {
  it('rejects a PAN that disagrees with the GSTIN on file', async () => {
    const { svc } = makeService({ vendor: { gstin: GSTIN } });
    await expect(
      svc.saveStep('usr_1', 1, { ...STEP1, businessPan: 'AFMFS3755D' }),
    ).rejects.toThrow(/does not match the GSTIN/);
  });

  it('rejects a GSTIN that disagrees with the PAN on file', async () => {
    const { svc } = makeService({ vendor: { businessPan: 'AFMFS3755D' } });
    await expect(
      svc.saveStep('usr_1', 2, { gstin: GSTIN, isMsme: false, udyamNumber: null }),
    ).rejects.toThrow(/does not match the GSTIN/);
  });

  it('accepts the pair when they agree', async () => {
    const { svc } = makeService({ vendor: { gstin: GSTIN } });
    await expect(svc.saveStep('usr_1', 1, STEP1)).resolves.toEqual({ ok: true });
  });
});

describe('submitOnboarding', () => {
  const complete = {
    currentStep: 4,
    completionPct: 100,
    steps: {
      step1: { done: true, data: {} },
      step2: { done: true, data: {} },
      step3: { done: true, data: {} },
      step4: { done: true, data: {} },
    },
  };
  const allDocs = ALL_MANDATORY_DOCS;

  it('runs sanctions screening, which used to hang off the deleted UBO step', async () => {
    const { svc, runScreening } = makeService({
      wizardState: complete,
      documents: allDocs,
      vendor: { gstin: GSTIN, businessPan: PAN },
    });
    await svc.submitOnboarding('usr_1');
    expect(runScreening).toHaveBeenCalledWith('ven_1', 'SANCTIONS_OFAC', 'system');
  });

  it('does not ask for the category-specific certificates that used to block it', async () => {
    // RAW_MATERIALS lists a pollution NOC and a factory licence; neither is on file.
    const { svc } = makeService({
      wizardState: complete,
      documents: allDocs,
      vendor: { gstin: GSTIN, businessPan: PAN },
    });
    await expect(svc.submitOnboarding('usr_1')).resolves.toEqual({ ok: true });
  });

  it('still blocks on a missing mandatory document', async () => {
    const { svc } = makeService({
      wizardState: complete,
      documents: [{ docType: 'GST_CERT' }, { docType: 'PAN_CARD' }],
      vendor: { gstin: GSTIN, businessPan: PAN },
    });
    await expect(svc.submitOnboarding('usr_1')).rejects.toThrow(/cancelled cheque/);
  });

  it('names the incomplete step rather than a bare number', async () => {
    const { svc } = makeService({
      wizardState: {
        currentStep: 4,
        completionPct: 75,
        steps: {
          step1: { done: true, data: {} },
          step2: { done: true, data: {} },
          step3: { done: true, data: {} },
        },
      },
      documents: allDocs,
    });
    await expect(svc.submitOnboarding('usr_1')).rejects.toThrow(/Step 4 \(Documents\)/);
  });
});

describe('saveStep — step 1 asks for the documents first', () => {
  it('refuses to accept typed details while the statutory documents are missing', async () => {
    const { svc } = makeService({ documents: [] });
    await expect(svc.saveStep('usr_1', 1, STEP1)).rejects.toThrow(
      /Upload your GST registration certificate and PAN card first/,
    );
  });

  it('names only what is actually outstanding', async () => {
    const { svc } = makeService({ documents: [{ docType: 'GST_CERT' }] });
    await expect(svc.saveStep('usr_1', 1, STEP1)).rejects.toThrow(/Upload your PAN card/);
  });

  it('has no way round it — the same documents gate submission anyway', async () => {
    const { svc } = makeService({
      documents: [{ docType: 'CANCELLED_CHEQUE' }, { docType: 'AUDITED_FINANCIALS' }],
      wizardState: {
        currentStep: 4,
        completionPct: 100,
        steps: {
          step1: { done: true, data: {} },
          step2: { done: true, data: {} },
          step3: { done: true, data: {} },
          step4: { done: true, data: {} },
        },
      },
      vendor: { gstin: GSTIN, businessPan: PAN },
    });
    await expect(svc.submitOnboarding('usr_1')).rejects.toThrow(
      /GST registration certificate/,
    );
  });
});

describe('activateVendor — the second door into ACTIVE', () => {
  const submitted = {
    currentStep: 4,
    completionPct: 100,
    steps: {
      step1: { done: true, data: {} },
      step2: { done: true, data: {} },
      step3: { done: true, data: {} },
      step4: { done: true, data: {} },
    },
  };

  it('refuses a vendor who never submitted — the 0%-complete approve', async () => {
    const { svc } = makeService({
      wizardState: { currentStep: 1, completionPct: 0, steps: {} },
      documents: [],
    });
    await expect(svc.activateVendor('ven_1', 'usr_officer')).rejects.toThrow(
      /has not submitted their onboarding yet \(0% complete\)/,
    );
  });

  it('refuses when a mandatory document is missing', async () => {
    const { svc } = makeService({
      wizardState: submitted,
      documents: STATUTORY_DOCS,
      onboarding: { submittedAt: new Date() },
    });
    await expect(svc.activateVendor('ven_1', 'usr_officer')).rejects.toThrow(
      /missing cancelled cheque, audited financials/,
    );
  });

  it('refuses while the bank could not confirm the account holder', async () => {
    const { svc } = makeService({
      wizardState: submitted,
      documents: ALL_MANDATORY_DOCS,
      onboarding: { submittedAt: new Date() },
      bank: {
        isVerified: false,
        holderName: 'Umang Fabricators',
        pennyDropNameReturned: 'MISMATCHED ACCOUNT HOLDER',
        manualOverrideReason: null,
      },
    });
    await expect(svc.activateVendor('ven_1', 'usr_officer')).rejects.toThrow(
      /MISMATCHED ACCOUNT HOLDER/,
    );
  });

  it('lets it through once a buyer has accepted the account in writing', async () => {
    const { svc } = makeService({
      wizardState: submitted,
      documents: ALL_MANDATORY_DOCS,
      onboarding: { submittedAt: new Date() },
      bank: {
        isVerified: false,
        holderName: 'Umang Fabricators',
        pennyDropNameReturned: 'MISMATCHED ACCOUNT HOLDER',
        manualOverrideReason: 'Cheque checked against the account — same entity',
      },
    });
    await expect(svc.activateVendor('ven_1', 'usr_officer')).resolves.toEqual({
      ok: true,
    });
  });
});
