import { Inject, Injectable, Logger } from '@nestjs/common';
import { BILLING_CONFIG, type BillingConfig } from '@raijin/api-billing';
import { APP_CONFIG, errorCode, type AppConfig } from '@raijin/api-core';
import { PrismaService } from '@raijin/api-prisma';
import { UpstreamUsageReader } from '@raijin/api-solana';
import { DATA_SOURCE_IDS, isDailyMetricKey, type DailyMetricKey } from '@raijin/shared-contracts';
import { addDays, dayStart, utcDay } from '../common/range';
import { DailyCounters } from './daily-counters';

/** Valeurs d'un jour : clé du catalogue → valeur (une clé absente = non mesurée ce jour-là). */
export type DayMetrics = Map<DailyMetricKey, number>;

interface DayRow {
  signups: number;
  email_verified: number;
  trials_started: number;
  trials_converted: number;
  trials_expired: number;
  trials_refused: number;
  trials_active: number;
  accounts_deleted: number;
  subscriptions_new: number;
  subscriptions_canceled: number;
  payments_failed: number;
  subscribers_monthly: number;
  subscribers_yearly: number;
  analyses_total: number;
  analyses_anonymous: number;
  analyses_failed: number;
  verdict_safe: number;
  verdict_warn: number;
  verdict_danger: number;
  duration_avg: number | null;
  duration_p95: number | null;
  wallet_scans: number;
  watches_active: number;
  alerts_sent: number;
  push_sent: number;
  push_subscriptions_active: number;
}

/** Les compteurs Redis (requêtes, e-mails, appels des sources) vivent 8 jours : au-delà, ces clés ne sont pas écrites. */
export const COUNTER_HISTORY_DAYS = 7;

/**
 * Calcul des métriques d'un jour UTC (catalogue `DAILY_METRICS`, docs/ARCHITECTURE.md §14.5) à partir des tables
 * sources et des compteurs Redis. **Aucune donnée personnelle** : uniquement des comptes, sommes, moyennes et
 * instantanés. Les instantanés (`last`) d'un jour passé sont reconstitués à la fin du jour (création / résiliation).
 * - `analyses_failed` : analyses au résultat partiel (au moins un contrôle indisponible ; les échecs complets ne sont
 *   pas enregistrés) ;
 * - `trials_converted`, `trials_expired`, `trials_refused`, `subscriptions_canceled`, `payments_failed`,
 *   `wallet_scans` : événements produit du jour (`ProductEvent`, conservés malgré la suppression du compte).
 */
@Injectable()
export class MetricsCalculator {
  private readonly logger = new Logger('Metrics');

  constructor(
    private readonly prisma: PrismaService,
    private readonly counters: DailyCounters,
    private readonly usage: UpstreamUsageReader,
    @Inject(BILLING_CONFIG) private readonly billing: BillingConfig,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Métriques du jour `day` ; `now` sert à dater les instantanés et à savoir si les compteurs Redis existent encore. */
  async compute(day: string, now: Date): Promise<DayMetrics> {
    const start = dayStart(day);
    const end = dayStart(addDays(day, 1));
    const metrics: DayMetrics = new Map();
    const set = (key: string, value: number | null | undefined) => {
      if (value === null || value === undefined || !Number.isFinite(value) || !isDailyMetricKey(key)) return;
      metrics.set(key, Math.max(0, value));
    };

    const [row] = await this.prisma.$queryRaw<DayRow[]>`
      SELECT
        (SELECT count(*) FROM "User" WHERE "createdAt" >= ${start} AND "createdAt" < ${end})::int AS "signups",
        (SELECT count(*) FROM "User" WHERE "emailVerifiedAt" >= ${start} AND "emailVerifiedAt" < ${end})::int AS "email_verified",
        (SELECT count(*) FROM "User" WHERE "trialStartedAt" >= ${start} AND "trialStartedAt" < ${end})::int AS "trials_started",
        (SELECT count(*) FROM "ProductEvent" WHERE "type" = 'trial_converted' AND "createdAt" >= ${start} AND "createdAt" < ${end})::int AS "trials_converted",
        (SELECT count(*) FROM "ProductEvent" WHERE "type" = 'trial_expired' AND "createdAt" >= ${start} AND "createdAt" < ${end})::int AS "trials_expired",
        (SELECT count(*) FROM "ProductEvent" WHERE "type" = 'trial_refused' AND "createdAt" >= ${start} AND "createdAt" < ${end})::int AS "trials_refused",
        (SELECT count(*) FROM "User" u WHERE u."trialStartedAt" < ${end} AND u."trialEndsAt" >= ${end}
          AND u."trialStatus" IN ('ACTIVE', 'ENDED')
          AND NOT EXISTS (SELECT 1 FROM "Subscription" s WHERE s."userId" = u."id" AND s."createdAt" >= u."trialStartedAt" AND s."createdAt" < ${end}))::int AS "trials_active",
        (SELECT count(*) FROM "AuditLog" WHERE "action" = 'account.deleted' AND "createdAt" >= ${start} AND "createdAt" < ${end})::int AS "accounts_deleted",
        (SELECT count(*) FROM "Subscription" WHERE "createdAt" >= ${start} AND "createdAt" < ${end})::int AS "subscriptions_new",
        (SELECT count(*) FROM "ProductEvent" WHERE "type" = 'subscription_canceled' AND "createdAt" >= ${start} AND "createdAt" < ${end})::int AS "subscriptions_canceled",
        (SELECT count(*) FROM "ProductEvent" WHERE "type" = 'payment_failed' AND "createdAt" >= ${start} AND "createdAt" < ${end})::int AS "payments_failed",
        (SELECT count(*) FROM "Subscription" s WHERE s."interval" = 'MONTH' AND s."createdAt" < ${end}
          AND (s."status"::text IN ('ACTIVE', 'PAST_DUE') OR (s."status"::text IN ('CANCELED', 'UNPAID', 'PAUSED') AND s."updatedAt" >= ${end})))::int AS "subscribers_monthly",
        (SELECT count(*) FROM "Subscription" s WHERE s."interval" = 'YEAR' AND s."createdAt" < ${end}
          AND (s."status"::text IN ('ACTIVE', 'PAST_DUE') OR (s."status"::text IN ('CANCELED', 'UNPAID', 'PAUSED') AND s."updatedAt" >= ${end})))::int AS "subscribers_yearly",
        a."analyses_total", a."analyses_anonymous", a."analyses_failed", a."verdict_safe", a."verdict_warn", a."verdict_danger",
        a."duration_avg", a."duration_p95",
        (SELECT count(*) FROM "ProductEvent" WHERE "type" = 'wallet_scanned' AND "createdAt" >= ${start} AND "createdAt" < ${end})::int AS "wallet_scans",
        (SELECT count(*) FROM "Watch" WHERE "status" = 'active' AND "createdAt" < ${end})::int AS "watches_active",
        (SELECT count(*) FROM "Alert" WHERE "createdAt" >= ${start} AND "createdAt" < ${end})::int AS "alerts_sent",
        (SELECT count(*) FROM "Alert" WHERE "pushedAt" >= ${start} AND "pushedAt" < ${end})::int AS "push_sent",
        (SELECT count(*) FROM "PushSubscription" WHERE "createdAt" < ${end})::int AS "push_subscriptions_active"
      FROM (
        SELECT count(*)::int AS "analyses_total",
          count(*) FILTER (WHERE "userId" IS NULL)::int AS "analyses_anonymous",
          count(*) FILTER (WHERE "degraded")::int AS "analyses_failed",
          count(*) FILTER (WHERE "verdict" = 'safe')::int AS "verdict_safe",
          count(*) FILTER (WHERE "verdict" = 'warn')::int AS "verdict_warn",
          count(*) FILTER (WHERE "verdict" = 'danger')::int AS "verdict_danger",
          avg("durationMs")::float8 AS "duration_avg",
          (percentile_cont(0.95) WITHIN GROUP (ORDER BY "durationMs"))::float8 AS "duration_p95"
        FROM "TokenAnalysis" WHERE "createdAt" >= ${start} AND "createdAt" < ${end}
      ) a`;

    if (row) {
      for (const key of [
        'signups',
        'email_verified',
        'trials_started',
        'trials_converted',
        'trials_expired',
        'trials_refused',
        'trials_active',
        'accounts_deleted',
        'subscriptions_new',
        'subscriptions_canceled',
        'payments_failed',
        'subscribers_monthly',
        'subscribers_yearly',
        'analyses_total',
        'analyses_anonymous',
        'analyses_failed',
        'verdict_safe',
        'verdict_warn',
        'verdict_danger',
        'wallet_scans',
        'watches_active',
        'alerts_sent',
        'push_sent',
        'push_subscriptions_active',
      ] as const) {
        set(key, Number(row[key]));
      }
      const monthly = Number(row.subscribers_monthly);
      const yearly = Number(row.subscribers_yearly);
      set('subscribers_active', monthly + yearly);
      set('mrr_cents', mrrCents(monthly, yearly, this.billing));
      if (row.duration_avg !== null) set('analysis_duration_avg_ms', Math.round(Number(row.duration_avg)));
      if (row.duration_p95 !== null) set('analysis_duration_p95_ms', Math.round(Number(row.duration_p95)));
    }

    const sources = await this.prisma.$queryRaw<{ id: string; checks: number; unavailable: number }[]>`
      SELECT src->>'id' AS "id",
        count(*) FILTER (WHERE src->>'status' IN ('ok', 'error'))::int AS "checks",
        count(*) FILTER (WHERE src->>'status' = 'error')::int AS "unavailable"
      FROM "TokenAnalysis" t
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t."sources") = 'array' THEN t."sources" ELSE '[]'::jsonb END) src
      WHERE t."createdAt" >= ${start} AND t."createdAt" < ${end}
      GROUP BY 1`;
    for (const source of DATA_SOURCE_IDS) {
      const entry = sources.find((candidate) => candidate.id === source);
      set(`checks.${source}`, Number(entry?.checks ?? 0));
      set(`checks_unavailable.${source}`, Number(entry?.unavailable ?? 0));
    }

    // Compteurs Redis (TTL 8 jours) : seulement pour les jours encore couverts.
    const age = Math.round((dayStart(utcDay(now)).getTime() - start.getTime()) / 86_400_000);
    if (age >= 0 && age <= COUNTER_HISTORY_DAYS) {
      const counters = await this.counters.read(day);
      if (counters) {
        set('api_requests', counters.api_requests);
        set('api_errors_5xx', counters.api_errors_5xx);
        set('emails_sent', counters.emails_sent);
        set('emails_failed', counters.emails_failed);
      }
      try {
        const snapshot = await this.usage.snapshot(day);
        if (snapshot.status === 'ok') {
          set('helius_credits', snapshot.credits.used);
          for (const [key, value] of Object.entries(snapshot.dailyMetrics)) set(key, value);
        }
      } catch (error) {
        this.logger.warn(`Compteurs des sources illisibles (${errorCode(error)})`);
      }
    }
    // Taille de la base : instantané pris au passage (jour en cours ou veille seulement).
    if (age >= 0 && age <= 1) set('db_size_bytes', await databaseSize(this.prisma));
    return metrics;
  }

  /** Jours d'historique encore présents dans les tables sources (rattrapage du premier passage). */
  get retentionDays(): number {
    return this.config.jobs.retentionDays;
  }
}

/** MRR en centimes : mensuels + annuels / 12, aux prix configurés (`PRO_PRICE_*_CENTS`). */
export function mrrCents(monthly: number, yearly: number, billing: Pick<BillingConfig, 'prices'>): number {
  return Math.round(monthly * billing.prices.monthlyCents + (yearly * billing.prices.yearlyCents) / 12);
}

/** `pg_database_size` de la base courante, `null` si la requête échoue (droits). */
export async function databaseSize(prisma: PrismaService): Promise<number | null> {
  try {
    const [row] = await prisma.$queryRaw<{ size: bigint | number }[]>`SELECT pg_database_size(current_database()) AS "size"`;
    return row ? Number(row.size) : null;
  } catch {
    return null;
  }
}
