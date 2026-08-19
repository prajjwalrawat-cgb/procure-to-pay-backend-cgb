import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { ApprovalRoutingService } from '../approvals/approval-routing.service';
import type { NotificationService } from '../approvals/notification.service';
import type { AuditLogService } from '../audit/audit.service';
import type { MailService } from '../common/mail/mail.service';
import type { DomainEventService } from '../common/events/domain-event.service';
import type { StorageService } from '../common/storage/storage.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { VendorKycService } from './vendor-kyc.service';
import type { VendorScorecardService } from './vendor-scorecard.service';
import type { VendorVerificationService } from './vendor-verification.service';
import type { ICaptchaProvider } from './verification/captcha.provider';
import type { IPennyDropProvider } from './verification/penny-drop.provider';
import { DuplicateVendorError, VendorStateError } from './vendor.errors';
import {
  VendorOnboardingService,
  isOnboardingEditable,
} from './vendor-onboarding.service';

interface VendorRow {
  id: string;
  code: string;
  name: string;
  legalEntityName: string | null;
  lifecycleStatus: string;
}

interface OnboardingRow {
  id: string;
  vendorId: string;
  submittedAt: Date | null;
  reviewDecision: string | null;
  /** Set when the vendor used the invitation link to set a password. */
  emailVerifiedAt: Date | null;
  vendor: { id: string; name: string; lifecycleStatus: string };
}

interface Fixture {
  /** Vendors reachable by the contact-email lookup, i.e. same email. */
  contactMatches?: VendorRow[];
  /** Live vendors the name-similarity sweep will see. */
  nameCandidates?: VendorRow[];
  onboarding?: OnboardingRow | null;
  /** The vendor row renameVendor will load. */
  vendorRecord?: {
    id: string;
    name: string;
    legalEntityName: string | null;
    activatedAt: Date | null;
    lifecycleStatus: string;
  } | null;
  /** Other contacts sharing the cancelled vendor's email, on live vendors. */
  sharedContactCount?: number;
  userRoles?: string[];
}

function makeService(fixture: Fixture = {}): {
  svc: VendorOnboardingService;
  vendorUpdate: ReturnType<typeof vi.fn>;
  vendorCreate: ReturnType<typeof vi.fn>;
  onboardingUpdate: ReturnType<typeof vi.fn>;
  userUpdate: ReturnType<typeof vi.fn>;
  audit: ReturnType<typeof vi.fn>;
} {
  const vendorCreate = vi.fn().mockResolvedValue({});
  const vendorUpdate = vi.fn().mockResolvedValue({});
  const onboardingUpdate = vi.fn().mockResolvedValue({});
  const userUpdate = vi.fn().mockResolvedValue({});
  const auditRecord = vi.fn().mockResolvedValue(undefined);
  const prisma = {
    currentTenantId: 'ten_1',
    client: {
      vendorContact: {
        findMany: vi
          .fn()
          .mockResolvedValue((fixture.contactMatches ?? []).map((v) => ({ vendor: v }))),
        findFirst: vi.fn().mockResolvedValue({ email: 'ops@vendor.example' }),
        count: vi.fn().mockResolvedValue(fixture.sharedContactCount ?? 0),
        create: vi.fn().mockResolvedValue({}),
      },
      vendor: {
        findMany: vi.fn().mockResolvedValue(fixture.nameCandidates ?? []),
        create: vendorCreate,
        update: vendorUpdate,
        // renameVendor asks for the record; createOnboarding asks for the
        // category — both land here, so serve whichever the fixture implies.
        findUnique: vi
          .fn()
          .mockResolvedValue(
            fixture.vendorRecord ?? { categoryConfigKey: 'RAW_MATERIALS' },
          ),
      },
      vendorOnboarding: {
        findUnique: vi.fn().mockResolvedValue(fixture.onboarding ?? null),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
        update: onboardingUpdate,
      },
      user: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue({
          id: 'usr_vendor',
          userRoles: (fixture.userRoles ?? ['VENDOR_USER']).map((name) => ({
            role: { name },
          })),
        }),
        create: vi.fn().mockResolvedValue({ id: 'usr_vendor' }),
        update: userUpdate,
      },
      userRole: { create: vi.fn().mockResolvedValue({}) },
      role: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'rol_vendor' }) },
      tenant: { findUnique: vi.fn().mockResolvedValue({ name: 'Artbox' }) },
    },
  } as unknown as PrismaService;

  const svc = new VendorOnboardingService(
    prisma,
    { record: auditRecord } as unknown as AuditLogService,
    { emit: vi.fn().mockResolvedValue(undefined) } as unknown as DomainEventService,
    { notify: vi.fn() } as unknown as NotificationService,
    { onApproved: vi.fn(), submit: vi.fn() } as unknown as ApprovalRoutingService,
    {} as unknown as VendorVerificationService,
    {} as unknown as VendorScorecardService,
    {} as unknown as VendorKycService,
    { send: vi.fn().mockResolvedValue(undefined) } as unknown as MailService,
    {} as unknown as StorageService,
    { get: vi.fn().mockReturnValue('http://localhost:3000') } as never,
    {} as unknown as IPennyDropProvider,
    {} as unknown as ICaptchaProvider,
  );
  return {
    svc,
    vendorCreate,
    vendorUpdate,
    onboardingUpdate,
    userUpdate,
    audit: auditRecord,
  };
}

const INVITE = {
  legalEntityName: 'Lohith Enterprises Pvt Ltd',
  name: 'Lohith',
  email: 'lohith@example.com',
  categoryKey: 'RAW_MATERIALS',
  source: 'BUYER_INVITE_SPOT' as const,
  allowDuplicate: false,
};

const LIVE_VENDOR: VendorRow = {
  id: 'ven_1',
  code: 'VN-ABC123',
  name: 'Lohith',
  legalEntityName: 'Lohith Enterprises Pvt Ltd',
  lifecycleStatus: 'INVITED',
};

describe('VendorOnboardingService.inviteVendor duplicate guard', () => {
  it('blocks a second invite to an email already on a live vendor', async () => {
    const { svc, vendorCreate } = makeService({ contactMatches: [LIVE_VENDOR] });
    await expect(svc.inviteVendor(INVITE, 'usr_officer')).rejects.toBeInstanceOf(
      DuplicateVendorError,
    );
    expect(vendorCreate).not.toHaveBeenCalled();
  });

  it('does not let allowDuplicate override an email collision', async () => {
    // Both records would share one vendor login, so this override never applies.
    const { svc } = makeService({ contactMatches: [LIVE_VENDOR] });
    await expect(
      svc.inviteVendor({ ...INVITE, allowDuplicate: true }, 'usr_officer'),
    ).rejects.toBeInstanceOf(DuplicateVendorError);
  });

  it('allows re-inviting an archived vendor on the same email', async () => {
    const { svc, vendorCreate } = makeService({
      contactMatches: [{ ...LIVE_VENDOR, lifecycleStatus: 'ARCHIVED' }],
    });
    await expect(svc.inviteVendor(INVITE, 'usr_officer')).resolves.toMatchObject({
      vendorId: expect.any(String),
    });
    expect(vendorCreate).toHaveBeenCalledOnce();
  });

  it('blocks a near-identical legal name on a different email', async () => {
    const { svc } = makeService({ nameCandidates: [LIVE_VENDOR] });
    await expect(
      svc.inviteVendor({ ...INVITE, email: 'accounts@example.com' }, 'usr_officer'),
    ).rejects.toBeInstanceOf(DuplicateVendorError);
  });

  it('lets the officer confirm a name match with allowDuplicate', async () => {
    const { svc, vendorCreate } = makeService({ nameCandidates: [LIVE_VENDOR] });
    await svc.inviteVendor(
      { ...INVITE, email: 'accounts@example.com', allowDuplicate: true },
      'usr_officer',
    );
    expect(vendorCreate).toHaveBeenCalledOnce();
  });

  it('leaves an unrelated vendor alone', async () => {
    const { svc, vendorCreate } = makeService({
      nameCandidates: [
        {
          id: 'ven_2',
          code: 'VN-ZZZ999',
          name: 'Sabitha Chemicals',
          legalEntityName: 'Sabitha Chemicals LLP',
          lifecycleStatus: 'ACTIVE',
        },
      ],
    });
    await svc.inviteVendor(INVITE, 'usr_officer');
    expect(vendorCreate).toHaveBeenCalledOnce();
  });
});

/** Invited, never opened the link — an officer can clear this up alone. */
const OPEN_ONBOARDING: OnboardingRow = {
  id: 'vob_1',
  vendorId: 'ven_1',
  submittedAt: null,
  reviewDecision: null,
  emailVerifiedAt: null,
  vendor: { id: 'ven_1', name: 'Lohith', lifecycleStatus: 'INVITED' },
};

/** Password already set — now a working login, so this is a revocation. */
const ACCEPTED_ONBOARDING: OnboardingRow = {
  ...OPEN_ONBOARDING,
  emailVerifiedAt: new Date('2026-08-11T09:58:46Z'),
};

const OFFICER = false;
const ADMIN = true;

describe('VendorOnboardingService.cancelOnboarding', () => {
  it('archives the vendor and burns the invitation link', async () => {
    const { svc, onboardingUpdate, audit } = makeService({
      onboarding: OPEN_ONBOARDING,
    });
    await expect(
      svc.cancelOnboarding('vob_1', { reason: 'Duplicate invite' }, 'usr_officer', OFFICER),
    ).resolves.toEqual({ ok: true });
    expect(onboardingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reviewDecision: 'CANCELLED',
          selfRegistrationToken: null,
          slaBreachAt: null,
          vendor: { update: { lifecycleStatus: 'ARCHIVED' } },
        }),
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ONBOARDING_CANCELLED' }),
    );
  });

  it('deactivates the vendor login once nothing else uses it', async () => {
    const { svc, userUpdate } = makeService({
      onboarding: OPEN_ONBOARDING,
      sharedContactCount: 0,
    });
    await svc.cancelOnboarding('vob_1', { reason: 'Duplicate' }, 'usr_officer', OFFICER);
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isActive: false } }),
    );
  });

  it('keeps the login active when the vendor’s real record shares it', async () => {
    // The exact case this feature exists for: the duplicate is cancelled, the
    // record the vendor actually accepted must stay usable.
    const { svc, userUpdate } = makeService({
      onboarding: OPEN_ONBOARDING,
      sharedContactCount: 1,
    });
    await svc.cancelOnboarding('vob_1', { reason: 'Duplicate' }, 'usr_officer', OFFICER);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('never disables a login that is also a staff account', async () => {
    const { svc, userUpdate } = makeService({
      onboarding: OPEN_ONBOARDING,
      userRoles: ['VENDOR_USER', 'BUYER_ADMIN'],
    });
    await svc.cancelOnboarding('vob_1', { reason: 'Duplicate' }, 'usr_officer', OFFICER);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('lets an officer cancel an invite the vendor never accepted', async () => {
    const { svc } = makeService({ onboarding: OPEN_ONBOARDING });
    await expect(
      svc.cancelOnboarding('vob_1', { reason: 'Wrong vendor' }, 'usr_officer', OFFICER),
    ).resolves.toEqual({ ok: true });
  });

  it('stops an officer revoking a vendor who has already set a password', async () => {
    const { svc, onboardingUpdate } = makeService({ onboarding: ACCEPTED_ONBOARDING });
    await expect(
      svc.cancelOnboarding('vob_1', { reason: 'Duplicate' }, 'usr_officer', OFFICER),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(onboardingUpdate).not.toHaveBeenCalled();
  });

  it('lets an admin revoke a vendor who has already set a password', async () => {
    const { svc, onboardingUpdate } = makeService({ onboarding: ACCEPTED_ONBOARDING });
    await expect(
      svc.cancelOnboarding('vob_1', { reason: 'Duplicate' }, 'usr_admin', ADMIN),
    ).resolves.toEqual({ ok: true });
    expect(onboardingUpdate).toHaveBeenCalledOnce();
  });

  it('refuses to cancel a submitted application', async () => {
    const { svc } = makeService({
      onboarding: { ...OPEN_ONBOARDING, submittedAt: new Date('2026-08-01') },
    });
    await expect(
      svc.cancelOnboarding('vob_1', { reason: 'Oops' }, 'usr_officer', OFFICER),
    ).rejects.toBeInstanceOf(VendorStateError);
  });

  it('refuses to cancel twice', async () => {
    const { svc } = makeService({
      onboarding: { ...OPEN_ONBOARDING, reviewDecision: 'CANCELLED' },
    });
    await expect(
      svc.cancelOnboarding('vob_1', { reason: 'Again' }, 'usr_officer', OFFICER),
    ).rejects.toBeInstanceOf(VendorStateError);
  });
});

const ONBOARDING_VENDOR = {
  id: 'ven_1',
  name: 'Lohith',
  legalEntityName: 'Lohith',
  activatedAt: null,
  lifecycleStatus: 'INVITED',
};

describe('VendorOnboardingService.renameVendor', () => {
  it('corrects both names while the vendor is still onboarding', async () => {
    const { svc, vendorUpdate, audit } = makeService({ vendorRecord: ONBOARDING_VENDOR });
    await expect(
      svc.renameVendor(
        'ven_1',
        { name: 'Lohith Material', legalEntityName: 'Lohith Material Pvt Ltd' },
        'usr_officer',
      ),
    ).resolves.toEqual({ ok: true });
    expect(vendorUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { name: 'Lohith Material', legalEntityName: 'Lohith Material Pvt Ltd' },
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'VENDOR_RENAMED',
        before: { name: 'Lohith', legalEntityName: 'Lohith' },
      }),
    );
  });

  it('leaves the legal name untouched when only the display name is sent', async () => {
    const { svc, vendorUpdate } = makeService({ vendorRecord: ONBOARDING_VENDOR });
    await svc.renameVendor('ven_1', { name: 'Lohith Material' }, 'usr_officer');
    expect(vendorUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: 'Lohith Material' } }),
    );
  });

  it('freezes the legal name once the vendor is activated', async () => {
    const { svc, vendorUpdate } = makeService({
      vendorRecord: {
        ...ONBOARDING_VENDOR,
        activatedAt: new Date('2026-07-01'),
        lifecycleStatus: 'ACTIVE',
      },
    });
    await expect(
      svc.renameVendor('ven_1', { legalEntityName: 'Something Else Ltd' }, 'usr_officer'),
    ).rejects.toBeInstanceOf(VendorStateError);
    expect(vendorUpdate).not.toHaveBeenCalled();
  });

  it('still allows a display-name fix on an activated vendor', async () => {
    const { svc, vendorUpdate } = makeService({
      vendorRecord: {
        ...ONBOARDING_VENDOR,
        activatedAt: new Date('2026-07-01'),
        lifecycleStatus: 'ACTIVE',
      },
    });
    await svc.renameVendor('ven_1', { name: 'Lohith Material' }, 'usr_officer');
    expect(vendorUpdate).toHaveBeenCalledOnce();
  });
});

/**
 * The rule behind both the portal's read-only state and the server-side guards
 * on saveStep/submitOnboarding. Re-submitting an approved vendor used to drop
 * lifecycle_status back to UNDER_REVIEW, which disqualified them from new POs
 * while the picker (reading the legacy `status`) still offered them.
 */
describe('isOnboardingEditable', () => {
  const draft = { submittedAt: null, reviewDecision: null };

  it('allows an unsubmitted onboarding', () => {
    expect(isOnboardingEditable('DRAFT', draft)).toBe(true);
  });

  it('locks an approved, active vendor out of re-submitting', () => {
    expect(isOnboardingEditable('ACTIVE', draft)).toBe(false);
  });

  it('locks a submission that is awaiting a decision', () => {
    expect(
      isOnboardingEditable('UNDER_REVIEW', {
        submittedAt: new Date('2026-08-01'),
        reviewDecision: null,
      }),
    ).toBe(false);
  });

  it('reopens the wizard when the buyer returns it for more information', () => {
    expect(
      isOnboardingEditable('UNDER_REVIEW', {
        submittedAt: new Date('2026-08-01'),
        reviewDecision: 'RETURNED_FOR_INFO',
      }),
    ).toBe(true);
  });

  it('stays locked on a decided onboarding that is not returned for info', () => {
    expect(
      isOnboardingEditable('UNDER_REVIEW', {
        submittedAt: new Date('2026-08-01'),
        reviewDecision: 'APPROVED',
      }),
    ).toBe(false);
  });
});
