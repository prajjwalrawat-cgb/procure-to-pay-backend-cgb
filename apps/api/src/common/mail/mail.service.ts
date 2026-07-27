import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

import type { Env } from '../../config/env';

export interface SendMailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

type Transport = 'resend' | 'brevo' | 'smtp' | 'log';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const SEND_TIMEOUT_MS = 15_000;

/** Split `Name <addr@host>` into its parts; a bare address yields no name. */
function parseFrom(from: string): { name?: string; email: string } {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  if (!match) return { email: from.trim() };
  const name = match[1].replace(/^"|"$/g, '').trim();
  return { email: match[2].trim(), ...(name ? { name } : {}) };
}

/**
 * Outbound transactional email. One of three transports, chosen at boot:
 *
 *  - **resend** (`RESEND_API_KEY`) — HTTPS POST to the Resend API on :443.
 *    Preferred anywhere hosted: most PaaS providers, Railway included, block
 *    outbound SMTP ports, so nodemailer just times out there (ETIMEDOUT on both
 *    :465 and :587). Port 443 is never blocked. Requires the `from` domain to be
 *    DNS-verified (SPF + DKIM) in Resend.
 *  - **brevo** (`BREVO_API_KEY`) — same idea over :443, but Brevo accepts a
 *    single sender address verified by clicking a link it mails to that address.
 *    No DNS access needed, so it is the quickest way to working mail; without
 *    DKIM, deliverability is weaker than Resend's.
 *  - **smtp** (`SMTP_USER` + `SMTP_PASS`) — direct nodemailer. Fine locally.
 *  - **log** (neither) — logs the message and link instead of sending, so the
 *    invite flow works end-to-end without credentials. Mirrors the
 *    sandbox-provider pattern used across the integrations (ADR-032).
 *
 * The `from` address (`SMTP_FROM`) is the same on every transport, so switching
 * is invisible to recipients.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly from: string;
  private readonly transport: Transport;
  private readonly resendKey: string;
  private readonly brevoKey: string;
  private transporter: Transporter | null = null;

  constructor(private readonly config: ConfigService<Env, true>) {
    this.from = this.config.get('SMTP_FROM', { infer: true });
    this.resendKey = this.config.get('RESEND_API_KEY', { infer: true });
    this.brevoKey = this.config.get('BREVO_API_KEY', { infer: true });
    const user = this.config.get('SMTP_USER', { infer: true });
    const pass = this.config.get('SMTP_PASS', { infer: true });

    if (this.resendKey) {
      this.transport = 'resend';
      this.logger.log(`Mail transport: Resend HTTP API (from: ${this.from})`);
    } else if (this.brevoKey) {
      this.transport = 'brevo';
      this.logger.log(`Mail transport: Brevo HTTP API (from: ${this.from})`);
    } else if (user && pass) {
      this.transport = 'smtp';
      this.initSmtp(user, pass);
    } else {
      this.transport = 'log';
      this.logger.warn(
        'No RESEND_API_KEY and no SMTP_USER/SMTP_PASS — MailService is in log mode ' +
          '(emails are logged, not sent).',
      );
    }
  }

  private initSmtp(user: string, pass: string): void {
    const host = this.config.get('SMTP_HOST', { infer: true });
    const port = this.config.get('SMTP_PORT', { infer: true });
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // implicit TLS on 465; STARTTLS otherwise
      auth: { user, pass },
      // Fail fast instead of hanging ~2min when a PaaS blocks outbound SMTP.
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
    });
    // Prove reachability at boot rather than per-send: invite mail is
    // fire-and-forget, so a dead SMTP path is otherwise invisible.
    void this.transporter
      .verify()
      .then(() =>
        this.logger.log(`SMTP ready — ${user} via ${host}:${port} (from: ${this.from})`),
      )
      .catch((e: NodeJS.ErrnoException) =>
        this.logger.error(
          `SMTP unreachable — ${host}:${port} code=${e.code ?? 'n/a'}: ${e.message}. ` +
            'Outbound email will fail. Set RESEND_API_KEY to send over HTTPS instead.',
        ),
      );
  }

  async send(input: SendMailInput): Promise<void> {
    switch (this.transport) {
      case 'resend':
        return this.sendViaResend(input);
      case 'brevo':
        return this.sendViaBrevo(input);
      case 'smtp':
        return this.sendViaSmtp(input);
      default:
        this.logger.log(
          `[log-mode email] to=${input.to} subject="${input.subject}"\n${input.text}`,
        );
    }
  }

  private async sendViaResend(input: SendMailInput): Promise<void> {
    // 403 here almost always means the `from` domain is not DNS-verified yet.
    await this.postToProvider('Resend', RESEND_ENDPOINT, input, {
      headers: { Authorization: `Bearer ${this.resendKey}` },
      payload: {
        from: this.from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      },
      idFrom: (b) => (b as { id?: string }).id,
    });
  }

  private async sendViaBrevo(input: SendMailInput): Promise<void> {
    // 400 "sender not valid" here means the from address is not verified yet.
    await this.postToProvider('Brevo', BREVO_ENDPOINT, input, {
      headers: { 'api-key': this.brevoKey, accept: 'application/json' },
      payload: {
        sender: parseFrom(this.from),
        to: [{ email: input.to }],
        subject: input.subject,
        htmlContent: input.html,
        textContent: input.text,
      },
      idFrom: (b) => (b as { messageId?: string }).messageId,
    });
  }

  /** POST a message to an HTTP email provider, logging the outcome either way.
   *  Callers send fire-and-forget, so anything not logged here is lost. */
  private async postToProvider(
    provider: string,
    url: string,
    input: SendMailInput,
    spec: {
      headers: Record<string, string>;
      payload: Record<string, unknown>;
      idFrom: (body: unknown) => string | undefined;
    },
  ): Promise<void> {
    const label = `"${input.subject}" to ${input.to}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { ...spec.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(spec.payload),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (e) {
      // Network-level failure: DNS, TLS or the 15s timeout.
      const err = e as Error;
      this.logger.error(`${provider} request failed for ${label}: ${err.message}`);
      throw e;
    }

    const body = await res.text();
    if (!res.ok) {
      this.logger.error(`${provider} rejected ${label} — ${res.status}: ${body}`);
      throw new Error(`${provider} responded ${res.status}: ${body}`);
    }
    const id = spec.idFrom(JSON.parse(body)) ?? 'unknown';
    this.logger.log(`Sent ${label} (${provider.toLowerCase()} id=${id})`);
  }

  private async sendViaSmtp(input: SendMailInput): Promise<void> {
    if (!this.transporter) return;
    try {
      const info = await this.transporter.sendMail({
        from: this.from,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
      });
      this.logger.log(
        `Sent "${input.subject}" to ${input.to} (id=${info.messageId}, ${info.response})`,
      );
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      this.logger.error(
        `Failed to send "${input.subject}" to ${input.to} — code=${err.code ?? 'n/a'}: ${err.message}`,
      );
      throw e;
    }
  }
}

@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
