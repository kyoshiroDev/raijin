import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@raijin/api-core';
import type { Entitlements } from '@raijin/shared-contracts';
import { Mailer } from './mailer/mailer';
import type { WatchMailContext } from './templates/alert-templates';
import { trialDay1Template, trialDayMinus2Template, trialEndedTemplate, type TrialMailRecap } from './templates/trial-templates';

/** E-mails de l'essai Pro (J+1, J-2, J0), envoyés par le job `trial-tick` (`api-trial`). */
@Injectable()
export class TrialMailService {
  private readonly ctx: WatchMailContext;

  constructor(
    private readonly mailer: Mailer,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.ctx = { logoUrl: config.mail.logoUrl, appUrl: config.appUrl, assetsBaseUrl: config.mail.assetsBaseUrl };
  }

  sendDay1(to: string, recap: TrialMailRecap): Promise<void> {
    return this.mailer.send({ to, ...trialDay1Template(this.ctx, recap) });
  }

  sendDayMinus2(to: string, recap: TrialMailRecap, endsAt: Date, free: Entitlements): Promise<void> {
    return this.mailer.send({ to, ...trialDayMinus2Template(this.ctx, recap, endsAt, free) });
  }

  sendEnded(to: string, recap: TrialMailRecap, free: Entitlements): Promise<void> {
    return this.mailer.send({ to, ...trialEndedTemplate(this.ctx, recap, free) });
  }
}
