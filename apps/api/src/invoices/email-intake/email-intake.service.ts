import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '@procureflow/db';
import type {
  EmailIngestResult,
  EmailInboundPayload,
  InboundEmailListResponse,
  InboundEmailQuery,
} from '@procureflow/shared';

import { AuditLogService } from '../../audit/audit.service';
import { DomainEventService } from '../../common/events/domain-event.service';
import { StorageService } from '../../common/storage/storage.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InvoiceService } from '../invoice.service';

const INVOICE_MIME = /^(application\/pdf|image\/(png|jpe?g|tiff))$/i;

/**
 * EmailIntakeService (Slice 10a). Turns a parsed inbound email (from the email
 * provider's webhook — SendGrid/Mailgun Inbound Parse) into an invoice through
 * the SAME `createFromUpload` path as portal/manual submission — no divergent
 * invoice-creation logic. Sender validation is a fraud control: unrecognised
 * senders are quarantined in PENDING_VENDOR_MATCH, never silently attached; a
 * malformed message goes to a DEAD_LETTER queue with the original preserved.
 */
@Injectable()
export class EmailIntakeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly invoices: InvoiceService,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
  ) {}

  async ingest(
    tenantId: string,
    payload: EmailInboundPayload,
  ): Promise<EmailIngestResult> {
    return this.prisma.runInTenantContext(tenantId, async () => {
      const id = newId('inboundEmail');
      const fromDomain = payload.from.split('@')[1]?.toLowerCase() ?? '';

      // Persist the raw body for audit reference (as an EMAIL_BODY doc later).
      const bodyKey = `tenants/${tenantId}/inbound-email/${id}/body.txt`;
      await this.storage
        .put(bodyKey, Buffer.from(payload.text ?? '', 'utf8'), 'text/plain')
        .catch(() => bodyKey);

      // Malformed: no usable invoice attachment → dead-letter.
      const attach = payload.attachments.find((a) => INVOICE_MIME.test(a.mimeType));
      if (payload.attachments.length === 0) {
        return this.deadLetter(
          id,
          tenantId,
          payload,
          fromDomain,
          bodyKey,
          'NO_ATTACHMENT',
        );
      }
      if (!attach) {
        return this.deadLetter(
          id,
          tenantId,
          payload,
          fromDomain,
          bodyKey,
          'UNSUPPORTED_FILE_TYPE',
        );
      }
      let attachmentBuf: Buffer;
      try {
        attachmentBuf = Buffer.from(attach.contentBase64, 'base64');
        if (attachmentBuf.length === 0) throw new Error('empty');
      } catch {
        return this.deadLetter(
          id,
          tenantId,
          payload,
          fromDomain,
          bodyKey,
          'CORRUPT_ATTACHMENT',
        );
      }
      const attachKey = `tenants/${tenantId}/inbound-email/${id}/${attach.filename}`;
      await this.storage
        .put(attachKey, attachmentBuf, attach.mimeType)
        .catch(() => attachKey);

      // Sender validation (fraud control): match domain against Vendor.emailDomains.
      const vendor = await this.prisma.client.vendor.findFirst({
        where: { emailDomains: { has: fromDomain }, status: 'ACTIVE' },
        select: { id: true },
      });

      if (!vendor) {
        return this.pendingVendorMatch(
          id,
          tenantId,
          payload,
          fromDomain,
          bodyKey,
          attachKey,
          attach.filename,
        );
      }

      const invoiceId = await this.createInvoiceFromInbound(
        tenantId,
        vendor.id,
        attachKey,
        bodyKey,
        payload.subject ?? '',
      );
      await this.prisma.client.inboundEmail.create({
        data: {
          id,
          tenantId,
          fromEmail: payload.from,
          fromDomain,
          subject: payload.subject ?? null,
          status: 'INVOICE_CREATED',
          matchedVendorId: vendor.id,
          invoiceId,
          bodyS3Key: bodyKey,
          attachmentS3Key: attachKey,
          attachmentName: attach.filename,
          providerMessageId: payload.providerMessageId ?? null,
        },
      });
      await this.emitReceived(id, payload.from, 'INVOICE_CREATED', invoiceId, tenantId);
      return { inboundEmailId: id, status: 'INVOICE_CREATED', invoiceId, reason: null };
    });
  }

  /** AP attributes a quarantined email to a vendor → creates the invoice. */
  async resolveVendorMatch(
    inboundEmailId: string,
    vendorId: string,
    actorId: string,
  ): Promise<EmailIngestResult> {
    const row = await this.prisma.client.inboundEmail.findUnique({
      where: { id: inboundEmailId },
    });
    if (!row) throw new NotFoundException('Inbound email not found');
    if (row.status !== 'PENDING_VENDOR_MATCH') {
      throw new ForbiddenException('This email is not awaiting vendor attribution.');
    }
    const invoiceId = await this.createInvoiceFromInbound(
      row.tenantId,
      vendorId,
      row.attachmentS3Key!,
      row.bodyS3Key,
      row.subject ?? '',
    );
    await this.prisma.client.inboundEmail.update({
      where: { id: inboundEmailId },
      data: {
        status: 'INVOICE_CREATED',
        matchedVendorId: vendorId,
        invoiceId,
        resolvedBy: actorId,
        resolvedAt: new Date(),
      },
    });
    await this.audit.record({
      action: 'inbound_email.vendor_matched',
      entityType: 'InboundEmail',
      entityId: inboundEmailId,
      actorId,
      after: { vendorId, invoiceId },
    });
    return { inboundEmailId, status: 'INVOICE_CREATED', invoiceId, reason: null };
  }

  async list(query: InboundEmailQuery): Promise<InboundEmailListResponse> {
    const where = query.status ? { status: query.status } : {};
    const take = query.limit;
    const rows = await this.prisma.client.inboundEmail.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
    });
    const page = rows.slice(0, take);
    const [pvm, dl] = await Promise.all([
      this.prisma.client.inboundEmail.count({
        where: { status: 'PENDING_VENDOR_MATCH' },
      }),
      this.prisma.client.inboundEmail.count({ where: { status: 'DEAD_LETTER' } }),
    ]);
    return {
      items: page.map((r) => ({
        id: r.id,
        fromEmail: r.fromEmail,
        fromDomain: r.fromDomain,
        subject: r.subject,
        status: r.status,
        matchedVendorId: r.matchedVendorId,
        invoiceId: r.invoiceId,
        attachmentName: r.attachmentName,
        deadLetterReason: r.deadLetterReason,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null,
      counts: { pending_vendor_match: pvm, dead_letter: dl },
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async createInvoiceFromInbound(
    tenantId: string,
    vendorId: string,
    attachKey: string,
    bodyKey: string | null,
    subject: string,
  ): Promise<string> {
    const invoiceId = await this.invoices.createFromUpload(tenantId, 'system', {
      vendorId,
      vendorInvoiceRef: subject.slice(0, 60),
      s3Key: attachKey,
      source: 'EMAIL',
    });
    // Keep the raw email body attached for audit reference (doc_type EMAIL_BODY).
    if (bodyKey) {
      await this.prisma.client.invoiceAttachment.create({
        data: {
          id: newId('invoiceAttachment'),
          tenantId,
          invoiceId,
          s3Key: bodyKey,
          mimeType: 'text/plain',
          sizeBytes: 0,
          docType: 'EMAIL_BODY',
        },
      });
    }
    return invoiceId;
  }

  private async pendingVendorMatch(
    id: string,
    tenantId: string,
    payload: EmailInboundPayload,
    fromDomain: string,
    bodyKey: string,
    attachKey: string,
    attachName: string,
  ): Promise<EmailIngestResult> {
    await this.prisma.client.inboundEmail.create({
      data: {
        id,
        tenantId,
        fromEmail: payload.from,
        fromDomain,
        subject: payload.subject ?? null,
        status: 'PENDING_VENDOR_MATCH',
        bodyS3Key: bodyKey,
        attachmentS3Key: attachKey,
        attachmentName: attachName,
        providerMessageId: payload.providerMessageId ?? null,
      },
    });
    await this.emitReceived(id, payload.from, 'PENDING_VENDOR_MATCH', null, tenantId);
    return {
      inboundEmailId: id,
      status: 'PENDING_VENDOR_MATCH',
      invoiceId: null,
      reason: null,
    };
  }

  private async deadLetter(
    id: string,
    tenantId: string,
    payload: EmailInboundPayload,
    fromDomain: string,
    bodyKey: string,
    reason: string,
  ): Promise<EmailIngestResult> {
    await this.prisma.client.inboundEmail.create({
      data: {
        id,
        tenantId,
        fromEmail: payload.from,
        fromDomain,
        subject: payload.subject ?? null,
        status: 'DEAD_LETTER',
        bodyS3Key: bodyKey,
        deadLetterReason: reason,
        providerMessageId: payload.providerMessageId ?? null,
      },
    });
    await this.emitReceived(id, payload.from, 'DEAD_LETTER', null, tenantId);
    return { inboundEmailId: id, status: 'DEAD_LETTER', invoiceId: null, reason };
  }

  private async emitReceived(
    id: string,
    fromEmail: string,
    status: string,
    invoiceId: string | null,
    tenantId: string,
  ): Promise<void> {
    await this.audit.record({
      action: 'inbound_email.received',
      entityType: 'InboundEmail',
      entityId: id,
      actorType: 'SYSTEM',
      after: { fromEmail, status },
      tenantId,
    });
    await this.events.emit(
      'InboundEmailReceived',
      { inboundEmailId: id, fromEmail, status, invoiceId },
      tenantId,
    );
  }
}
