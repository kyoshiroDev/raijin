import { Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { Mailer, maskEmail, type MailMessage } from './mailer';

export interface SmtpMailerOptions {
  readonly host: string;
  readonly port: number;
  readonly from: string;
  readonly user: string | null;
  readonly password: string | null;
}

/** Envoi SMTP (Mailpit en développement : http://localhost:8026). */
export class SmtpMailer extends Mailer {
  private readonly logger = new Logger('SmtpMailer');
  private readonly transport: Transporter;

  constructor(
    private readonly options: SmtpMailerOptions,
    transport?: Transporter,
  ) {
    super();
    this.transport =
      transport ??
      createTransport({
        host: options.host,
        port: options.port,
        secure: options.port === 465,
        auth: options.user && options.password ? { user: options.user, pass: options.password } : undefined,
        connectionTimeout: 5_000,
        greetingTimeout: 5_000,
        socketTimeout: 10_000,
      });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.options.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    this.logger.log(`E-mail « ${message.subject} » envoyé à ${maskEmail(message.to)}`);
  }
}
