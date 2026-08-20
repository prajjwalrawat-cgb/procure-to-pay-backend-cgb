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
  ONBOARDING_MANDATORY_DOCUMENTS,
  ONBOARDING_STEP1_DOCUMENTS,
  ONBOARDING_STEP_COUNT,
  ONBOARDING_STEP_NAMES,
  VENDOR_EVENTS,
  assessAcceptance,
  compare as compareNames,
  fieldSourceLabel,
  panGstinMismatch,
  vendorDocumentLabel,
  type CancelOnboardingInput,
  type DocumentExtractionResult,
  type ExtractedFieldMap,
  type InviteVendorInput,
  type OnboardingStep1,
  type OnboardingStep2,
  type OnboardingStep3,
  type RenameVendorInput,
  type ReturnForInfoInput,
  type SaveStepInput,
  type SelfRegistrationInput,
  type VendorDocumentType,
} from '@procureflow/shared';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import { NotificationService } from '../approvals/notification.service';
import { AuditLogService } from '../audit/audit.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { MailService } from '../common/mail/mail.service';
import { StorageService } from '../common/storage/storage.service';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { VendorCategoriesService } from '../settings/vendor-categories.service';
import { VendorKycService } from './vendor-kyc.service';
import { VendorScorecardService } from './vendor-scorecard.service';
import { VendorVerificationService } from './vendor-verification.service';
import {
  IFSC_PROVIDER,
  type IIfscProvider,
  type IfscDetails,
} from './verification/ifsc.provider';
import {
  PENNY_DROP_PROVIDER,
  type IPennyDropProvider,
} from './verification/penny-drop.provider';
import { CAPTCHA_PROVIDER, type ICaptchaProvider } from './verification/captcha.provider';
import {
  DuplicateVendorError,
  InvalidTokenError,
  VendorStateError,
  VendorValidationError,
} from './vendor.errors';

const TOKEN_TTL_DAYS = 14;
const VENDOR_DEFAULT_PASSWORD = 'Slice0!Vendor';
/** Lifecycle states a vendor can be re-invited from. Everything else means a
 *  live record already exists (or is deliberately barred, for BLACKLISTED). */
const REINVITABLE_STATUSES = new Set<string>(['ARCHIVED']);
/** Legal-entity-name similarity above which an invite is treated as a probable
 *  duplicate. Deliberately above assessAcceptance's 0.85 default: a false block
 *  here costs the officer a second click, but the whole point is to catch the
 *  "Lohith" / "Lohith Enterprises" re-type, not to flag every shared word. */
const NAME_DUPLICATE_THRESHOLD = 0.88;
/** Cap on the name-similarity sweep. Ordered newest-first, so the realistic
 *  duplicate — an invite sent minutes ago — is always in the window. */
const NAME_SCAN_LIMIT = 2000;

interface WizardState {
  currentStep: number;
  completionPct: number;
  steps: Record<string, { done: boolean; data: Record<string, unknown> }>;
  /**
   * Provenance of every auto-filled field: the value, where it came from, and
   * whether anything outside the uploaded document agreed with it. Kept on the
   * onboarding rather than only on the vendor master so the *source* survives
   * alongside the value — which is what a later dispute ("who typed this bank
   * name?") actually turns on. Written by recordExtraction, read by the wizard
   * to badge and lock fields, and enforced on save.
   */
  extracted?: ExtractedFieldMap;
}

/** The columns the duplicate-invite guard needs to explain itself to the user. */
const DUPLICATE_CANDIDATE_SELECT = {
  id: true,
  code: true,
  name: true,
  legalEntityName: true,
  lifecycleStatus: true,
} satisfies Prisma.VendorSelect;

interface DuplicateCandidate {
  id: string;
  code: string;
  name: string;
  legalEntityName: string | null;
  lifecycleStatus: string;
}

/** A document the vendor has already uploaded, as shown in their own wizard. */
export interface UploadedDocumentView {
  id: string;
  docType: string;
  filename: string;
  sizeBytes: number;
  verificationStatus: string;
  uploadedAt: string;
  /** Presigned GET, or '' if the object could not be signed. */
  url: string;
}

/**
 * VendorOnboardingService (Slice 7 §2). Buyer-invite and self-registration both
 * land in one review queue: invite → wizard (4 steps, document-driven auto-fill
 * and auto-triggered verifications) → submit → Slice 2 approval → activation.
 * Reuses the approval engine (VENDOR_ONBOARDING) and reads Slice 5 GRN data for
 * the cold-start scorecard on activation.
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
    private readonly kyc: VendorKycService,
    private readonly mail: MailService,
    private readonly storage: StorageService,
    private readonly config: ConfigService<Env, true>,
    @Inject(PENNY_DROP_PROVIDER) private readonly pennyDrop: IPennyDropProvider,
    @Inject(IFSC_PROVIDER) private readonly ifsc: IIfscProvider,
    @Inject(CAPTCHA_PROVIDER) private readonly captcha: ICaptchaProvider,
    private readonly categories: VendorCategoriesService,
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
    // Categories are tenant data (Settings → Vendor categories), so what counts
    // as a valid one is a lookup, not an enum.
    const config = await this.categories.findActive(tenantId, input.categoryKey);
    if (!config)
      throw new VendorValidationError('Unknown vendor category.', {
        key: input.categoryKey,
      });
    await this.assertNoDuplicateInvite(input);

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
    // Bind to the tenant named in the (buyer-issued) registration link — never
    // an arbitrary/first tenant (audit: multi-tenancy self-registration gap).
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: input.tenantId },
    });
    if (!tenant) throw new VendorValidationError('Unknown registration link.');
    return this.prisma.runInTenantContext(tenant.id, async () => {
      // Inside the tenant context: the categories offered are that tenant's own,
      // and reading them is an RLS-scoped query.
      const config = await this.categories.findActive(tenant.id, input.categoryKey);
      if (!config) throw new VendorValidationError('Unknown vendor category.');
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
    documents: UploadedDocumentView[];
    /** Where this onboarding stands, so the portal can show the wizard, a
     *  "waiting on review" notice, or the approved state — rather than
     *  offering Submit again to a vendor who is already through. */
    lifecycleStatus: string;
    submittedAt: string | null;
    reviewDecision: string | null;
    reviewNotes: string | null;
    editable: boolean;
  }> {
    const vendorId = await this.resolveVendorId(userId);
    const onboarding = await this.requireActiveOnboarding(vendorId);
    const vendorRow = await this.prisma.client.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: { lifecycleStatus: true },
    });
    // Documents come back with the wizard so an uploaded file is still shown
    // (and openable) after a refresh — the ticks are not just client state.
    const docs = await this.prisma.client.vendorDocument.findMany({
      where: { vendorId },
      orderBy: { uploadedAt: 'desc' },
    });
    return {
      vendorId,
      onboardingId: onboarding.id,
      categoryKey: onboarding.categoryConfigKey,
      wizardState: onboarding.wizardState as unknown as WizardState,
      lifecycleStatus: vendorRow.lifecycleStatus,
      submittedAt: onboarding.submittedAt?.toISOString() ?? null,
      reviewDecision: onboarding.reviewDecision,
      reviewNotes: onboarding.reviewNotes,
      editable: isOnboardingEditable(vendorRow.lifecycleStatus, onboarding),
      documents: await Promise.all(
        docs.map(async (d) => ({
          id: d.id,
          docType: d.docType,
          filename: d.filename ?? d.s3Key,
          sizeBytes: d.sizeBytes ?? 0,
          verificationStatus: d.verificationStatus,
          uploadedAt: d.uploadedAt?.toISOString() ?? '',
          url: await this.storage.presignedGetUrl(d.s3Key).catch(() => ''),
        })),
      ),
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
    // Wizard steps write straight onto the vendor master, so an approved vendor
    // editing here would change their own record with nobody reviewing it.
    if (!isOnboardingEditable(vendor.lifecycleStatus, onboarding)) {
      throw new VendorStateError(
        vendor.lifecycleStatus === 'ACTIVE'
          ? 'This vendor is already approved. Raise a change request to update the details.'
          : 'This onboarding is awaiting review and cannot be edited.',
        { lifecycleStatus: vendor.lifecycleStatus },
      );
    }

    const state =
      (onboarding.wizardState as unknown as WizardState) ?? this.initialWizardState();
    state.steps = state.steps ?? {};
    await this.assertStepAcceptable(vendorId, vendor, state, stepNumber, stepData);

    await this.persistStep(vendorId, vendor.tenantId, stepNumber, stepData);

    state.steps[`step${stepNumber}`] = {
      done: true,
      data: stepData as Record<string, unknown>,
    };
    // Counted over the steps that exist *now*. An onboarding started under the
    // old six-step wizard carries step5/step6 entries; counting every key would
    // report it 150% complete.
    const doneCount = Array.from(
      { length: ONBOARDING_STEP_COUNT },
      (_, i) => state.steps[`step${i + 1}`]?.done === true,
    ).filter(Boolean).length;
    state.completionPct = Math.round((doneCount / ONBOARDING_STEP_COUNT) * 100);
    state.currentStep = Math.min(ONBOARDING_STEP_COUNT, stepNumber + 1);
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

  /**
   * Record what a just-uploaded GST certificate / PAN card yielded.
   *
   * Extraction results live on the wizard, not on the vendor master: nothing is
   * written to the vendor record until the vendor has seen the values and saved
   * the step. What is stored here is the *attribution* — value, source, verified
   * flag — which is what later lets anyone answer "where did this legal name
   * come from" without re-reading the document.
   */
  async recordExtraction(
    userId: string,
    result: DocumentExtractionResult,
  ): Promise<ExtractedFieldMap> {
    const vendorId = await this.resolveVendorId(userId);
    // An already-activated vendor re-uploading a certificate has no wizard to
    // write to. The document is still filed and audited; there is simply no
    // form left to pre-fill, so this is a no-op rather than a 404.
    const onboarding = await this.findOnboarding(vendorId);
    if (!onboarding) return {};
    const state =
      (onboarding.wizardState as unknown as WizardState) ?? this.initialWizardState();
    state.extracted = VendorKycService.merge(state.extracted ?? {}, result.fields);
    await this.prisma.client.vendorOnboarding.update({
      where: { id: onboarding.id },
      data: { wizardState: state as unknown as Prisma.InputJsonValue },
    });
    await this.audit.record({
      action: 'ONBOARDING_DOCUMENT_EXTRACTED',
      entityType: 'Vendor',
      entityId: vendorId,
      actorId: userId,
      after: {
        docType: result.docType,
        fields: Object.fromEntries(
          Object.entries(result.fields).map(([k, f]) => [
            k,
            { value: f.value, source: f.source, verified: f.verified },
          ]),
        ),
        warnings: result.warnings,
        errors: result.errors,
      },
    });
    return state.extracted;
  }

  /** The vendor's current statutory identity, for cross-checking a second
   *  document against the first. Both sources are consulted: a GSTIN extracted
   *  minutes ago is not on the vendor master yet — the vendor has not saved the
   *  step — but a PAN card uploaded next still has to agree with it. */
  async kycContext(
    vendorId: string,
  ): Promise<{ gstin: string | null; pan: string | null }> {
    const vendor = await this.prisma.client.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: { gstin: true, businessPan: true, pan: true },
    });
    const onboarding = await this.findOnboarding(vendorId);
    const extracted = ((onboarding?.wizardState as unknown as WizardState)?.extracted ??
      {}) as ExtractedFieldMap;
    return {
      gstin: vendor.gstin ?? extracted.gstin?.value ?? null,
      pan: vendor.businessPan ?? vendor.pan ?? extracted.businessPan?.value ?? null,
    };
  }

  /**
   * Rules a step body has to satisfy beyond its schema — the ones that need the
   * vendor's other data to judge.
   *
   *  - A field an authority verified cannot be quietly overwritten by typing.
   *    That is the whole point of verifying it: the vendor could previously
   *    "correct" an API-confirmed legal name into a typo and nobody would know.
   *    Editing one is not forbidden, it just has to go through the buyer.
   *  - PAN and GSTIN have to describe the same entity. Characters 3–12 of the
   *    GSTIN *are* the PAN, so a disagreement is arithmetic, not opinion.
   *  - Step 4 is only "done" once the mandatory documents are actually on file.
   */
  private async assertStepAcceptable(
    vendorId: string,
    vendor: { gstin: string | null; businessPan: string | null; pan: string | null },
    state: WizardState,
    stepNumber: number,
    stepData: SaveStepInput,
  ): Promise<void> {
    const payload = stepData as unknown as Record<string, unknown>;
    const extracted = state.extracted ?? {};

    for (const [key, verifiedField] of Object.entries(extracted)) {
      if (!verifiedField.verified) continue;
      const submitted = payload[key];
      if (typeof submitted !== 'string' || submitted.trim() === '') continue;
      if (submitted.trim().toUpperCase() === verifiedField.value.trim().toUpperCase()) {
        continue;
      }
      throw new VendorValidationError(
        `${key} is ${fieldSourceLabel(verifiedField.source).toLowerCase()} as ` +
          `"${verifiedField.value}" and cannot be changed here. If it is wrong, upload ` +
          'a corrected document or ask your buyer to raise a change request.',
        { field: key, verifiedValue: verifiedField.value, source: verifiedField.source },
      );
    }

    if (stepNumber === 1) {
      // Documents before typing. Everything on this step is *derivable* from
      // the GST certificate, and a value the vendor types is a value nobody can
      // check — which is the failure this whole flow exists to remove. There is
      // no way round it, because there would be nowhere to go: the same
      // documents are required to submit, so letting the form through early
      // would move the same stop later with unverified data saved behind it.
      const statutory = await this.missingStatutoryDocuments(vendorId);
      if (statutory.length > 0) {
        throw new VendorValidationError(
          `Upload your ${statutory
            .map(vendorDocumentLabel)
            .join(' and ')} first — we read your details off them so you do not ` +
            'have to type them.',
          { missing: statutory },
        );
      }

      const pan = typeof payload.businessPan === 'string' ? payload.businessPan : null;
      const gstin = vendor.gstin ?? extracted.gstin?.value ?? null;
      const mismatch = panGstinMismatch(pan, gstin);
      if (mismatch) throw new VendorValidationError(mismatch, { field: 'businessPan' });
    }

    if (stepNumber === 2) {
      const gstin = typeof payload.gstin === 'string' ? payload.gstin : null;
      const pan =
        vendor.businessPan ?? vendor.pan ?? extracted.businessPan?.value ?? null;
      const mismatch = panGstinMismatch(pan, gstin);
      if (mismatch) throw new VendorValidationError(mismatch, { field: 'gstin' });
    }

    if (stepNumber === 4) {
      const missing = await this.missingMandatoryDocuments(vendorId);
      if (missing.length > 0) {
        // The statutory pair is collected on step 1, so say so — otherwise this
        // reads as "upload something you cannot see a picker for".
        const fromStep1 = missing.filter((d) => ONBOARDING_STEP1_DOCUMENTS.includes(d));
        throw new VendorValidationError(
          `Upload ${missing.map(vendorDocumentLabel).join(' and ')} before saving this step.` +
            (fromStep1.length > 0
              ? ` The ${fromStep1
                  .map(vendorDocumentLabel)
                  .join(
                    ' and ',
                  )} can be uploaded here or on step 1, where they also fill in your company details.`
              : ''),
          { missing },
        );
      }
    }
  }

  /** Bank name resolved from the IFSC directory, stored with the same
   *  provenance shape as the GST/PAN fields so the wizard can badge and lock it. */
  private async recordBankProvenance(
    vendorId: string,
    bankName: string,
    branch: string | null,
  ): Promise<void> {
    const onboarding = await this.findOnboarding(vendorId);
    if (!onboarding) return;
    const state =
      (onboarding.wizardState as unknown as WizardState) ?? this.initialWizardState();
    state.extracted = {
      ...(state.extracted ?? {}),
      bankName: { value: bankName, source: 'IFSC_API', verified: true, confidence: 1 },
      ...(branch
        ? {
            bankBranch: {
              value: branch,
              source: 'IFSC_API' as const,
              verified: true,
              confidence: 1,
            },
          }
        : {}),
    };
    await this.prisma.client.vendorOnboarding.update({
      where: { id: onboarding.id },
      data: { wizardState: state as unknown as Prisma.InputJsonValue },
    });
  }

  /** IFSC → bank/branch, for the wizard to fill the read-only bank field as the
   *  vendor types. Returns null for an unknown code; the UI then asks them. */
  async lookupIfsc(ifsc: string): Promise<IfscDetails | null> {
    return this.ifsc.lookup(ifsc);
  }

  /** The step-1 statutory documents still outstanding. */
  private async missingStatutoryDocuments(
    vendorId: string,
  ): Promise<VendorDocumentType[]> {
    const docs = await this.prisma.client.vendorDocument.findMany({
      where: { vendorId, docType: { in: [...ONBOARDING_STEP1_DOCUMENTS] } },
      select: { docType: true },
    });
    const uploaded = new Set(docs.map((d) => d.docType));
    return ONBOARDING_STEP1_DOCUMENTS.filter((d) => !uploaded.has(d));
  }

  /** Mandatory documents the vendor has not uploaded yet. */
  private async missingMandatoryDocuments(
    vendorId: string,
  ): Promise<VendorDocumentType[]> {
    const docs = await this.prisma.client.vendorDocument.findMany({
      where: { vendorId },
      select: { docType: true },
    });
    const uploaded = new Set(docs.map((d) => d.docType));
    return ONBOARDING_MANDATORY_DOCUMENTS.filter((d) => !uploaded.has(d));
  }

  async submitOnboarding(userId: string): Promise<{ ok: true }> {
    const vendorId = await this.resolveVendorId(userId);
    const onboarding = await this.requireActiveOnboarding(vendorId);
    const vendor = await this.prisma.client.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      include: { documents: true },
    });
    const state = onboarding.wizardState as unknown as WizardState;

    // The portal hides Submit once a vendor is through or waiting on a review;
    // this is the same rule enforced server-side, for stale tabs and direct calls.
    if (!isOnboardingEditable(vendor.lifecycleStatus, onboarding)) {
      throw new VendorStateError(
        vendor.lifecycleStatus === 'ACTIVE'
          ? 'This vendor is already approved and active. Raise a change request to update the details.'
          : 'This onboarding has already been submitted and is awaiting review.',
        { lifecycleStatus: vendor.lifecycleStatus },
      );
    }

    // Guards.
    for (let step = 1; step <= ONBOARDING_STEP_COUNT; step += 1) {
      if (!state?.steps?.[`step${step}`]?.done) {
        throw new VendorValidationError(
          `Step ${step} (${ONBOARDING_STEP_NAMES[step - 1]}) is not complete.`,
          { step },
        );
      }
    }
    // One mandatory set for every category: the two statutory documents that
    // drive step 1's auto-fill, plus the two collected on step 4. Category
    // configs still list the extra certificates a buyer may want, but those are
    // chased during review rather than blocking the vendor's submission.
    const uploaded = new Set(vendor.documents.map((d) => d.docType));
    const missing = ONBOARDING_MANDATORY_DOCUMENTS.filter((d) => !uploaded.has(d));
    if (missing.length > 0) {
      throw new VendorValidationError(
        `Upload ${missing.map(vendorDocumentLabel).join(', ')} before submitting.`,
        { missing },
      );
    }
    // Last line of defence on the identity check. The wizard blocks a mismatch
    // step by step, but a vendor who saved a PAN before uploading the GST
    // certificate could otherwise still arrive here inconsistent.
    const identityMismatch = panGstinMismatch(
      vendor.businessPan ?? vendor.pan,
      vendor.gstin,
    );
    if (identityMismatch) {
      throw new VendorValidationError(identityMismatch, { field: 'businessPan' });
    }

    // Sanctions screening used to be triggered by saving the UBO step, which no
    // longer exists. It runs here instead — every category config requires it,
    // and submission is the last moment it can run before a reviewer sees the
    // file. A provider outage yields an ERROR screening for manual follow-up,
    // so this never blocks the vendor.
    await this.verification.runScreening(vendorId, 'SANCTIONS_OFAC', 'system');

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

  /**
   * Withdraw an invitation the vendor has not submitted yet — the way out of a
   * mistaken or duplicate invite. The vendor record is archived, never deleted
   * (§3 rule #10), and the magic link is burned: an accepted-but-duplicate
   * invitation must stop being able to reset the password on the login it
   * shares with the vendor's real record.
   *
   * `canRevokeAccess` is the caller's VENDOR_SUSPEND permission. Once the vendor
   * has set a password the invitation is no longer just a pending email — it is
   * a working login, and taking it away is revoking access, not undoing a typo.
   * So a Procurement Officer can clear up an unaccepted invite on their own, but
   * an accepted one needs an Admin / Procurement Head / MD.
   */
  async cancelOnboarding(
    onboardingId: string,
    input: CancelOnboardingInput,
    actorId: string,
    canRevokeAccess: boolean,
  ): Promise<{ ok: true }> {
    const onboarding = await this.prisma.client.vendorOnboarding.findUnique({
      where: { id: onboardingId },
      include: { vendor: { select: { id: true, name: true, lifecycleStatus: true } } },
    });
    if (!onboarding) throw new NotFoundException('Onboarding not found');
    if (onboarding.emailVerifiedAt && !canRevokeAccess) {
      throw new ForbiddenException(
        `${onboarding.vendor.name} has already set a password and can sign in, so this ` +
          'is a revocation of access rather than a cancelled invite. Ask an admin ' +
          '(or the procurement head) to do it.',
      );
    }
    if (onboarding.reviewDecision) {
      throw new VendorStateError(
        `This onboarding was already ${onboarding.reviewDecision.toLowerCase().replace(/_/g, ' ')}.`,
        { onboardingId, reviewDecision: onboarding.reviewDecision },
      );
    }
    if (onboarding.submittedAt) {
      throw new VendorStateError(
        'This application has already been submitted for review — reject it from the ' +
          'review screen instead of cancelling the invitation.',
        { onboardingId, submittedAt: onboarding.submittedAt.toISOString() },
      );
    }
    if (onboarding.vendor.lifecycleStatus === 'ACTIVE') {
      throw new VendorStateError(
        `${onboarding.vendor.name} is already an active vendor — suspend the vendor instead.`,
        { vendorId: onboarding.vendorId },
      );
    }

    await this.prisma.client.vendorOnboarding.update({
      where: { id: onboardingId },
      data: {
        reviewDecision: 'CANCELLED',
        reviewedBy: actorId,
        reviewNotes: input.reason,
        decisionAt: new Date(),
        // Burn the link and stop the clock — a withdrawn invite must not keep
        // ageing towards an SLA breach in the queue.
        selfRegistrationToken: null,
        tokenExpiresAt: new Date(),
        slaBreachAt: null,
        vendor: { update: { lifecycleStatus: 'ARCHIVED' } },
      },
    });
    await this.deactivateOrphanedVendorUser(onboarding.vendorId);
    await this.audit.record({
      action: 'ONBOARDING_CANCELLED',
      entityType: 'Vendor',
      entityId: onboarding.vendorId,
      actorId,
      before: { lifecycleStatus: onboarding.vendor.lifecycleStatus },
      after: { onboardingId, reason: input.reason, lifecycleStatus: 'ARCHIVED' },
    });
    await this.events.emit(VENDOR_EVENTS.ONBOARDING_CANCELLED, {
      vendorId: onboarding.vendorId,
      onboardingId,
      cancelledBy: actorId,
      reason: input.reason,
    });
    return { ok: true };
  }

  /**
   * Deactivate the auto-created login of a cancelled vendor — but only if no
   * other live vendor still uses that email. A duplicate invite reuses the
   * existing user (ensureVendorUser), so blindly deactivating here would lock
   * the vendor out of the record we actually want them to complete.
   */
  private async deactivateOrphanedVendorUser(vendorId: string): Promise<void> {
    const contact = await this.prisma.client.vendorContact.findFirst({
      where: { vendorId, isPrimary: true },
      select: { email: true },
    });
    if (!contact?.email) return;
    const stillInUse = await this.prisma.client.vendorContact.count({
      where: {
        email: { equals: contact.email, mode: 'insensitive' },
        vendorId: { not: vendorId },
        vendor: { lifecycleStatus: { not: 'ARCHIVED' } },
      },
    });
    if (stillInUse > 0) return;
    const user = await this.prisma.client.user.findFirst({
      where: { email: contact.email, isActive: true },
      select: { id: true, userRoles: { select: { role: { select: { name: true } } } } },
    });
    if (!user) return;
    // Only ever touch a pure vendor login. If the invite was addressed to an
    // email that also belongs to a staff account, deactivating it would lock a
    // colleague out of the buyer console.
    const vendorLoginOnly =
      user.userRoles.length > 0 &&
      user.userRoles.every((r) => r.role.name === 'VENDOR_USER');
    if (!vendorLoginOnly) return;
    await this.prisma.client.user.update({
      where: { id: user.id },
      data: { isActive: false },
    });
  }

  /**
   * Correct a vendor's name. The display name is a label and stays editable for
   * the life of the record; the legal entity name is what the PAN/GST checks
   * matched against, so once the vendor is activated it is frozen here and has
   * to move through the change-request approval path instead.
   */
  async renameVendor(
    vendorId: string,
    input: RenameVendorInput,
    actorId: string,
  ): Promise<{ ok: true }> {
    const vendor = await this.prisma.client.vendor.findUnique({
      where: { id: vendorId },
      select: {
        id: true,
        name: true,
        legalEntityName: true,
        activatedAt: true,
        lifecycleStatus: true,
      },
    });
    if (!vendor) throw new NotFoundException('Vendor not found');
    if (input.legalEntityName != null && vendor.activatedAt) {
      throw new VendorStateError(
        `${vendor.name} is already activated, so its registered legal name can only be ` +
          'changed through an approved change request. The display name can still be ' +
          'corrected here.',
        { vendorId, activatedAt: vendor.activatedAt.toISOString() },
      );
    }

    const name = input.name?.trim();
    const legalEntityName = input.legalEntityName?.trim();
    if (name === vendor.name && legalEntityName === vendor.legalEntityName) {
      return { ok: true };
    }
    await this.prisma.client.vendor.update({
      where: { id: vendorId },
      data: {
        ...(name == null ? {} : { name }),
        ...(legalEntityName == null ? {} : { legalEntityName }),
      },
    });
    await this.audit.record({
      action: 'VENDOR_RENAMED',
      entityType: 'Vendor',
      entityId: vendorId,
      actorId,
      before: { name: vendor.name, legalEntityName: vendor.legalEntityName },
      after: {
        name: name ?? vendor.name,
        legalEntityName: legalEntityName ?? vendor.legalEntityName,
        reason: input.reason ?? null,
      },
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
    await this.assertOnboardingComplete(vendor);
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

  /**
   * Refuse to activate a vendor who has not actually completed onboarding.
   *
   * `submitOnboarding` enforces all of this already, so under the normal flow
   * this never fires. It exists because activation has a second door: the
   * approval engine calls it on APPROVE, and the review screen offers that
   * button off a *prospective* approval chain — the preview of who would sign
   * off — which is drawn before the vendor has typed anything. An officer could
   * therefore activate a 0%-complete vendor with no GSTIN, no bank account and
   * no documents, and nothing objected. A vendor record in that state goes on to
   * receive purchase orders and raise invoices.
   *
   * Vendors with no onboarding at all (seeded, or migrated from before the
   * wizard) are left alone — there is nothing to have completed.
   */
  private async assertOnboardingComplete(vendor: {
    id: string;
    name: string;
    documents: { docType: string }[];
  }): Promise<void> {
    const onboarding = await this.findOnboarding(vendor.id);
    if (!onboarding) return;
    const state = onboarding.wizardState as unknown as WizardState | null;

    if (!onboarding.submittedAt) {
      const pct = state?.completionPct ?? 0;
      throw new VendorStateError(
        `${vendor.name} has not submitted their onboarding yet (${pct}% complete), so ` +
          'there is nothing to approve. They are notified when it is their turn; use ' +
          'Return for info if you need to prompt them.',
        { vendorId: vendor.id, completionPct: pct },
      );
    }

    const incomplete: string[] = [];
    for (let step = 1; step <= ONBOARDING_STEP_COUNT; step += 1) {
      if (!state?.steps?.[`step${step}`]?.done) {
        incomplete.push(`${step}. ${ONBOARDING_STEP_NAMES[step - 1]}`);
      }
    }
    if (incomplete.length > 0) {
      throw new VendorStateError(
        `Cannot activate ${vendor.name} — these wizard steps are not complete: ${incomplete.join(', ')}.`,
        { vendorId: vendor.id, incomplete },
      );
    }

    const uploaded = new Set(vendor.documents.map((d) => d.docType));
    const missing = ONBOARDING_MANDATORY_DOCUMENTS.filter((d) => !uploaded.has(d));
    if (missing.length > 0) {
      throw new VendorStateError(
        `Cannot activate ${vendor.name} — missing ${missing.map(vendorDocumentLabel).join(', ')}.`,
        { vendorId: vendor.id, missing },
      );
    }

    // A bank account whose holder name the bank did not confirm is the one field
    // on this record that moves money. It was being stored with the failed match
    // and shown to nobody, so activation proceeded and the first payment run
    // discovered it. Either the buyer accepts it in writing, or it does not pass.
    const bank = await this.prisma.client.vendorBank.findFirst({
      where: { vendorId: vendor.id, isArchived: false },
    });
    if (bank && !bank.isVerified && !bank.manualOverrideReason) {
      throw new VendorStateError(
        `Cannot activate ${vendor.name} — the bank could not confirm "${bank.holderName}" ` +
          `holds account ••••${bank.accountNoEncrypted.slice(-4)}` +
          (bank.pennyDropNameReturned
            ? ` (it returned "${bank.pennyDropNameReturned}")`
            : '') +
          '. Check the cancelled cheque and either accept the account with a reason, or ' +
          'return the onboarding for corrected bank details.',
        {
          vendorId: vendor.id,
          holderName: bank.holderName,
          returnedName: bank.pennyDropNameReturned,
          nameMatchScore: bank.nameMatchScore ? Number(bank.nameMatchScore) : null,
        },
      );
    }
  }

  /**
   * A buyer accepts a bank account the penny drop could not confirm — after
   * eyeballing the cancelled cheque, which is the document that settles it. The
   * reason is stored on the account and audited: this is the record of who let
   * an unverified payment destination through, and why.
   */
  async overrideBankVerification(
    vendorId: string,
    reason: string,
    actorId: string,
  ): Promise<{ ok: true }> {
    const bank = await this.prisma.client.vendorBank.findFirst({
      where: { vendorId, isArchived: false },
    });
    if (!bank) throw new NotFoundException('No bank account on file for this vendor');
    await this.prisma.client.vendorBank.update({
      where: { id: bank.id },
      data: { manualOverrideReason: reason, overriddenBy: actorId },
    });
    await this.audit.record({
      action: 'VENDOR_BANK_OVERRIDE',
      entityType: 'Vendor',
      entityId: vendorId,
      actorId,
      before: {
        isVerified: bank.isVerified,
        nameMatchScore: bank.nameMatchScore ? Number(bank.nameMatchScore) : null,
        pennyDropNameReturned: bank.pennyDropNameReturned,
      },
      after: { manualOverrideReason: reason },
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
          // The display name follows the trade name once we have it from the
          // certificate: the buyer's invite label was their best guess at who
          // they were writing to, and GSTN's trade name is what the business
          // actually calls itself. The legal name is left alone — it is what the
          // PAN and penny-drop checks match against.
          ...(s.tradeName?.trim() ? { name: s.tradeName.trim() } : {}),
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
      // The bank is a property of the IFSC, not an opinion. Resolving it here
      // ends the "HDFC" / "HDFC Bank Ltd" / "hdfc bank" spread that made vendor
      // bank names impossible to reconcile against a statement — and a code the
      // directory does not know is the one case where the vendor's own typing
      // is still needed.
      const directory = await this.ifsc.lookup(s.ifsc);
      const bankName = directory?.bank ?? s.bankName?.trim();
      if (!bankName) {
        throw new VendorValidationError(
          `We could not identify a bank from IFSC ${s.ifsc}. Check the code, or ` +
            'enter your bank name and branch so your buyer can confirm it.',
          { field: 'ifsc' },
        );
      }
      await this.prisma.client.vendorBank.deleteMany({ where: { vendorId } });
      await this.prisma.client.vendorBank.create({
        data: {
          id: newId('vendorBank'),
          tenantId,
          vendorId,
          bankName,
          accountNoEncrypted: `enc:xxxx${s.accountNumber.slice(-4)}`,
          ifsc: s.ifsc,
          holderName: s.holderName,
        },
      });
      // Remember where the name came from, so the field shows the same badge on
      // return as the ones filled from the GST certificate.
      if (directory) {
        await this.recordBankProvenance(vendorId, bankName, directory.branch);
      }
    }
    // Step 4 stores nothing of its own: the documents were persisted by the
    // upload endpoint as the vendor picked them, and saving the step only
    // asserts they are complete (enforced in assertStepAcceptable).
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
    }
  }

  /**
   * Stops the same vendor being invited twice. The two checks fail differently,
   * so they are enforced differently:
   *
   *  - **Contact email already on a live vendor → hard block.** `ensureVendorUser`
   *    reuses an existing login, so a second vendor record would share one
   *    account: `resolveVendorId` then picks between them arbitrarily, the vendor
   *    can only ever fill in whichever it picked, and the second invitation link
   *    resets the password they already set from the first. Never overridable.
   *  - **Legal entity name closely matching a live vendor → soft block.** That
   *    can legitimately be a different entity sharing a shopfront name, so the
   *    officer can confirm and re-send with `allowDuplicate`.
   */
  private async assertNoDuplicateInvite(input: InviteVendorInput): Promise<void> {
    const contacts = await this.prisma.client.vendorContact.findMany({
      where: { email: { equals: input.email.trim(), mode: 'insensitive' } },
      select: { vendor: { select: DUPLICATE_CANDIDATE_SELECT } },
    });
    const byEmail = contacts
      .map((c) => c.vendor)
      .find((v) => !REINVITABLE_STATUSES.has(v.lifecycleStatus));
    if (byEmail) {
      throw new DuplicateVendorError(
        byEmail.lifecycleStatus === 'BLACKLISTED'
          ? `${byEmail.name} (${byEmail.code}) is blacklisted — this contact cannot be invited.`
          : `${input.email} is already the contact for ${byEmail.name} (${byEmail.code}). ` +
              'Resend that invitation or add the category to the existing vendor — a second ' +
              'record would share the same vendor login.',
        await this.duplicateContext(byEmail, 'EMAIL', false),
      );
    }

    if (input.allowDuplicate) return;
    const candidates = await this.prisma.client.vendor.findMany({
      where: { lifecycleStatus: { not: 'ARCHIVED' } },
      select: DUPLICATE_CANDIDATE_SELECT,
      orderBy: { createdAt: 'desc' },
      take: NAME_SCAN_LIMIT,
    });
    let best: { vendor: DuplicateCandidate; score: number } | null = null;
    for (const v of candidates) {
      // Compare against both the registered name and the display name: the
      // duplicate is usually typed as whichever one the officer remembers.
      const score = Math.max(
        compareNames(input.legalEntityName, v.legalEntityName ?? v.name).score,
        compareNames(input.legalEntityName, v.name).score,
      );
      if (score >= NAME_DUPLICATE_THRESHOLD && (!best || score > best.score)) {
        best = { vendor: v, score };
      }
    }
    if (best) {
      throw new DuplicateVendorError(
        `${best.vendor.name} (${best.vendor.code}) already exists with a very similar name. ` +
          'Check it is not the same vendor — if it really is a different entity, confirm to invite anyway.',
        await this.duplicateContext(best.vendor, 'NAME', true, best.score),
      );
    }
  }

  /** The existing record, shaped so the invite dialog can link to it and decide
   *  whether to offer an "invite anyway" button. */
  private async duplicateContext(
    vendor: DuplicateCandidate,
    matchType: 'EMAIL' | 'NAME',
    overridable: boolean,
    matchScore?: number,
  ): Promise<Record<string, unknown>> {
    const onboarding = await this.prisma.client.vendorOnboarding.findFirst({
      where: { vendorId: vendor.id },
      orderBy: { startedAt: 'desc' },
      select: { id: true, submittedAt: true, reviewDecision: true },
    });
    return {
      matchType,
      overridable,
      ...(matchScore == null ? {} : { matchScore }),
      existingVendorId: vendor.id,
      existingVendorCode: vendor.code,
      existingVendorName: vendor.name,
      existingLifecycleStatus: vendor.lifecycleStatus,
      existingOnboardingId: onboarding?.id ?? null,
      existingOnboardingSubmitted: !!onboarding?.submittedAt,
    };
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
    // An email can end up on more than one vendor record (a duplicate invite
    // that predates the invite guard). Skip archived records — that is what a
    // cancelled duplicate becomes — and break any remaining tie on the oldest
    // record, so the vendor lands on the same one on every request instead of
    // whichever row the planner happened to return first.
    const contact =
      (await this.prisma.client.vendorContact.findFirst({
        where: { email: user.email, vendor: { lifecycleStatus: { not: 'ARCHIVED' } } },
        orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }],
        select: { vendorId: true },
      })) ??
      (await this.prisma.client.vendorContact.findFirst({
        where: { email: user.email },
        orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }],
        select: { vendorId: true },
      }));
    if (!contact) throw new ForbiddenException('No vendor linked to this account');
    return contact.vendorId;
  }

  /** The vendor's latest onboarding, or null — for callers that can carry on
   *  without one. `requireActiveOnboarding` is the throwing version. */
  private async findOnboarding(
    vendorId: string,
  ): Promise<Prisma.VendorOnboardingGetPayload<Record<string, never>> | null> {
    return this.prisma.client.vendorOnboarding.findFirst({
      where: { vendorId },
      orderBy: { startedAt: 'desc' },
    });
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
    // Cancellation nulls the token, so this is belt-and-braces: a withdrawn
    // invitation must never be acceptable, however the link is replayed.
    if (onboarding.reviewDecision === 'CANCELLED') {
      throw new InvalidTokenError('This invitation was withdrawn.');
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

/**
 * May the vendor still change this onboarding and submit it?
 *
 * No once they are ACTIVE — a re-submission would drop lifecycle_status back to
 * UNDER_REVIEW and silently disqualify an approved vendor from new POs, while
 * their legacy `status` still read ACTIVE. Approved vendors change their record
 * through the change-request flow instead.
 *
 * No while a submission is awaiting a decision. RETURNED_FOR_INFO is the one
 * decision that deliberately hands the wizard back, so that reopens editing.
 */
export function isOnboardingEditable(
  lifecycleStatus: string,
  onboarding: { submittedAt: Date | null; reviewDecision: string | null },
): boolean {
  if (lifecycleStatus === 'ACTIVE') return false;
  if (!onboarding.submittedAt) return true;
  return onboarding.reviewDecision === 'RETURNED_FOR_INFO';
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
