import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@raijin/api-core';
import { PrismaService } from '@raijin/api-prisma';
import {
  TRIAL_CONVERSION_MAX_WEEKS,
  TRIAL_REFUSAL_REASONS,
  type TrialCohort,
  type TrialConversionReport,
  type TrialRefusalReason,
} from '@raijin/shared-contracts';

const DAY_MS = 86_400_000;

interface CohortRow {
  week: string;
  started: number;
  active: number;
  converted: number;
  expired: number;
}

/** Taux = convertis / (convertis + expirés), `null` sans essai terminé. */
export function conversionRate(converted: number, expired: number): number | null {
  const done = converted + expired;
  return done === 0 ? null : converted / done;
}

/** Lundi (UTC) de la semaine de `date`, au format AAAA-MM-JJ. */
export function weekStartUtc(date: Date): string {
  const day = (date.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day)).toISOString().slice(0, 10);
}

/**
 * Tableau de conversion des essais (`GET admin/trial-conversion`, rôle ADMIN ; docs/ARCHITECTURE.md §13.7).
 * Cohortes par semaine de démarrage (lundi UTC), 26 semaines au plus, calculées sur `User` (durable) :
 * converti = un abonnement créé entre le début de l'essai et `TRIAL_CONVERSION_WINDOW_DAYS` après sa fin ;
 * actif = essai en cours ; expiré = essai terminé sans conversion. Refus de l'anti-abus par motif
 * (`ProductEvent trial_refused`, sur la durée de rétention des événements). Aucune donnée personnelle.
 */
@Injectable()
export class TrialConversionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async report(now: Date = new Date()): Promise<TrialConversionReport> {
    const since = new Date(`${weekStartUtc(new Date(now.getTime() - (TRIAL_CONVERSION_MAX_WEEKS - 1) * 7 * DAY_MS))}T00:00:00.000Z`);
    const window = this.config.trial.conversionWindowDays;
    const rows = await this.prisma.$queryRaw<CohortRow[]>`
      SELECT to_char(date_trunc('week', u."trialStartedAt"), 'YYYY-MM-DD') AS "week",
        count(*)::int AS "started",
        count(*) FILTER (WHERE NOT c."converted" AND u."trialStatus" = 'ACTIVE' AND u."trialEndsAt" > ${now})::int AS "active",
        count(*) FILTER (WHERE c."converted")::int AS "converted",
        count(*) FILTER (WHERE NOT c."converted" AND NOT (u."trialStatus" = 'ACTIVE' AND u."trialEndsAt" > ${now}))::int AS "expired"
      FROM "User" u
      CROSS JOIN LATERAL (
        SELECT EXISTS (
          SELECT 1 FROM "Subscription" s
          WHERE s."userId" = u."id" AND s."createdAt" >= u."trialStartedAt"
            AND s."createdAt" <= u."trialEndsAt" + make_interval(days => ${window}::int)
        ) AS "converted"
      ) c
      WHERE u."trialStartedAt" IS NOT NULL AND u."trialEndsAt" IS NOT NULL AND u."trialStartedAt" >= ${since}
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT ${TRIAL_CONVERSION_MAX_WEEKS}`;
    const cohorts: TrialCohort[] = rows.map((row) => {
      const converted = Number(row.converted);
      const expired = Number(row.expired);
      return {
        weekStart: row.week,
        started: Number(row.started),
        active: Number(row.active),
        converted,
        expired,
        conversionRate: conversionRate(converted, expired),
      };
    });
    const totals = cohorts.reduce(
      (sum, cohort) => ({
        started: sum.started + cohort.started,
        active: sum.active + cohort.active,
        converted: sum.converted + cohort.converted,
        expired: sum.expired + cohort.expired,
      }),
      { started: 0, active: 0, converted: 0, expired: 0 },
    );
    const refusalRows = await this.prisma.$queryRaw<{ reason: string; count: number }[]>`
      SELECT "properties"->>'reason' AS "reason", count(*)::int AS "count" FROM "ProductEvent"
      WHERE "type" = 'trial_refused' AND "createdAt" >= ${since}
      GROUP BY 1`;
    const refusals = Object.fromEntries(TRIAL_REFUSAL_REASONS.map((reason) => [reason, 0])) as Record<TrialRefusalReason, number>;
    for (const row of refusalRows) {
      if ((TRIAL_REFUSAL_REASONS as readonly string[]).includes(row.reason)) refusals[row.reason as TrialRefusalReason] = Number(row.count);
    }
    return {
      generatedAt: now.toISOString(),
      totals: { ...totals, conversionRate: conversionRate(totals.converted, totals.expired) },
      refusals,
      cohorts,
    };
  }
}
