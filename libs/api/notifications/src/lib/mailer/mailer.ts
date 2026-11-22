/** Message prêt à l'envoi : HTML responsive + version texte. */
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/**
 * Envoi d'e-mails transactionnels. Implémentations : `SmtpMailer` (Mailpit en dev) et
 * `ResendMailer` (production, activé seulement si RESEND_API_KEY est présente).
 */
export abstract class Mailer {
  abstract send(message: MailMessage): Promise<void>;
}

/** Masque une adresse pour les journaux (`j***@exemple.fr`). */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}
