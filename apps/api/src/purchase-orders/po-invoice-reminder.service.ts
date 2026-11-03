import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PoStatus } from '@procureflow/db';
import { ROLES } from '@procureflow/shared';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import { PinoLogger } from 'nestjs-pino';

import { NotificationService } from '../approvals/notification.service';
import { MailService } from '../common/mail/mail.service';
import {
  SCHEDULER_DRAIN_DELAY_SECONDS,
  guardBullMq,
  scheduleRepeatable,
  schedulersDisabled,
} from '../common/queue/queue-guard';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

export const PO_INVOICE_REMINDER_QUEUE = 'po-invoice-reminder';

/** Days a PO may sit with the vendor before anyone is chased about its invoice. */
export const NO_INVOICE_REMINDER_DAYS = 5;

export const PO_NO_INVOICE_NOTIFICATION = 'PO_NO_INVOICE';

/**
 * Statuses where the PO is with the vendor and an invoice is expected. DRAFT and
 * approval states have not left the building; ON_HOLD, CLOSED and CANCELLED are
 * not waiting on anyone; (PARTIALLY_)INVOICED already has one.
 */
const AWAITING_INVOICE_STATUSES: PoStatus[] = [
  'ISSUED',
  'ACKNOWLEDGED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
];

interface StalePo {
  id: string;
  number: string;
  vendorName: string;
  totalAmount: string;
  currency: string;
  issuedAt: Date;
  daysWaiting: number;
}

interface ReminderEmail {
  to: string;
  name: string;
  tenantName: string;
  pos: StalePo[];
}

/**
 * PoInvoiceReminderService. A daily BullMQ job that finds issued POs which have
 * gone {@link NO_INVOICE_REMINDER_DAYS} days without an invoice and tells the
 * buyer who raised the PO and the finance officers — an in-app notification per
 * PO, and one digest email per person so finance is not sent a mail per order.
 *
 * Each person is reminded once per PO: the PO_NO_INVOICE notification row is
 * the record that the reminder went out. An invoice that was rejected does not
 * count as one uploaded, so the PO is chased again until a live one arrives.
 * Mirrors VendorMaintenanceService; `sweepAll` is Redis-free and unit-tested.
 */
@Injectable()
export class PoInvoiceReminderService implements OnModuleInit, OnModuleDestroy {
  private connection?: IORedis;
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly mail: MailService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PoInvoiceReminderService.name);
  }

  onModuleInit(): void {
    if (schedulersDisabled(this.config)) return;
    this.connection = new IORedis(this.config.get('REDIS_URL', { infer: true }), {
      maxRetriesPerRequest: null,
    });
    const conn = this.connection as unknown as ConnectionOptions;
    this.queue = new Queue(PO_INVOICE_REMINDER_QUEUE, { connection: conn });
    // Daily at 09:00 IST, so the mail is waiting at the start of the working day.
    scheduleRepeatable(
      PO_INVOICE_REMINDER_QUEUE,
      this.queue,
      'daily',
      {
        repeat: { pattern: '0 9 * * *', tz: 'Asia/Kolkata' },
        removeOnComplete: true,
        removeOnFail: 50,
      },
      (m) => this.logger.error(m),
    );
    this.worker = new Worker(
      PO_INVOICE_REMINDER_QUEUE,
      async () => {
        await this.sweepAll();
      },
      { connection: conn, drainDelay: SCHEDULER_DRAIN_DELAY_SECONDS },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error({ jobId: job?.id, err: err.message }, 'PO invoice reminder sweep failed');
    });
    guardBullMq(
      PO_INVOICE_REMINDER_QUEUE,
      { connection: this.connection, queue: this.queue, worker: this.worker },
      (m) => this.logger.error(m),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    this.connection?.disconnect();
  }

  /**
   * Sweep every tenant, each in its own RLS context. Emails go out after the
   * tenant transaction commits: an SMTP round-trip has no business holding it
   * open, and the notifications are the record that the reminder was sent.
   */
  async sweepAll(now = new Date()): Promise<{ tenants: number; pos: number; emails: number }> {
    const tenants = await this.prisma.tenant.findMany({ select: { id: true } });
    let pos = 0;
    let emails = 0;
    for (const t of tenants) {
      const res = await this.prisma.runInTenantContext(
        t.id,
        () => this.sweepTenant(t.id, now),
        { timeout: 60_000 },
      );
      pos += res.pos;
      for (const email of res.emails) {
        emails += 1;
        await this.sendDigest(email);
      }
    }
    return { tenants: tenants.length, pos, emails };
  }

  /** Sweep one tenant (must run inside its tenant context). */
  async sweepTenant(
    tenantId: string,
    now: Date,
  ): Promise<{ pos: number; emails: ReminderEmail[] }> {
    const cutoff = new Date(now.getTime() - NO_INVOICE_REMINDER_DAYS * 24 * 60 * 60 * 1000);
    const pos = await this.prisma.client.purchaseOrder.findMany({
      where: {
        status: { in: AWAITING_INVOICE_STATUSES },
        OR: [{ issuedAt: { lte: cutoff } }, { issuedAt: null, createdAt: { lte: cutoff } }],
        invoices: { none: { status: { not: 'REJECTED' } } },
      },
      select: {
        id: true,
        number: true,
        totalAmount: true,
        currency: true,
        issuedAt: true,
        createdAt: true,
        createdBy: true,
        issuedBy: true,
        billToPlantId: true,
        vendor: { select: { name: true } },
      },
      orderBy: { issuedAt: 'asc' },
    });
    if (pos.length === 0) return { pos: 0, emails: [] };

    const financeRoles = await this.prisma.client.userRole.findMany({
      where: { role: { name: ROLES.FINANCE_OFFICER }, user: { isActive: true } },
      select: { userId: true, plantId: true },
    });

    // Who should hear about each PO: its buyer, plus every finance officer whose
    // plant scope covers the PO's bill-to plant (an unscoped role covers all).
    const recipientsByPo = new Map<string, Set<string>>();
    for (const po of pos) {
      const ids = new Set<string>();
      const buyer = po.createdBy ?? po.issuedBy;
      if (buyer) ids.add(buyer);
      for (const fr of financeRoles) {
        if (fr.plantId === null || fr.plantId === po.billToPlantId) ids.add(fr.userId);
      }
      recipientsByPo.set(po.id, ids);
    }

    const alreadySent = await this.prisma.client.notification.findMany({
      where: { type: PO_NO_INVOICE_NOTIFICATION, entityId: { in: pos.map((p) => p.id) } },
      select: { userId: true, entityId: true },
    });
    const sentKeys = new Set(alreadySent.map((n) => `${n.entityId}:${n.userId}`));

    const userIds = [...new Set([...recipientsByPo.values()].flatMap((s) => [...s]))];
    const users = await this.prisma.client.user.findMany({
      where: { id: { in: userIds }, isActive: true },
      select: { id: true, email: true, name: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));
    const tenant = await this.prisma.client.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });

    const digests = new Map<string, ReminderEmail>();
    let reminded = 0;
    for (const po of pos) {
      const issuedAt = po.issuedAt ?? po.createdAt;
      const stale: StalePo = {
        id: po.id,
        number: po.number,
        vendorName: po.vendor.name,
        totalAmount: po.totalAmount.toString(),
        currency: po.currency,
        issuedAt,
        daysWaiting: Math.floor((now.getTime() - issuedAt.getTime()) / (24 * 60 * 60 * 1000)),
      };
      let any = false;
      for (const userId of recipientsByPo.get(po.id) ?? []) {
        const user = userById.get(userId);
        if (!user || sentKeys.has(`${po.id}:${userId}`)) continue;
        any = true;
        await this.notifications.notify({
          userId,
          tenantId,
          type: PO_NO_INVOICE_NOTIFICATION,
          title: `${po.number} has no invoice after ${stale.daysWaiting} days`,
          body:
            `${po.vendor.name} has not uploaded an invoice against ${po.number} ` +
            `(${formatAmount(stale.totalAmount, stale.currency)}), issued on ${isoDate(issuedAt)}.`,
          entityType: 'PurchaseOrder',
          entityId: po.id,
          href: `/purchase-orders/${po.id}`,
        });
        const digest = digests.get(userId) ?? {
          to: user.email,
          name: user.name,
          tenantName: tenant?.name ?? '',
          pos: [],
        };
        digest.pos.push(stale);
        digests.set(userId, digest);
      }
      if (any) reminded += 1;
    }
    return { pos: reminded, emails: [...digests.values()] };
  }

  /** Never throws into the sweep: the in-app notification is already written. */
  private async sendDigest(email: ReminderEmail): Promise<void> {
    const base = this.config.get('APP_BASE_URL', { infer: true });
    const count = email.pos.length;
    const subject =
      count === 1
        ? `${email.pos[0]!.number} has no invoice after ${email.pos[0]!.daysWaiting} days`
        : `${count} purchase orders have no invoice after ${NO_INVOICE_REMINDER_DAYS}+ days`;
    const intro =
      `The following purchase order${count === 1 ? ' was' : 's were'} issued ` +
      `${NO_INVOICE_REMINDER_DAYS} or more days ago and no invoice has been uploaded yet.`;

    const text =
      `Hello ${email.name},\n\n${intro}\n\n` +
      email.pos
        .map(
          (p) =>
            `- ${p.number} · ${p.vendorName} · ${formatAmount(p.totalAmount, p.currency)} · ` +
            `issued ${isoDate(p.issuedAt)} (${p.daysWaiting} days)\n  ${base}/purchase-orders/${p.id}`,
        )
        .join('\n') +
      `\n\nPlease follow up with the vendor${count === 1 ? '' : 's'} for the invoice.` +
      (email.tenantName ? `\n\n— ${email.tenantName} ProcureFlow` : '');

    const rows = email.pos
      .map(
        (p) =>
          `<tr>` +
          `<td style="padding:6px 10px;border-bottom:1px solid #eee">` +
          `<a href="${base}/purchase-orders/${encodeURIComponent(p.id)}">${escapeHtml(p.number)}</a></td>` +
          `<td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(p.vendorName)}</td>` +
          `<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">` +
          `${escapeHtml(formatAmount(p.totalAmount, p.currency))}</td>` +
          `<td style="padding:6px 10px;border-bottom:1px solid #eee">${isoDate(p.issuedAt)}</td>` +
          `<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${p.daysWaiting}</td>` +
          `</tr>`,
      )
      .join('');
    const html =
      `<p>Hello ${escapeHtml(email.name)},</p>` +
      `<p>${escapeHtml(intro)}</p>` +
      `<table style="border-collapse:collapse;font-size:14px">` +
      `<thead><tr style="text-align:left;background:#f5f5f5">` +
      `<th style="padding:6px 10px">PO</th><th style="padding:6px 10px">Vendor</th>` +
      `<th style="padding:6px 10px;text-align:right">Amount</th>` +
      `<th style="padding:6px 10px">Issued</th>` +
      `<th style="padding:6px 10px;text-align:right">Days</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>` +
      `<p>Please follow up with the vendor${count === 1 ? '' : 's'} for the invoice.</p>`;

    try {
      await this.mail.send({ to: email.to, subject, text, html });
    } catch (err) {
      this.logger.error(
        { to: email.to, err: (err as Error).message },
        'PO invoice reminder email failed',
      );
    }
  }
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatAmount(amount: string, currency: string): string {
  try {
    return Number(amount).toLocaleString('en-IN', { style: 'currency', currency });
  } catch {
    return `${currency} ${amount}`;
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
