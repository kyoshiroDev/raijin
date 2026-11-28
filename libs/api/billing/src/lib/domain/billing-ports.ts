import { Injectable } from '@nestjs/common';
import type { Prisma } from '@raijin/api-prisma';
import type { BillingInterval } from '@raijin/shared-contracts';

/** Horloge de l'abonnement (remplacée dans les tests). */
@Injectable()
export class BillingClock {
  now(): Date {
    return new Date();
  }
}

/**
 * Effets du changement de plan sur les suivis (`api-alerts`, docs/ARCHITECTURE.md §13.1) :
 * - passage Gratuit : `enforcePlanLimit` (suivis au-delà de la limite mis en pause `plan_limit`, jamais supprimés) ;
 * - passage Pro : `resumePlanLimited` (suivis en pause `plan_limit` réactivés dans la limite Pro).
 * Appelés après le commit de la transaction du webhook (ils relisent le plan en base).
 */
export abstract class PlanLimitHooks {
  abstract enforcePlanLimit(userId: string): Promise<number>;
  abstract resumePlanLimited(userId: string): Promise<number>;
}

/**
 * Fin d'essai à l'abonnement (docs/ARCHITECTURE.md §13.3, §13.7), appelée **dans la transaction** du webhook qui
 * passe le compte en Pro : essai actif → `ENDED`, `trialEndsAt = now`, `trial_converted {phase: during}` ;
 * abonnement dans `TRIAL_CONVERSION_WINDOW_DAYS` après la fin → `trial_converted {phase: after}` (une fois).
 * Implémentation par défaut : `DefaultTrialConversion` (aucune dépendance billing → trial) ; l'app peut lui
 * substituer celle d'`api-trial` (`ApiBillingModule.forRoot(config, { trialConversion })`).
 */
export abstract class TrialConversion {
  abstract endTrialOnSubscriptionInTx(tx: Prisma.TransactionClient, userId: string, interval: BillingInterval, now: Date): Promise<'during' | 'after' | null>;
}
