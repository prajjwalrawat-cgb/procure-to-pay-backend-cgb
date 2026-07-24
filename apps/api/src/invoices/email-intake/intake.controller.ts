import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CompleteManualEntrySchema,
  EmailInboundPayloadSchema,
  InboundEmailQuerySchema,
  PERMISSIONS,
  ResolveVendorMatchSchema,
  type CompleteManualEntry,
  type EmailIngestResult,
  type EmailInboundPayload,
  type InboundEmailListResponse,
  type InboundEmailQuery,
  type ResolveVendorMatch,
} from '@procureflow/shared';

import type { AuthUser } from '../../auth/auth.types';
import { CurrentUser, Public, RequirePermission } from '../../auth/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { Env } from '../../config/env';
import { InvoiceService } from '../invoice.service';
import { EmailIntakeService } from './email-intake.service';

/**
 * Invoice intake endpoints (Slice 10a): the inbound-email webhook + the AP review
 * queues (PENDING_VENDOR_MATCH, DEAD_LETTER) + the manual data-entry fallback for
 * low-confidence / failed OCR.
 */
@Controller()
export class IntakeController {
  constructor(
    private readonly intake: EmailIntakeService,
    private readonly invoices: InvoiceService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Inbound-email webhook — called by the email provider (SendGrid/Mailgun) with
   * a parsed message. Public (no JWT) but authenticated by a shared secret the
   * provider signs requests with. The provider's per-tenant route encodes the
   * tenantId in the path.
   */
  @Public()
  @Post('integrations/email/inbound/:tenantId')
  async inbound(
    @Param('tenantId') tenantId: string,
    @Headers('x-webhook-secret') secret: string | undefined,
    @Body(new ZodValidationPipe(EmailInboundPayloadSchema)) payload: EmailInboundPayload,
  ): Promise<EmailIngestResult> {
    const expected = this.config.get('EMAIL_INBOUND_WEBHOOK_SECRET', { infer: true });
    if (!secret || secret !== expected) {
      throw new UnauthorizedException('Invalid inbound-email webhook secret');
    }
    return this.intake.ingest(tenantId, payload);
  }

  @Get('invoices/inbound-emails')
  @RequirePermission(PERMISSIONS.INVOICE_INTAKE_MANAGE)
  async list(
    @Query(new ZodValidationPipe(InboundEmailQuerySchema)) q: InboundEmailQuery,
  ): Promise<InboundEmailListResponse> {
    return this.intake.list(q);
  }

  @Post('invoices/inbound-emails/:id/resolve')
  @RequirePermission(PERMISSIONS.INVOICE_INTAKE_MANAGE)
  async resolve(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ResolveVendorMatchSchema)) dto: ResolveVendorMatch,
  ): Promise<EmailIngestResult> {
    return this.intake.resolveVendorMatch(id, dto.vendorId, user.userId);
  }

  @Post('invoices/:id/complete-manual-entry')
  @RequirePermission(PERMISSIONS.INVOICE_INTAKE_MANAGE)
  async completeManualEntry(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CompleteManualEntrySchema)) dto: CompleteManualEntry,
  ): Promise<{ ok: true }> {
    return this.invoices.completeManualEntry(
      id,
      {
        vendorInvoiceRef: dto.vendorInvoiceRef,
        invoiceDate: dto.invoiceDate,
        lines: dto.lines,
      },
      user.userId,
    );
  }
}
