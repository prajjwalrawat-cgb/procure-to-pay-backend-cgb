import { randomBytes } from 'node:crypto';

import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, newId } from '@procureflow/db';
import { hash } from 'argon2';
import {
  VENDOR_EVENTS,
  assessAcceptance,
  categoryConfig,
  type AcknowledgeCocInput,
  type InviteVendorInput,
  type OnboardingStep1,
  type OnboardingStep2,
  type OnboardingStep3,
  type OnboardingStep5,
  type OnboardingStep6,
  type ReturnForInfoInput,
  type SaveStepInput,
  type SelfRegistrationInput,
} from '@procureflow/shared';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import { NotificationService } from '../approvals/notification.service';
import { AuditLogService } from '../audit/audit.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { MailService } from '../common/mail/mail.service';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { VendorScorecardService } from './vendor-scorecard.service';
import { VendorVerificationService } from './vendor-verification.service';
import {
  PENNY_DROP_PROVIDER,
  type IPennyDropProvider,
} from './verification/penny-drop.provider';
import { CAPTCHA_PROVIDER, type ICaptchaProvider } from './verification/captcha.provider';
import {
  InvalidTokenError,
  VendorStateError,
  VendorValidationError,
} from './vendor.errors';

const TOKEN_TTL_DAYS = 14;
const VENDOR_DEFAULT_PASSWORD = 'Slice0!Vendor';

interface WizardState {
  currentStep: number;
  completionPct: number;
  steps: Record<string, { done: boolean; data: Record<string, unknown> }>;
}

/**
 * VendorOnboardingService (Slice 7 §2). Buyer-invite and self-registration both
 * land in one review queue: invite → wizard (6 steps, auto-triggered
 * verifications) → submit → Slice 2 approval → activation. Reuses the approval
 * engine (VENDOR_ONBOARDING) and reads Slice 5 GRN data for the cold-start
 * scorecard on activation.
 */
@Injectable()
export class VendorOnboardingService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
    private readonly notifications: NotificationService,
    private readonly routing: ApprovalRoutingService,
    private readonly verification: VendorVerificationService,
    private readonly scorecard: VendorScorecardService,
    private readonly mail: MailService,
    private readonly config: ConfigService<Env, true>,
    @Inject(PENNY_DROP_PROVIDER) private readonly pennyDrop: IPennyDropProvider,
    @Inject(CAPTCHA_PROVIDER) private readonly captcha: ICaptchaProvider,
  ) {}

  onModuleInit(): void {
    this.routing.onApproved('VENDOR_ONBOARDING', (onboardingId, actorId) =>
      this.onOnboardingApproved(onboardingId, actorId),
    );
  }

  // ── Invitation / registration ────────────────────────────────────────────

  async inviteVendor(
    input: InviteVendorInput,
    actorId: string,
  ): Promise<{ vendorId: string; onboardingId: string }> {
    const tenantId = this.tenantId();
    const config = categoryConfig(input.categoryKey);
    if (!config)
      throw new VendorValidationError('Unknown vendor category.', {
        key: input.categoryKey,
      });

    const created = await this.createVendorShell(tenantId, {
      legalEntityName: input.legalEntityName,
      name: input.name,
      email: input.email,
      categoryKey: input.categoryKey,
      lifecycleStatus: 'INVITED',
      // Random, never-disclosed: the emailed set-password link is the only way in.
      userPassword: randomBytes(24).toString('hex'),
    });
    const { id: onboardingId, token: inviteToken } = await this.createOnboarding(
      tenantId,
      created.vendorId,
      {
        source: input.source,
        invitationRef: input.rfqId ?? null,
        invitedBy: actorId,
        slaHours: config.slaHours,
      },
    );
    await this.audit.record({
      action: 'VENDOR_INVITED',
      entityType: 'Vendor',
      entityId: created.vendorId,
      actorId,
      after: { email: input.email, source: input.source, category: input.categoryKey },
    });
    await this.events.emit(VENDOR_EVENTS.VENDOR_INVITED, {
      vendorId: created.vendorId,
      onboardingId,
      source: input.source,
      email: input.email,
    });
    await this.sendInviteEmail(
      tenantId,
      input.email,
      input.name || input.legalEntityName,
      inviteToken,
    );
    return { vendorId: created.vendorId, onboardingId };
  }

  /** Accept a buyer invite from the emailed magic link: validate the token and
   *  set the vendor user's own password. Public (no JWT) — the link carries the
   *  tenant so we can open the correct RLS context; the token is the secret gate. */
  async acceptInvite(
    tenantId: string,
    token: string,
    password: string,
  ): Promise<{ email: string }> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new InvalidTokenError('Invalid invitation link.');
    return this.prisma.runInTenantContext(tenant.id, async () => {
      const onboarding = await this.requireOnboardingByToken(token);
      const contact = await this.prisma.client.vendorContact.findFirst({
        where: { vendorId: onboarding.vendorId, isPrimary: true },
        select: { email: true },
      });
      if (!contact?.email) throw new InvalidTokenError('Invitation has no contact.');
      const user = await this.prisma.client.user.findUnique({
        where: { tenantId_email: { tenantId: tenant.id, email: contact.email } },
        select: { id: true },
      });
      if (!user) throw new InvalidTokenError('No account for this invitation.');
      const argonHash = await hash(password, { type: 2 });
      await this.prisma.client.user.update({
        where: { id: user.id },
        data: { argonHash, isActive: true },
      });
      await this.prisma.client.vendorOnboarding.update({
        where: { id: onboarding.id },
        data: { emailVerifiedAt: new Date() },
      });
      await this.audit.record({
        action: 'VENDOR_INVITE_ACCEPTED',
        entityType: 'Vendor',
        entityId: onboarding.vendorId,
        actorId: user.id,
        after: { email: contact.email },
        tenantId: tenant.id,
      });
      return { email: contact.email };
    });
  }

  /** Build the set-password magic link and email it to the invited vendor.
   *  Never throws into the invite flow — a mail failure must not 500 the invite
   *  (the onboarding row already exists and the link can be re-sent). */
  private async sendInviteEmail(
    tenantId: string,
    email: string,
    vendorName: string,
    token: string,
  ): Promise<void> {
    try {
      const tenant = await this.prisma.client.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true },
      });
      const buyerName = tenant?.name ?? 'your buyer';
      const base = this.config.get('APP_BASE_URL', { infer: true });
      const link = `${base}/vendor/accept-invite?token=${encodeURIComponent(
        token,
      )}&tenant=${encodeURIComponent(tenantId)}`;
      const subject = `You've been invited to onboard as a vendor for ${buyerName}`;
      const text =
        `Hello ${vendorName},\n\n` +
        `${buyerName} has invited you to register as a vendor on ProcureFlow.\n\n` +
        `Set your password and start onboarding here (link valid for ${TOKEN_TTL_DAYS} days):\n` +
        `${link}\n\n` +
        `After setting your password you'll complete a short onboarding wizard.\n\n` +
        `If you weren't expecting this, you can ignore this email.`;
      const html =
        `<p>Hello ${escapeHtml(vendorName)},</p>` +
        `<p><strong>${escapeHtml(buyerName)}</strong> has invited you to register as a ` +
        `vendor on ProcureFlow.</p>` +
        `<p><a href="${link}">Set your password and start onboarding</a> ` +
        `(link valid for ${TOKEN_TTL_DAYS} days).</p>` +
        `<p>After setting your password you'll complete a short onboarding wizard.</p>` +
        `<p style="color:#888;font-size:12px">If you weren't expecting this, you can ignore this email.</p>`;
      // Fire-and-forget: a real SMTP round-trip takes several seconds and would
      // otherwise exceed the request's 5s RLS transaction budget ("Transaction
      // already closed"). The onboarding row exists and the link can be re-sent.
      void this.mail.send({ to: email, subject, text, html }).catch((e) =>
        // eslint-disable-next-line no-console
        console.error('[inviteVendor] failed to send invite email:', e),
      );
    } catch (err) {
      // Swallow — invite already succeeded; surface for ops via logs.
      // eslint-disable-next-line no-console
      console.error('[inviteVendor] failed to send invite email:', err);
    }
  }

  /** Public, no JWT — must open its own tenant transaction for the writes. */
  async startSelfRegistration(
    input: SelfRegistrationInput,
  ): Promise<{ vendorId: string; token: string }> {
    // Slice 10c — real reCAPTCHA v3 verification (sandbox stub until a key is set).
    const captcha = await this.captcha.verify(input.captchaResponse);
    if (!captcha.ok) {
      throw new VendorValidationError(captcha.reason ?? 'Captcha verification failed.');
    }
    const config = categoryConfig(input.categoryKey);
    if (!config) throw new VendorValidationError('Unknown vendor category.');
    // Bind to the tenant named in the (buyer-issued) registration link — never
    // an arbitrary/first tenant (audit: multi-tenancy self-registration gap).
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: input.tenantId },
    });
    if (!tenant) throw new VendorValidationError('Unknown registration link.');
    return this.prisma.runInTenantContext(tenant.id, async () => {
      const created = await this.createVendorShell(tenant.id, {
        legalEntityName: input.legalEntityName,
        name: input.legalEntityName,
        email: input.email,
        categoryKey: input.categoryKey,
        lifecycleStatus: 'SELF_REGISTERED',
        phone: input.phone,
      });
      const { id: onboardingId } = await this.createOnboarding(
        tenant.id,
        created.vendorId,
        {
          source: 'SELF_REGISTRATION',
          invitationRef: null,
          invitedBy: null,
          slaHours: config.slaHours,
        },
      );
      await this.audit.record({
        action: 'VENDOR_SELF_REGISTERED',
        entityType: 'Vendor',
        entityId: created.vendorId,
        after: { email: input.email, category: input.categoryKey },
        tenantId: tenant.id,
      });
      await this.events.emit(
        VENDOR_EVENTS.VENDOR_SELF_REGISTERED,
        { vendorId: created.vendorId, onboardingId, email: input.email },
        tenant.id,
      );
      return { vendorId: created.vendorId, token: created.token };
    });
  }

  async verifyEmail(token: string): Promise<{ vendorId: string }> {
    const onboarding = await this.requireOnboardingByToken(token);
    await this.prisma.client.vendorOnboarding.update({
      where: { id: onboarding.id },
      data: { emailVerifiedAt: new Date() },
    });
    return { vendorId: onboarding.vendorId };
  }

  // ── Wizard ─────────────────────────────────────────────────────────────────

  async resumeOnboarding(userId: string): Promise<{
    vendorId: string;
    onboardingId: string;
    categoryKey: string;
    wizardState: WizardState;
  }> {
    const vendorId = await this.resolveVendorId(userId);
    const onboarding = await this.requireActiveOnboarding(vendorId);
    return {
      vendorId,
      onboardingId: onboarding.id,
      categoryKey: onboarding.categoryConfigKey,
      wizardState: onboarding.wizardState as unknown as WizardState,
    };
  }

  async saveStep(
    userId: string,
    stepNumber: number,
    stepData: SaveStepInput,
  ): Promise<{ ok: true }> {
    const vendorId = await this.resolveVendorId(userId);
    const onboarding = await this.requireActiveOnboarding(vendorId);
    const vendor = await this.prisma.client.vendor.findUniqueOrThrow({
      where: { id: vendorId },
    });

    await this.persistStep(vendorId, vendor.tenantId, stepNumber, stepData);

    const state =
      (onboarding.wizardState as unknown as WizardState) ?? this.initialWizardState();
    state.steps[`step${stepNumber}`] = {
      done: true,
      data: stepData as Record<string, unknown>,
    };
    const doneCount = Object.values(state.steps).filter((s) => s.done).length;
    state.completionPct = Math.round((doneCount / 6) * 100);
    state.currentStep = Math.min(6, stepNumber + 1);
    await this.prisma.client.vendorOnboarding.update({
      where: { id: onboarding.id },
      data: {
        wizardState: state as unknown as Prisma.InputJsonValue,
        vendor: { update: { lifecycleStatus: 'IN_ONBOARDING' } },
      },
    });
    // Auto-trigger verifications for verifiable fields on that step.
    await this.autoVerify(vendorId, stepNumber, stepData);
    await this.audit.record({
      action: 'ONBOARDING_STEP_SAVED',
      entityType: 'Vendor',
      entityId: vendorId,
      actorId: userId,
      after: { step: stepNumber, completionPct: state.completionPct },
    });
    return { ok: true };
  }

  async acknowledgeCoc(
    userId: string,
    input: AcknowledgeCocInput,
    ip: string | null,
    device: string | null,
  ): Promise<{ ok: true }> {
    const vendorId = await this.resolveVendorId(userId);
    await this.prisma.client.vendor.update({
      where: { id: vendorId },
      data: {
        cocAcknowledgedAt: new Date(),
        cocAckIp: ip,
        cocAckDevice: device,
        dataProcessingConsentAt: new Date(),
      },
    });
    await this.audit.record({
      action: 'ONBOARDING_COC_ACKNOWLEDGED',
      entityType: 'Vendor',
      entityId: vendorId,
      actorId: userId,
      after: { name: input.name, designation: input.designation, ip },
    });
    return { ok: true };
  }

  async submitOnboarding(userId: string): Promise<{ ok: true }> {
    const vendorId = await this.resolveVendorId(userId);
    const onboarding = await this.requireActiveOnboarding(vendorId);
    const vendor = await this.prisma.client.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      include: { documents: true },
    });
    const state = onboarding.wizardState as unknown as WizardState;
    const config = categoryConfig(onboarding.categoryConfigKey);

    // Guards.
    const requiredSteps = [1, 2, 3, 5, 6];
    for (const s of requiredSteps) {
      if (!state.steps[`step${s}`]?.done) {
        throw new VendorValidationError(`Step ${s} is not complete.`, { step: s });
      }
    }
    if (config) {
      const uploaded = new Set(vendor.documents.map((d) => d.docType));
      const missing = config.requiredDocuments.filter((d) => !uploaded.has(d));
      if (missing.length > 0) {
        throw new VendorValidationError('Mandatory documents are missing.', { missing });
      }
    }
    if (!vendor.cocAcknowledgedAt) {
      throw new VendorValidationError('The code of conduct must be acknowledged.');
    }
    if (!vendor.dataProcessingConsentAt) {
      throw new VendorValidationError('Data-processing consent is required.');
    }

    const slaHours = vendor.isMsme ? 48 : onboarding.slaTargetHours;
    await this.prisma.client.vendorOnboarding.update({
      where: { id: onboarding.id },
      data: {
        submittedAt: new Date(),
        slaTargetHours: slaHours,
        slaBreachAt: new Date(Date.now() + slaHours * 3_600_000),
        vendor: { update: { lifecycleStatus: 'UNDER_REVIEW' } },
      },
    });
    await this.audit.record({
      action: 'ONBOARDING_SUBMITTED',
      entityType: 'Vendor',
      entityId: vendorId,
      actorId: userId,
      after: { onboardingId: onboarding.id, slaHours },
    });
    await this.routing.submit('VENDOR_ONBOARDING', onboarding.id, userId);
    return { ok: true };
  }

  async returnForInfo(
    onboardingId: string,
    input: ReturnForInfoInput,
    actorId: string,
  ): Promise<{ ok: true }> {
    const onboarding = await this.prisma.client.vendorOnboarding.findUniqueOrThrow({
      where: { id: onboardingId },
    });
    await this.prisma.client.vendorOnboarding.update({
      where: { id: onboardingId },
      data: {
        reviewDecision: 'RETURNED_FOR_INFO',
        reviewNotes: input.note ?? null,
        returnForInfoItems: input.items as unknown as Prisma.InputJsonValue,
        vendor: { update: { lifecycleStatus: 'IN_ONBOARDING' } },
      },
    });
    await this.audit.record({
      action: 'ONBOARDING_RETURNED_FOR_INFO',
      entityType: 'Vendor',
      entityId: onboarding.vendorId,
      actorId,
      after: { items: input.items },
    });
    return { ok: true };
  }

  /** Fired by the approval engine when onboarding is fully approved. */
  async onOnboardingApproved(onboardingId: string, actorId: string): Promise<void> {
    const onboarding = await this.prisma.client.vendorOnboarding.findUnique({
      where: { id: onboardingId },
    });
    if (!onboarding) return;
    await this.activateVendor(onboarding.vendorId, actorId);
  }

  async activateVendor(vendorId: string, actorId: string): Promise<{ ok: true }> {
    const vendor = await this.prisma.client.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      include: { screenings: true, documents: true },
    });
    // Guards: no un-reviewed FLAGGED screenings; no PENDING/FAILED mandatory docs.
    const openFlags = vendor.screenings.filter(
      (s) =>
        s.status === 'FLAGGED' &&
        s.reviewDecision !== 'ACCEPT_RISK' &&
        s.reviewDecision !== 'CLEAR',
    );
    if (openFlags.length > 0) {
      throw new VendorStateError('Cannot activate — unresolved flagged screenings.', {
        screenings: openFlags.map((s) => s.screeningType),
      });
    }
    await this.prisma.client.vendor.update({
      where: { id: vendorId },
      data: {
        lifecycleStatus: 'ACTIVE',
        status: 'ACTIVE',
        activatedAt: new Date(),
        activatedBy: actorId,
        preliminaryStatus: false,
      },
    });
    await this.scorecard.computeScorecard(vendorId, null, 'ROLLING_90D', actorId);
    await this.notifyVendorUser(
      vendorId,
      'Your vendor account is now active',
      `/profile`,
    );
    await this.audit.record({
      action: 'VENDOR_ACTIVATED',
      entityType: 'Vendor',
      entityId: vendorId,
      actorId,
    });
    await this.events.emit(VENDOR_EVENTS.VENDOR_ACTIVATED, {
      vendorId,
      activatedBy: actorId,
    });
    return { ok: true };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async persistStep(
    vendorId: string,
    tenantId: string,
    stepNumber: number,
    stepData: SaveStepInput,
  ): Promise<void> {
    if (stepNumber === 1) {
      const s = stepData as OnboardingStep1;
      await this.prisma.client.vendor.update({
        where: { id: vendorId },
        data: {
          legalEntityType: s.legalEntityType,
          legalEntityName: s.legalEntityName,
          businessPan: s.businessPan,
          pan: s.businessPan,
          dateOfIncorporation: s.dateOfIncorporation
            ? new Date(s.dateOfIncorporation)
            : null,
        },
      });
    } else if (stepNumber === 2) {
      const s = stepData as OnboardingStep2;
      await this.prisma.client.vendor.update({
        where: { id: vendorId },
        data: { gstin: s.gstin, isMsme: s.isMsme, udyamNumber: s.udyamNumber ?? null },
      });
    } else if (stepNumber === 3) {
      const s = stepData as OnboardingStep3;
      await this.prisma.client.vendorBank.deleteMany({ where: { vendorId } });
      await this.prisma.client.vendorBank.create({
        data: {
          id: newId('vendorBank'),
          tenantId,
          vendorId,
          bankName: s.bankName,
          accountNoEncrypted: `enc:xxxx${s.accountNumber.slice(-4)}`,
          ifsc: s.ifsc,
          holderName: s.holderName,
        },
      });
    } else if (stepNumber === 5) {
      const s = stepData as OnboardingStep5;
      await this.prisma.client.vendor.update({
        where: { id: vendorId },
        data: {
          categoryTags: s.categoryTags,
          capabilityTags: s.capabilityTags,
          employeeCountBracket: s.employeeCountBracket,
          annualTurnoverDeclared: s.annualTurnoverDeclared
            ? new Prisma.Decimal(s.annualTurnoverDeclared)
            : null,
        },
      });
    } else if (stepNumber === 6) {
      const s = stepData as OnboardingStep6;
      await this.prisma.client.vendorBeneficialOwner.deleteMany({ where: { vendorId } });
      for (const o of s.beneficialOwners) {
        await this.prisma.client.vendorBeneficialOwner.create({
          data: {
            id: newId('vendorBeneficialOwner'),
            tenantId,
            vendorId,
            ownerName: o.ownerName,
            ownerPan: o.ownerPan,
            ownerDob: o.ownerDob ? new Date(o.ownerDob) : null,
            ownershipPct: new Prisma.Decimal(o.ownershipPct),
            ownershipType: o.ownershipType,
            countryOfResidence: o.countryOfResidence,
            isPep: o.isPep,
            pepDetails: o.pepDetails ?? null,
            declaredBy: 'vendor',
          },
        });
      }
      await this.prisma.client.vendor.update({
        where: { id: vendorId },
        data: {
          isRelatedParty: s.isRelatedParty,
          relatedPartyDisclosure: s.relatedPartyDisclosure ?? null,
        },
      });
    }
  }

  private async autoVerify(
    vendorId: string,
    stepNumber: number,
    stepData: SaveStepInput,
  ): Promise<void> {
    if (stepNumber === 2) {
      const s = stepData as OnboardingStep2;
      await this.verification.runScreening(vendorId, 'GSTIN_STATUS', 'system');
      await this.verification.runScreening(vendorId, 'PAN_STATUS', 'system');
      if (s.isMsme)
        await this.verification.runScreening(vendorId, 'UDYAM_STATUS', 'system');
    } else if (stepNumber === 3) {
      const s = stepData as OnboardingStep3;
      const { registeredName, matchScore } = await this.pennyDrop.verify(
        s.holderName,
        s.accountNumber,
      );
      const bank = await this.prisma.client.vendorBank.findFirst({ where: { vendorId } });
      if (bank) {
        const pass = assessAcceptance(matchScore).pass;
        await this.prisma.client.vendorBank.update({
          where: { id: bank.id },
          data: {
            pennyDropCreditedAt: new Date(),
            pennyDropNameReturned: registeredName,
            nameMatchScore: new Prisma.Decimal(matchScore),
            nameMatchAlgorithm: 'HYBRID',
            isVerified: pass,
            verifiedAt: pass ? new Date() : null,
          },
        });
      }
    } else if (stepNumber === 6) {
      await this.verification.runScreening(vendorId, 'SANCTIONS_OFAC', 'system');
    }
  }

  private async createVendorShell(
    tenantId: string,
    input: {
      legalEntityName: string;
      name: string;
      email: string;
      categoryKey: string;
      lifecycleStatus: 'INVITED' | 'SELF_REGISTERED';
      phone?: string;
      /** Password for the auto-created vendor login. Invited vendors get a
       *  random, never-disclosed value so the only way in is the emailed
       *  set-password link; self-registration keeps the shared default. */
      userPassword?: string;
    },
  ): Promise<{ vendorId: string; token: string }> {
    const vendorId = newId('vendor');
    const code = `VN-${vendorId.slice(-6).toUpperCase()}`;
    const token = randomBytes(24).toString('hex');
    await this.prisma.client.vendor.create({
      data: {
        id: vendorId,
        tenantId,
        code,
        name: input.name,
        legalEntityName: input.legalEntityName,
        status: 'PENDING_VERIFICATION',
        lifecycleStatus: input.lifecycleStatus,
        preliminaryStatus: true,
        categoryConfigKey: input.categoryKey,
        onboardingStartedAt: new Date(),
        contacts: {
          create: {
            id: newId('vendorContact'),
            tenantId,
            name: input.name,
            email: input.email,
            phone: input.phone ?? null,
            isPrimary: true,
          },
        },
      },
    });
    await this.ensureVendorUser(
      tenantId,
      input.email,
      input.name,
      input.userPassword ?? VENDOR_DEFAULT_PASSWORD,
    );
    return { vendorId, token };
  }

  private async createOnboarding(
    tenantId: string,
    vendorId: string,
    input: {
      source: string;
      invitationRef: string | null;
      invitedBy: string | null;
      slaHours: number;
    },
  ): Promise<{ id: string; token: string }> {
    const id = newId('vendorOnboarding');
    const token = randomBytes(24).toString('hex');
    await this.prisma.client.vendorOnboarding.create({
      data: {
        id,
        tenantId,
        vendorId,
        invitationSource: input.source as never,
        invitationRef: input.invitationRef,
        invitedBy: input.invitedBy,
        selfRegistrationToken: token,
        tokenExpiresAt: new Date(Date.now() + TOKEN_TTL_DAYS * 86_400_000),
        wizardState: this.initialWizardState() as unknown as Prisma.InputJsonValue,
        categoryConfigKey:
          (await this.vendorCategory(vendorId)) ?? 'PROFESSIONAL_SERVICES',
        slaTargetHours: input.slaHours,
      },
    });
    return { id, token };
  }

  private async ensureVendorUser(
    tenantId: string,
    email: string,
    name: string,
    password: string,
  ): Promise<void> {
    const existing = await this.prisma.client.user.findUnique({
      where: { tenantId_email: { tenantId, email } },
    });
    if (existing) return;
    const role = await this.prisma.client.role.findUniqueOrThrow({
      where: { name: 'VENDOR_USER' },
    });
    const argonHash = await hash(password, { type: 2 });
    const user = await this.prisma.client.user.create({
      data: { id: newId('user'), tenantId, email, name, argonHash, isActive: true },
    });
    await this.prisma.client.userRole.create({
      data: { id: newId('userRole'), tenantId, userId: user.id, roleId: role.id },
    });
  }

  private async vendorCategory(vendorId: string): Promise<string | null> {
    const v = await this.prisma.client.vendor.findUnique({
      where: { id: vendorId },
      select: { categoryConfigKey: true },
    });
    return v?.categoryConfigKey ?? null;
  }

  private initialWizardState(): WizardState {
    return { currentStep: 1, completionPct: 0, steps: {} };
  }

  async resolveVendorId(userId: string): Promise<string> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) throw new ForbiddenException('Not a vendor account');
    const contact = await this.prisma.client.vendorContact.findFirst({
      where: { email: user.email },
      orderBy: { isPrimary: 'desc' },
      select: { vendorId: true },
    });
    if (!contact) throw new ForbiddenException('No vendor linked to this account');
    return contact.vendorId;
  }

  private async requireActiveOnboarding(
    vendorId: string,
  ): Promise<Prisma.VendorOnboardingGetPayload<Record<string, never>>> {
    const onboarding = await this.prisma.client.vendorOnboarding.findFirst({
      where: { vendorId },
      orderBy: { startedAt: 'desc' },
    });
    if (!onboarding) throw new NotFoundException('No onboarding in progress');
    return onboarding;
  }

  private async requireOnboardingByToken(
    token: string,
  ): Promise<Prisma.VendorOnboardingGetPayload<Record<string, never>>> {
    const onboarding = await this.prisma.client.vendorOnboarding.findFirst({
      where: { selfRegistrationToken: token },
    });
    if (!onboarding) throw new InvalidTokenError('Invalid registration token.');
    if (onboarding.tokenExpiresAt && onboarding.tokenExpiresAt.getTime() < Date.now()) {
      throw new InvalidTokenError('Registration token expired.');
    }
    return onboarding;
  }

  private async notifyVendorUser(
    vendorId: string,
    title: string,
    href: string,
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
      type: 'VENDOR_LIFECYCLE',
      title,
      entityType: 'Vendor',
      entityId: vendorId,
      href,
    });
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}

/** Minimal HTML-escaping for interpolated names in outbound email bodies. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
