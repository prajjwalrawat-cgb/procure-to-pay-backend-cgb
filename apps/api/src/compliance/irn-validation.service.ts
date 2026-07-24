import { Injectable, NotFoundException } from '@nestjs/common';
import type { IrnValidationResult } from '@procureflow/shared';
import Decimal from 'decimal.js';

import { AuditLogService } from '../audit/audit.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { GspClient } from '../integrations/gsp/gsp-client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * IrnValidationService (Slice 10a). Validates an invoice's IRN authenticity via
 * the GSP-mediated NIC IRP (simulator until a GSP contract lands). Only applies
 * to invoices from vendors above the tenant's e-invoicing turnover threshold
 * (tenant-config, not a code constant — §9). Degrades gracefully: a provider
 * outage yields PENDING_VERIFICATION, never blocks the invoice.
 */
@Injectable()
export class IrnValidationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gsp: GspClient,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
  ) {}

  async validateForInvoice(invoiceId: string): Promise<IrnValidationResult> {
    const inv = await this.prisma.client.invoice.findUnique({
      where: { id: invoiceId },
      include: { vendor: { select: { annualTurnoverDeclared: true } } },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    const tenant = await this.prisma.client.tenant.findUnique({
      where: { id: inv.tenantId },
      select: { einvoiceTurnoverThreshold: true },
    });
    const threshold = new Decimal(
      tenant?.einvoiceTurnoverThreshold?.toString() ?? '50000000',
    );
    const turnover = inv.vendor?.annualTurnoverDeclared
      ? new Decimal(inv.vendor.annualTurnoverDeclared.toString())
      : new Decimal(0);
    const required = turnover.greaterThanOrEqualTo(threshold);

    let result: IrnValidationResult;
    if (!required) {
      result = {
        invoiceId,
        status: 'NOT_REQUIRED',
        required: false,
        irn: inv.irn,
        detail: 'IRN not required — vendor turnover is below the e-invoicing threshold.',
        simulated: true,
      };
    } else if (!inv.irn) {
      result = {
        invoiceId,
        status: 'PENDING_VERIFICATION',
        required: true,
        irn: null,
        detail: 'IRN is required for this vendor but none was captured.',
        simulated: true,
      };
    } else {
      try {
        const check = await this.gsp.validateIrn(inv.irn, inv.tenantId);
        result = {
          invoiceId,
          status: check.valid ? 'VALID' : 'INVALID',
          required: true,
          irn: inv.irn,
          detail: check.detail,
          simulated: true,
        };
      } catch {
        result = {
          invoiceId,
          status: 'PENDING_VERIFICATION',
          required: true,
          irn: inv.irn,
          detail: 'IRP unreachable — verification deferred (circuit open).',
          simulated: true,
        };
      }
    }

    await this.audit.record({
      action: 'invoice.irn_validated',
      entityType: 'Invoice',
      entityId: invoiceId,
      actorType: 'SYSTEM',
      after: { status: result.status, required: result.required },
    });
    await this.events.emit('IrnValidated', { invoiceId, status: result.status });
    return result;
  }
}
