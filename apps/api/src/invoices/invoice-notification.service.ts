import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env';
import { MailService } from '../common/mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Emails the vendor about decisions on their invoices.
 *
 * A rejection the vendor only learns about by opening the portal is one they
 * learn about late — the reason sits on the list until somebody happens to
 * look, and the PO waits for an invoice nobody knows to resend.
 */
@Injectable()
export class InvoiceNotificationService {
  private readonly logger = new Logger(InvoiceNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Never throws into the rejection: the invoice is already REJECTED and the
   * reason is on the portal, so a mail failure is logged rather than undoing
   * the decision. Every lookup happens before the send is handed off, because
   * the request's tenant transaction closes once the response is written.
   */
  async invoiceRejected(invoiceId: string): Promise<void> {
    try {
      const inv = await this.prisma.client.invoice.findUnique({
        where: { id: invoiceId },
        select: {
          tenantId: true,
          vendorId: true,
          vendorInvoiceRef: true,
          grossAmount: true,
          rejectionReason: true,
          po: { select: { id: true, number: true } },
          vendor: { select: { name: true } },
          tenant: { select: { name: true } },
        },
      });
      if (!inv) return;

      const recipients = await this.recipients(inv.tenantId, inv.vendorId);
      if (recipients.length === 0) {
        this.logger.warn(`Invoice ${invoiceId} rejected but its vendor has no contact email`);
        return;
      }

      const buyer = inv.tenant.name;
      const base = this.config.get('APP_BASE_URL', { infer: true });
      const listLink = `${base}/vendor/invoices`;
      const resubmitLink = inv.po
        ? `${base}/vendor/invoices/submit?po=${encodeURIComponent(inv.po.id)}`
        : listLink;
      const amount = Number(inv.grossAmount.toString()).toLocaleString('en-IN', {
        style: 'currency',
        currency: 'INR',
      });
      const reason = inv.rejectionReason ?? 'No reason given.';
      const poText = inv.po ? ` against ${inv.po.number}` : '';

      const subject = `Invoice ${inv.vendorInvoiceRef} rejected by ${buyer}`;
      const text =
        `Hello ${inv.vendor.name},\n\n` +
        `${buyer} has rejected your invoice ${inv.vendorInvoiceRef}${poText} (${amount}).\n\n` +
        `Reason: ${reason}\n\n` +
        (inv.po
          ? `The quantity on ${inv.po.number} has been released. Correct the invoice and ` +
            `submit it again here — the same invoice number can be reused:\n${resubmitLink}\n\n`
          : `Correct the invoice and submit it again from the vendor portal:\n${listLink}\n\n`) +
        `You can see all your invoices and their status at ${listLink}`;
      const html =
        `<p>Hello ${escapeHtml(inv.vendor.name)},</p>` +
        `<p><strong>${escapeHtml(buyer)}</strong> has rejected your invoice ` +
        `<strong>${escapeHtml(inv.vendorInvoiceRef)}</strong>` +
        (inv.po ? ` against <strong>${escapeHtml(inv.po.number)}</strong>` : '') +
        ` (${escapeHtml(amount)}).</p>` +
        `<p style="padding:12px;background:#fdecec;border-radius:4px"><strong>Reason:</strong> ` +
        `${escapeHtml(reason)}</p>` +
        (inv.po
          ? `<p>The quantity on ${escapeHtml(inv.po.number)} has been released. ` +
            `<a href="${resubmitLink}">Correct the invoice and submit it again</a> — ` +
            `the same invoice number can be reused.</p>`
          : `<p><a href="${listLink}">Correct the invoice and submit it again</a> ` +
            `from the vendor portal.</p>`) +
        `<p style="color:#888;font-size:12px">See all your invoices at ` +
        `<a href="${listLink}">${listLink}</a>.</p>`;

      // Fire-and-forget: a real SMTP round-trip can outlast the request's RLS
      // transaction budget, and the rejection has already been committed.
      for (const to of recipients) {
        void this.mail
          .send({ to, subject, text, html })
          .catch((e: unknown) =>
            this.logger.error(`Rejection email for ${invoiceId} to ${to} failed`, e as Error),
          );
      }
    } catch (err) {
      this.logger.error(`Could not prepare rejection email for ${invoiceId}`, err as Error);
    }
  }

  /**
   * The vendor's people who use the portal — the ones who submit invoices and
   * can act on a rejection. Falls back to the primary contact for a vendor
   * whose invoices reach us some other way (email intake, buyer upload).
   */
  private async recipients(tenantId: string, vendorId: string): Promise<string[]> {
    const contacts = await this.prisma.client.vendorContact.findMany({
      where: { vendorId, email: { not: null } },
      select: { email: true, isPrimary: true },
    });
    const emails = contacts.map((c) => c.email!).filter(Boolean);
    if (emails.length === 0) return [];
    const portalUsers = await this.prisma.client.user.findMany({
      where: { tenantId, email: { in: emails }, isActive: true },
      select: { email: true },
    });
    const chosen = portalUsers.length
      ? portalUsers.map((u) => u.email)
      : contacts.filter((c) => c.isPrimary).map((c) => c.email!);
    return [...new Set(chosen.map((e) => e.toLowerCase()))];
  }
}

/** Minimal HTML-escaping for interpolated values in outbound email bodies. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
