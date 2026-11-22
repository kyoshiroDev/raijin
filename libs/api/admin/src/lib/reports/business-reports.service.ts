import { Inject, Injectable } from '@nestjs/common';
import { AnalyticsService } from '@raijin/api-analytics';
import { BILLING_CONFIG, BillingProvider, type BillingConfig } from '@raijin/api-billing';
import { Prisma, PrismaService } from '@raijin/api-prisma';
import { TrialConversionService } from '@raijin/api-trial';
import {
  ADMIN_ACQUISITION_ROWS_MAX,
  ADMIN_TOP_ROWS_MAX,
  ADMIN_TOP_TOKENS_MAX,
  DATA_SOURCE_IDS,
  adminAcquisitionSchema,
  adminProductSchema,
  adminRevenueSchema,
  adminTrialsSchema,
  type AcquisitionDimension,
  type AcquisitionRow,
  type AdminAcquisition,
  type AdminAcquisitionQuery,
  type AdminProduct,
  type AdminRangeQuery,
  type AdminRevenue,
  type AdminTrials,
  type AdminTrafficData,
  type DailyMetricKey,
} from '@raijin/shared-contracts';
import { AdminStore, cached } from '../common/admin-store';
import { addDays, dayStart, resolveRange } from '../common/range';
import { MetricsReader } from '../metrics/metrics-reader';
import { churnRate } from './overview.service';

/** Cache de l'écran Acquisition (calcul en direct sur `User`). */
export const ACQUISITION_CACHE_TTL_S = 300;

/**
 * Expression SQL de chaque dimension (liste fermée : aucune valeur de la requête n'entre dans le SQL). Le site référent
 * est réduit à son hôte, en minuscules.
 */
const DIMENSION_SQL: Readonly<Record<AcquisitionDimension, Prisma.Sql>> = {
  source: Prisma.sql`lower(nullif(u."utmSource", ''))`,
  medium: Prisma.sql`lower(nullif(u."utmMedium", ''))`,
  campaign: Prisma.sql`nullif(u."utmCampaign", '')`,
  landing_path: Prisma.sql`nullif(u."landingPath", '')`,
  referrer_host: Prisma.sql`lower(substring(u."referrer" from '^https?://([^/:?#]+)'))`,
};

interface AcquisitionSqlRow {
  value: string | null;
  signups: number;
  verified: number;
  trials: number;
  payers: number;
  monthly: number;
  yearly: number;
}

/** Sessions GA4 par source (minuscules ; `(direct)` ↔ valeur absente). */
export function ga4SessionsBySource(traffic: AdminTrafficData | null): Map<string | null, number> | null {
  if (!traffic) return null;
  const sessions = new Map<string | null, number>();
  for (const row of traffic.sources) {
    const raw = row.source.trim().toLowerCase();
    const key = raw === '(direct)' || raw === '(not set)' || raw === '' ? null : raw;
    sessions.set(key, (sessions.get(key) ?? 0) + row.sessions);
  }
  return sessions;
}

const PRODUCT_KEYS: readonly DailyMetricKey[] = [
  'analyses_total',
  'verdict_safe',
  'verdict_warn',
  'verdict_danger',
  'analysis_duration_avg_ms',
  'wallet_scans',
  'watches_active',
  ...DATA_SOURCE_IDS.flatMap((source) => [`checks.${source}` as const, `checks_unavailable.${source}` as const]),
];

const REVENUE_KEYS: readonly DailyMetricKey[] = [
  'mrr_cents',
  'subscribers_active',
  'subscribers_monthly',
  'subscribers_yearly',
  'subscriptions_new',
  'subscriptions_canceled',
  'payments_failed',
];

/**
 * Écrans Acquisition, Revenus, Essais et Produit. Agrégats lus dans `DailyMetric` (jours passés) ; jointures et
 * classements calculés en direct, sans aucune donnée personnelle dans les réponses (comptes et sommes seulement).
 */
@Injectable()
export class BusinessReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reader: MetricsReader,
    private readonly analytics: AnalyticsService,
    private readonly store: AdminStore,
    private readonly trials: TrialConversionService,
    private readonly billingProvider: BillingProvider,
    @Inject(BILLING_CONFIG) private readonly billing: BillingConfig,
  ) {}

  // ------------------------------------------------------------------ Acquisition (écran 4)

  async acquisition(query: AdminAcquisitionQuery, now: Date): Promise<AdminAcquisition> {
    const range = resolveRange(query, now);
    const [rows, ga4] = await Promise.all([
      cached(this.store, `admin:acquisition:v1:${query.dimension}:${range.current.from}:${range.current.to}`, ACQUISITION_CACHE_TTL_S, () =>
        this.acquisitionRows(query.dimension, range.current.from, range.current.to),
      ),
      this.analytics.traffic({ current: range.current, previous: range.previous }),
    ]);
    const sessions = query.dimension === 'source' && ga4.service.status === 'connected' ? ga4SessionsBySource(ga4.data) : null;
    const { monthlyCents, yearlyCents } = this.billing.prices;
    const out: AcquisitionRow[] = rows.map((row) => {
      const signups = Number(row.signups);
      const payers = Number(row.payers);
      return {
        value: row.value === null ? null : row.value.slice(0, 512),
        signups,
        verified: Number(row.verified),
        trials: Number(row.trials),
        payers,
        conversionRate: signups > 0 ? Math.min(1, payers / signups) : null,
        mrrCents: Math.round(Number(row.monthly) * monthlyCents + (Number(row.yearly) * yearlyCents) / 12),
        ga4Sessions: sessions ? (sessions.get(row.value) ?? null) : null,
      };
    });
    const totals = out.reduce(
      (sum, row) => ({ signups: sum.signups + row.signups, verified: sum.verified + row.verified, trials: sum.trials + row.trials, payers: sum.payers + row.payers }),
      { signups: 0, verified: 0, trials: 0, payers: 0 },
    );
    return adminAcquisitionSchema.parse({ range, dimension: query.dimension, rows: out, totals, ga4: ga4.service });
  }

  private async acquisitionRows(dimension: AcquisitionDimension, from: string, to: string): Promise<AcquisitionSqlRow[]> {
    const value = DIMENSION_SQL[dimension];
    const start = dayStart(from);
    const end = dayStart(addDays(to, 1));
    const rows = await this.prisma.$queryRaw<AcquisitionSqlRow[]>`
      SELECT ${value} AS "value",
        count(*)::int AS "signups",
        count(*) FILTER (WHERE u."emailVerifiedAt" IS NOT NULL)::int AS "verified",
        count(*) FILTER (WHERE u."trialStartedAt" IS NOT NULL)::int AS "trials",
        count(*) FILTER (WHERE s."interval" IS NOT NULL)::int AS "payers",
        count(*) FILTER (WHERE s."interval" = 'MONTH')::int AS "monthly",
        count(*) FILTER (WHERE s."interval" = 'YEAR')::int AS "yearly"
      FROM "User" u
      LEFT JOIN LATERAL (
        SELECT s."interval" FROM "Subscription" s
        WHERE s."userId" = u."id" AND s."status"::text IN ('ACTIVE', 'PAST_DUE')
        ORDER BY s."createdAt" DESC LIMIT 1
      ) s ON true
      WHERE u."createdAt" >= ${start} AND u."createdAt" < ${end}
      GROUP BY 1
      ORDER BY 2 DESC, 1 ASC NULLS LAST
      LIMIT ${ADMIN_ACQUISITION_ROWS_MAX}`;
    return rows.map((row) => ({ ...row, signups: Number(row.signups), verified: Number(row.verified), trials: Number(row.trials), payers: Number(row.payers), monthly: Number(row.monthly), yearly: Number(row.yearly) }));
  }

  // ------------------------------------------------------------------ Revenus (écran 5)

  async revenue(query: AdminRangeQuery, now: Date): Promise<AdminRevenue> {
    const range = resolveRange(query, now);
    const extended = { from: addDays(range.previous.from, -1), to: range.current.to };
    const grid = await this.reader.grid(REVENUE_KEYS, [extended], now);
    const value = (key: DailyMetricKey, r = range.current) => this.reader.value(key, r, grid);
    const bySource = await this.prisma.$queryRaw<{ source: string | null; monthly: number; yearly: number }[]>`
      SELECT lower(nullif(u."utmSource", '')) AS "source",
        count(*) FILTER (WHERE s."interval" = 'MONTH')::int AS "monthly",
        count(*) FILTER (WHERE s."interval" = 'YEAR')::int AS "yearly"
      FROM "Subscription" s JOIN "User" u ON u."id" = s."userId"
      WHERE s."status"::text IN ('ACTIVE', 'PAST_DUE')
      GROUP BY 1
      ORDER BY count(*) DESC, 1 ASC NULLS LAST
      LIMIT ${ADMIN_TOP_ROWS_MAX}`;
    const { monthlyCents, yearlyCents } = this.billing.prices;
    return adminRevenueSchema.parse({
      range,
      mode: this.billingProvider.mode(),
      currency: this.billing.prices.currency,
      mrrCents: Math.round(value('mrr_cents') ?? 0),
      mrrPreviousCents: value('mrr_cents', range.previous) === null ? null : Math.round(value('mrr_cents', range.previous) as number),
      mrrSeries: this.reader.series('mrr_cents', range.current, range.previous, grid),
      activeSubscribers: Math.round(value('subscribers_active') ?? 0),
      newSubscribers: Math.round(value('subscriptions_new') ?? 0),
      cancellations: Math.round(value('subscriptions_canceled') ?? 0),
      failedPayments: Math.round(value('payments_failed') ?? 0),
      churnRate: churnRate(range.current, this.reader, grid),
      intervalSplit: { month: Math.round(value('subscribers_monthly') ?? 0), year: Math.round(value('subscribers_yearly') ?? 0) },
      revenueBySource: bySource.map((row) => ({
        source: row.source === null ? null : row.source.slice(0, 200),
        payers: Number(row.monthly) + Number(row.yearly),
        mrrCents: Math.round(Number(row.monthly) * monthlyCents + (Number(row.yearly) * yearlyCents) / 12),
      })),
    });
  }

  // ------------------------------------------------------------------ Essais (écran 6)

  async trialsReport(now: Date): Promise<AdminTrials> {
    const in48h = new Date(now.getTime() + 48 * 3_600_000);
    const [activeTrials, endingWithin48h, conversion] = await Promise.all([
      this.prisma.user.count({ where: { trialStatus: 'ACTIVE', trialEndsAt: { gt: now } } }),
      this.prisma.user.count({ where: { trialStatus: 'ACTIVE', trialEndsAt: { gt: now, lte: in48h } } }),
      this.trials.report(now),
    ]);
    // Raisons de non-conversion : aucune collecte en v1 (liste vide, l'écran l'indique).
    return adminTrialsSchema.parse({ generatedAt: now.toISOString(), activeTrials, endingWithin48h, conversion, nonConversionReasons: [] });
  }

  // ------------------------------------------------------------------ Produit (écran 8)

  async product(query: AdminRangeQuery, now: Date): Promise<AdminProduct> {
    const range = resolveRange(query, now);
    const grid = await this.reader.grid(PRODUCT_KEYS, [range.previous, range.current], now);
    const value = (key: DailyMetricKey) => Math.round(this.reader.value(key, range.current, grid) ?? 0);
    const start = dayStart(range.current.from);
    const end = dayStart(addDays(range.current.to, 1));
    const [tokens, timing] = await Promise.all([
      this.prisma.$queryRaw<{ mint: string; analyses: number; token: unknown }[]>`
        SELECT t."mint", count(*)::int AS "analyses",
          (SELECT l."token" FROM "TokenAnalysis" l WHERE l."mint" = t."mint" ORDER BY l."createdAt" DESC LIMIT 1) AS "token"
        FROM "TokenAnalysis" t
        WHERE t."createdAt" >= ${start} AND t."createdAt" < ${end}
        GROUP BY t."mint" ORDER BY 2 DESC, 1 ASC LIMIT ${ADMIN_TOP_TOKENS_MAX}`,
      this.prisma.$queryRaw<{ avg: number | null; p95: number | null }[]>`
        SELECT avg("durationMs")::float8 AS "avg", (percentile_cont(0.95) WITHIN GROUP (ORDER BY "durationMs"))::float8 AS "p95"
        FROM "TokenAnalysis" WHERE "createdAt" >= ${start} AND "createdAt" < ${end}`,
    ]);
    const text = (token: unknown, field: 'symbol' | 'name', max: number): string | null => {
      const raw = token && typeof token === 'object' ? (token as Record<string, unknown>)[field] : null;
      if (typeof raw !== 'string') return null;
      // eslint-disable-next-line no-control-regex
      const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
      return clean ? Array.from(clean).slice(0, max).join('') : null;
    };
    return adminProductSchema.parse({
      range,
      analysesTotal: value('analyses_total'),
      analysesSeries: this.reader.series('analyses_total', range.current, range.previous, grid),
      verdictSplit: { safe: value('verdict_safe'), warn: value('verdict_warn'), danger: value('verdict_danger') },
      topTokens: tokens.map((row) => ({
        mint: row.mint,
        symbol: text(row.token, 'symbol', 32),
        name: text(row.token, 'name', 64),
        analyses: Number(row.analyses),
      })),
      responseTimeMs: {
        average: timing[0]?.avg === null || timing[0]?.avg === undefined ? null : Math.round(Number(timing[0].avg)),
        p95: timing[0]?.p95 === null || timing[0]?.p95 === undefined ? null : Math.round(Number(timing[0].p95)),
      },
      responseTimeSeries: this.reader.series('analysis_duration_avg_ms', range.current, range.previous, grid),
      unavailableBySource: DATA_SOURCE_IDS.map((source) => {
        const checks = value(`checks.${source}`);
        const unavailable = value(`checks_unavailable.${source}`);
        return { source, checks, unavailable, rate: checks > 0 ? Math.min(1, unavailable / checks) : null };
      }),
      walletScans: value('wallet_scans'),
      activeWatches: Math.round(this.reader.value('watches_active', range.current, grid) ?? 0),
    });
  }
}
