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

/**
 * Outbound transactional email over SMTP (nodemailer).
 *
 * When SMTP credentials (SMTP_USER / SMTP_PASS) are not configured the service
 * runs in "log" mode — it logs the recipient, subject and body instead of
 * dialling a mail server. This mirrors the sandbox-provider pattern used across
 * the integrations (ADR-032): the flow works end-to-end locally without real
 * credentials, and flips to real delivery the moment the SMTP env is set.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly from: string;
  private readonly enabled: boolean;
  private transporter: Transporter | null = null;

  constructor(private readonly config: ConfigService<Env, true>) {
    this.from = this.config.get('SMTP_FROM', { infer: true });
    const user = this.config.get('SMTP_USER', { infer: true });
    const pass = this.config.get('SMTP_PASS', { infer: true });
    this.enabled = Boolean(user && pass);
    if (this.enabled) {
      const port = this.config.get('SMTP_PORT', { infer: true });
      this.transporter = nodemailer.createTransport({
        host: this.config.get('SMTP_HOST', { infer: true }),
        port,
        secure: port === 465, // implicit TLS on 465; STARTTLS otherwise
        auth: { user, pass },
      });
    } else {
      this.logger.warn(
        'SMTP_USER/SMTP_PASS not set — MailService is in log mode (emails are logged, not sent).',
      );
    }
  }

  async send(input: SendMailInput): Promise<void> {
    if (!this.enabled || !this.transporter) {
      this.logger.log(
        `[log-mode email] to=${input.to} subject="${input.subject}"\n${input.text}`,
      );
      return;
    }
    await this.transporter.sendMail({
      from: this.from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
    this.logger.log(`Sent "${input.subject}" to ${input.to}`);
  }
}

@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
