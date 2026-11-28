import { Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import type { BenchMailConfig } from '../config/bench-config';
import { BenchMailSender, NullBenchMailSender, type BenchMailMessage, type MailResult } from './bench-notifier';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const MAIL_TIMEOUT_MS = 10_000;

/** Adresse masquée pour les journaux (`p***@domaine`). */
export function maskAddress(address: string): string {
  const [user = '', domain = ''] = address.split('@');
  return `${user.slice(0, 1)}***@${domain}`;
}

/**
 * Envoi par l'API HTTP de Resend (https://resend.com/docs/api-reference/emails/send-email), sans SDK. La clé
 * (`BENCH_RESEND_API_KEY`, propre au banc) n'est jamais journalisée ; le destinataire est fixé par la configuration.
 */
export class ResendBenchMailSender extends BenchMailSender {
  readonly configured = true;
  private readonly logger = new Logger('BenchMail');

  constructor(
    private readonly options: { readonly apiKey: string; readonly from: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
  }

  async send(message: BenchMailMessage): Promise<MailResult> {
    try {
      const response = await this.fetchImpl(RESEND_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: this.options.from, to: [message.to], subject: message.subject, text: message.text }),
        signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
        redirect: 'error',
      });
      if (!response.ok) return { status: 'failed', code: `RESEND_HTTP_${response.status}` };
      this.logger.log(`E-mail « ${message.subject} » envoyé à ${maskAddress(message.to)}`);
      return { status: 'sent' };
    } catch {
      return { status: 'failed', code: 'RESEND_UNREACHABLE' };
    }
  }
}

/** `smtp://[user:pass@]hôte[:port]` ou `smtps://…` → options nodemailer (délais courts, identifiants jamais journalisés). */
export function smtpOptions(url: string) {
  const u = new URL(url);
  const secure = u.protocol === 'smtps:';
  return {
    host: u.hostname,
    port: Number(u.port || (secure ? 465 : 587)),
    secure,
    auth: u.username ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } : undefined,
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: MAIL_TIMEOUT_MS,
  };
}

/** Envoi SMTP (Mailpit en développement : `BENCH_SMTP_URL=smtp://localhost:1026`, interface http://localhost:8026). */
export class SmtpBenchMailSender extends BenchMailSender {
  readonly configured = true;
  private readonly logger = new Logger('BenchMail');
  private readonly transport: Transporter;

  constructor(
    private readonly options: { readonly url: string; readonly from: string },
    transport?: Transporter,
  ) {
    super();
    this.transport = transport ?? createTransport(smtpOptions(options.url));
  }

  async send(message: BenchMailMessage): Promise<MailResult> {
    try {
      await this.transport.sendMail({ from: this.options.from, to: message.to, subject: message.subject, text: message.text });
      this.logger.log(`E-mail « ${message.subject} » envoyé à ${maskAddress(message.to)}`);
      return { status: 'sent' };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      return { status: 'failed', code: typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'SMTP_ERROR' };
    }
  }
}

/** Expéditeur selon `BENCH_MAIL_TRANSPORT` (défaut `none` : aucun e-mail, `MAIL_NOT_CONFIGURED`). */
export function createBenchMailSender(config: BenchMailConfig): BenchMailSender {
  if (config.transport === 'resend') return new ResendBenchMailSender({ apiKey: config.apiKey, from: config.from });
  if (config.transport === 'smtp') return new SmtpBenchMailSender({ url: config.url, from: config.from });
  return new NullBenchMailSender();
}

/** Destinataire des alertes du banc (`BENCH_ALERT_EMAIL`, sinon le compte propriétaire), `null` sans e-mail. */
export function benchAlertRecipient(config: BenchMailConfig): string | null {
  return config.transport === 'none' ? null : config.to;
}
