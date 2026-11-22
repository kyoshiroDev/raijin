import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@raijin/api-core';
import { Mailer } from './mailer/mailer';
import type { AlertMessage } from './templates/alert-text';
import { alertDigestTemplate, weeklyDigestTemplate, type DigestWatch, type WatchMailContext } from './templates/alert-templates';

/** E-mails des suivis : alertes groupées et résumé hebdomadaire. */
@Injectable()
export class AlertMailService {
  private readonly ctx: WatchMailContext;

  constructor(
    private readonly mailer: Mailer,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.ctx = { logoUrl: config.mail.logoUrl, appUrl: config.appUrl, assetsBaseUrl: config.mail.assetsBaseUrl };
  }

  sendAlerts(to: string, alerts: readonly AlertMessage[]): Promise<void> {
    return this.mailer.send({ to, ...alertDigestTemplate(this.ctx, alerts) });
  }

  sendWeeklyDigest(to: string, watches: readonly DigestWatch[]): Promise<void> {
    return this.mailer.send({ to, ...weeklyDigestTemplate(this.ctx, watches) });
  }
}
