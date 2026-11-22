import { Logger, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@raijin/api-core';
import { AuthMailService } from './auth-mail.service';
import { Mailer } from './mailer/mailer';
import { ResendMailer } from './mailer/resend.mailer';
import { SmtpMailer } from './mailer/smtp.mailer';

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

@Module({
  providers: [{ provide: Mailer, inject: [APP_CONFIG], useFactory: createMailer }, AuthMailService],
  exports: [Mailer, AuthMailService],
})
export class ApiNotificationsModule {}
