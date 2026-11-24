import { Injectable, Logger } from '@nestjs/common';
import { PushSender, type PushResult, type PushSendOptions, type PushTarget } from '@raijin/server-push';
import type { PushNotificationPayload } from '@raijin/shared-contracts';
import { BenchModeService } from './bench-mode.service';

export interface BenchMailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export type MailResult = { readonly status: 'sent' } | { readonly status: 'failed'; readonly code: string };

/** Envoi d'e-mails du banc (alertes de taille, jobs en échec) : branché en T7 ; par défaut non configuré. */
export abstract class BenchMailSender {
  abstract readonly configured: boolean;
  abstract send(message: BenchMailMessage): Promise<MailResult>;
}

export class NullBenchMailSender extends BenchMailSender {
  readonly configured = false;

  async send(): Promise<MailResult> {
    return { status: 'failed', code: 'MAIL_NOT_CONFIGURED' };
  }
}

export type Suppressed = { readonly status: 'suppressed'; readonly reason: 'shadow_mode' };

/**
 * Point de passage **unique** des notifications du banc (push VAPID du banc via `@raijin/server-push`, e-mail).
 * En mode ombre, rien n'est envoyé : les expéditeurs ne sont jamais appelés (`suppressed`).
 */
@Injectable()
export class BenchNotifier {
  private readonly logger = new Logger('BenchNotifier');

  constructor(
    private readonly mode: BenchModeService,
    private readonly push: PushSender,
    private readonly mail: BenchMailSender,
  ) {}

  get pushConfigured(): boolean {
    return this.push.configured;
  }

  get pushPublicKey(): string | null {
    return this.push.publicKey;
  }

  get mailConfigured(): boolean {
    return this.mail.configured;
  }

  async sendPush(target: PushTarget, payload: PushNotificationPayload, options: PushSendOptions): Promise<PushResult | Suppressed> {
    if (!this.mode.notificationsAllowed()) {
      this.logger.debug('Push non envoyé (mode ombre)');
      return { status: 'suppressed', reason: 'shadow_mode' };
    }
    return this.push.send(target, payload, options);
  }

  /**
   * Push au format historique du banc (charge `{ notification: { title, body, icon, tag, data } }` construite par le
   * code porté de `scan-tokens`, lue par le service worker du banc) : même garde du mode ombre, même expéditeur.
   */
  async sendBenchPush(target: PushTarget, payload: object, options: PushSendOptions): Promise<PushResult | Suppressed> {
    return this.sendPush(target, payload as PushNotificationPayload, options);
  }

  async sendMail(message: BenchMailMessage): Promise<MailResult | Suppressed> {
    if (!this.mode.notificationsAllowed()) {
      this.logger.debug('E-mail non envoyé (mode ombre)');
      return { status: 'suppressed', reason: 'shadow_mode' };
    }
    return this.mail.send(message);
  }
}
