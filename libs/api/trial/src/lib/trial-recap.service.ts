import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException, trialStatusOf } from '@raijin/api-core';
import { PrismaService } from '@raijin/api-prisma';
import { BILLING_ERROR_MESSAGES, type TrialRecap } from '@raijin/shared-contracts';

/** Colonnes `User` de l'essai lues par le récapitulatif. */
export const TRIAL_RECAP_USER_SELECT = {
  trialStatus: true,
  trialStartedAt: true,
  trialEndsAt: true,
} as const;

export function trialNotFound(): ApiException {
  return new ApiException('TRIAL_NOT_FOUND', HttpStatus.NOT_FOUND, BILLING_ERROR_MESSAGES.TRIAL_NOT_FOUND);
}

/**
 * Récapitulatif de l'essai (contrat `TrialRecap`) : comptes calculés en base sur la fenêtre
 * `trialStartedAt` → min(maintenant, `trialEndsAt`) (fin anticipée par l'abonnement comprise) :
 * analyses (`ProductEvent analysis_done`), tokens Danger distincts, alertes reçues, scans de wallet
 * (`UsageCounter wallet_scan`), suivis actifs et en pause à cause de la limite du plan.
 */
@Injectable()
export class TrialRecapService {
  constructor(private readonly prisma: PrismaService) {}

  async recap(userId: string, now: Date = new Date()): Promise<TrialRecap> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: TRIAL_RECAP_USER_SELECT });
    if (!user?.trialStartedAt || !user.trialEndsAt) throw trialNotFound();
    const from = user.trialStartedAt;
    const to = new Date(Math.min(now.getTime(), user.trialEndsAt.getTime()));
    const [analyses, danger, alertsCount, walletScans, activeWatches, planLimitPausedWatches] = await Promise.all([
      this.prisma.productEvent.count({ where: { userId, type: 'analysis_done', createdAt: { gte: from, lte: to } } }),
      this.prisma.$queryRaw<{ count: number }[]>`
        SELECT count(DISTINCT "properties"->>'mint')::int AS "count" FROM "ProductEvent"
        WHERE "userId" = ${userId}::uuid AND "type" = 'analysis_done' AND "properties"->>'verdict' = 'danger'
          AND "createdAt" >= ${from} AND "createdAt" <= ${to}`,
      this.prisma.alert.count({ where: { userId, createdAt: { gte: from, lte: to } } }),
      this.prisma.usageCounter.aggregate({
        where: { userId, kind: 'wallet_scan', day: { gte: dayOf(from), lte: dayOf(to) } },
        _sum: { count: true },
      }),
      this.prisma.watch.count({ where: { userId, status: 'active' } }),
      this.prisma.watch.count({ where: { userId, status: 'paused', pausedReason: 'plan_limit' } }),
    ]);
    const status = trialStatusOf(user, now);
    return {
      status,
      startedAt: from.toISOString(),
      endsAt: user.trialEndsAt.toISOString(),
      analysesCount: analyses,
      alertsCount,
      dangerTokensCount: Number(danger[0]?.count ?? 0),
      walletScansCount: Math.max(0, walletScans._sum.count ?? 0),
      activeWatches,
      planLimitPausedWatches,
    };
  }
}

/** Jour UTC (colonne `@db.Date`). */
function dayOf(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
