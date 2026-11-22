import { Logger, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@raijin/api-core';
import { AlertMailService } from './alert-mail.service';
import { AuthMailService } from './auth-mail.service';
import { Mailer } from './mailer/mailer';
import { ResendMailer } from './mailer/resend.mailer';
import { SmtpMailer } from './mailer/smtp.mailer';
import { FakePushSender } from './push/fake-push.sender';
import { PushSender } from './push/push-sender';
import { WebPushSender } from './push/web-push.sender';

/** Choisit l'implémentation : Resend seulement si configuré avec une vraie clé, sinon SMTP. */
export function createMailer(config: AppConfig): Mailer {
  const { mail } = config;
  if (mail.provider === 'resend' && mail.resendApiKey) {
    return new ResendMailer(mail.resendApiKey, mail.from);
  }
  new Logger('Mailer').log(`Envoi SMTP via ${mail.smtpHost}:${mail.smtpPort}`);
  return new SmtpMailer({
    host: mail.smtpHost,
    port: mail.smtpPort,
    from: mail.from,
    user: mail.smtpUser,
    password: mail.smtpPassword,
  });
}

/**
 * Push : `fake` (tests e2e, refusé en production par la configuration) ou `web-push`. Sans paire
 * VAPID, l'expéditeur est « non configuré » (push indisponible, alertes par e-mail seulement).
 */
export function createPushSender(config: AppConfig): PushSender {
  const { push } = config;
  if (push.provider === 'fake' && !config.isProduction) return new FakePushSender(push.publicKey);
  if (!push.publicKey || !push.privateKey) return new WebPushSender(null);
  return new WebPushSender({ publicKey: push.publicKey, privateKey: push.privateKey, subject: push.subject });
}

@Module({
  providers: [
    { provide: Mailer, inject: [APP_CONFIG], useFactory: createMailer },
    { provide: PushSender, inject: [APP_CONFIG], useFactory: createPushSender },
    AuthMailService,
    AlertMailService,
  ],
  exports: [Mailer, PushSender, AuthMailService, AlertMailService],
})
export class ApiNotificationsModule {}
