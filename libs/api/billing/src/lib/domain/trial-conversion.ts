import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@raijin/api-core';
import type { Prisma } from '@raijin/api-prisma';
import type { BillingInterval } from '@raijin/shared-contracts';
import { TrialConversion } from './billing-ports';

const DAY_MS = 86_400_000;

/** Fin d'essai à l'abonnement, dans la transaction du webhook (voir `TrialConversion`). Idempotente. */
@Injectable()
export class DefaultTrialConversion extends TrialConversion {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
  }

  async endTrialOnSubscriptionInTx(tx: Prisma.TransactionClient, userId: string, interval: BillingInterval, now: Date): Promise<'during' | 'after' | null> {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { trialStatus: true, trialEndsAt: true } });
    if (!user?.trialEndsAt || (user.trialStatus !== 'ACTIVE' && user.trialStatus !== 'ENDED')) return null;
    const active = user.trialStatus === 'ACTIVE' && user.trialEndsAt.getTime() > now.getTime();
    // Essai actif : terminé tout de suite ; essai échu mais encore ACTIVE (job en retard) : terminé.
    if (user.trialStatus === 'ACTIVE') await tx.user.update({ where: { id: userId }, data: active ? { trialStatus: 'ENDED', trialEndsAt: now } : { trialStatus: 'ENDED' } });
    if (!active && now.getTime() - user.trialEndsAt.getTime() > this.config.trial.conversionWindowDays * DAY_MS) return null;
    if ((await tx.productEvent.count({ where: { userId, type: 'trial_converted' } })) > 0) return null;
    const phase = active ? 'during' : 'after';
    await tx.productEvent.create({ data: { userId, type: 'trial_converted', properties: { phase, interval } } });
    return phase;
  }
}
