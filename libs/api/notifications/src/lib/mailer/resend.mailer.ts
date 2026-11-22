import { Logger } from '@nestjs/common';
import { Mailer, maskEmail, type MailMessage } from './mailer';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** Envoi via l'API HTTP de Resend (sans SDK). La clé n'est jamais journalisée. */
export class ResendMailer extends Mailer {
  private readonly logger = new Logger('ResendMailer');

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
  }

  async send(message: MailMessage): Promise<void> {
    const response = await this.fetchImpl(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Resend a refusé l'envoi (HTTP ${response.status})`);
    }
    this.logger.log(`E-mail « ${message.subject} » envoyé à ${maskEmail(message.to)}`);
  }
}
