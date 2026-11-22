import { Injectable } from '@nestjs/common';
import { AnalyticsService } from '@raijin/api-analytics';
import {
  ADMIN_KPI_KEYS,
  FUNNEL_STEPS,
  adminOverviewSchema,
  computeChange,
  type AdminKpi,
  type AdminKpiKey,
  type AdminOverview,
  type AdminRangeQuery,
  type AdminTrafficData,
  type DailyMetricKey,
  type DateRange,
  type FunnelStep,
  type FunnelStepKey,
  type GoogleServiceState,
  type MetricStatus,
} from '@raijin/shared-contracts';
import { addDays, resolveRange } from '../common/range';
import { MetricsReader, type MetricGrid } from '../metrics/metrics-reader';

/** Clés `DailyMetric` lues par la vue d'ensemble. */
export const OVERVIEW_KEYS: readonly DailyMetricKey[] = [
  'signups',
  'email_verified',
  'trials_active',
  'trials_started',
  'trials_converted',
  'mrr_cents',
  'subscribers_active',
  'subscriptions_new',
  'subscriptions_canceled',
  'analyses_total',
  'analyses_anonymous',
  'alerts_sent',
];

/** KPI interne : clé `DailyMetric` correspondante. */
const INTERNAL_KPI: Partial<Record<AdminKpiKey, { key: DailyMetricKey; unit: AdminKpi['unit'] }>> = {
  signups: { key: 'signups', unit: 'count' },
  verified_accounts: { key: 'email_verified', unit: 'count' },
  active_trials: { key: 'trials_active', unit: 'count' },
  trial_conversions: { key: 'trials_converted', unit: 'count' },
  mrr_cents: { key: 'mrr_cents', unit: 'cents' },
  active_subscribers: { key: 'subscribers_active', unit: 'count' },
  analyses: { key: 'analyses_total', unit: 'count' },
  alerts_sent: { key: 'alerts_sent', unit: 'count' },
};

/**
 * Churn d'une période : résiliations / abonnés actifs la veille du début ; `null` sans abonné au début. Borné à 1.
 */
export function churnRate(range: DateRange, reader: MetricsReader, grid: MetricGrid): number | null {
  const canceled = reader.value('subscriptions_canceled', range, grid);
  const before = addDays(range.from, -1);
  const base = grid.get('subscribers_active')?.get(before) ?? null;
  if (canceled === null || base === null || base === 0) return null;
  return Math.min(1, canceled / base);
}

/** Taux d'une étape de l'entonnoir : part de l'étape précédente (borné à 1), `null` si une valeur manque. */
export function stepRate(value: number | null, previous: number | null): number | null {
  if (value === null || previous === null || previous === 0) return null;
  return Math.min(1, value / previous);
}

function googleStatus(state: GoogleServiceState): MetricStatus {
  if (state.status === 'connected') return 'ok';
  return state.status === 'not_connected' ? 'not_connected' : 'unavailable';
}

/**
 * Vue d'ensemble (écran 1) : 10 KPI avec variation, tendance (inscriptions, analyses) et entonnoir
 * visites (GA4) → analyse démo → inscription → e-mail vérifié → essai → Pro.
 */
@Injectable()
export class OverviewService {
  constructor(
    private readonly reader: MetricsReader,
    private readonly analytics: AnalyticsService,
  ) {}

  async overview(query: AdminRangeQuery, now: Date): Promise<AdminOverview> {
    const range = resolveRange(query, now);
    // La veille de la période précédente sert de base au churn.
    const extended = { from: addDays(range.previous.from, -1), to: range.current.to };
    const [grid, ga4] = await Promise.all([
      this.reader.grid(OVERVIEW_KEYS, [extended], now),
      this.analytics.traffic({ current: range.current, previous: range.previous }),
    ]);
    const kpis = ADMIN_KPI_KEYS.map((key) => this.kpi(key, range.current, range.previous, grid, ga4.service, ga4.data));
    return adminOverviewSchema.parse({
      generatedAt: now.toISOString(),
      range,
      kpis,
      trend: [
        this.reader.series('signups', range.current, range.previous, grid),
        this.reader.series('analyses_total', range.current, range.previous, grid, 'analyses'),
      ],
      funnel: this.funnel(range.current, grid, ga4.service, ga4.data),
      ga4: ga4.service,
      aggregatedThrough: await this.reader.aggregatedThrough(),
    });
  }

  kpi(key: AdminKpiKey, current: DateRange, previous: DateRange, grid: MetricGrid, ga4: GoogleServiceState, traffic: AdminTrafficData | null): AdminKpi {
    if (key === 'landing_visitors') {
      const value = traffic?.totals.activeUsers ?? null;
      const before = traffic?.previousTotals?.activeUsers ?? null;
      return { key, unit: 'count', value, previous: before, change: computeChange(value, before), higherIsBetter: true, source: 'ga4', status: googleStatus(ga4) };
    }
    if (key === 'churn_rate') {
      const value = churnRate(current, this.reader, grid);
      const before = churnRate(previous, this.reader, grid);
      return { key, unit: 'ratio', value, previous: before, change: computeChange(value, before), higherIsBetter: false, source: 'internal', status: value === null ? 'unavailable' : 'ok' };
    }
    const internal = INTERNAL_KPI[key];
    if (!internal) throw new Error(`KPI inconnu : ${key}`);
    const value = this.reader.value(internal.key, current, grid);
    const before = this.reader.value(internal.key, previous, grid);
    return {
      key,
      unit: internal.unit,
      value,
      previous: before,
      change: computeChange(value, before),
      higherIsBetter: true,
      source: 'internal',
      status: value === null ? 'unavailable' : 'ok',
    };
  }

  funnel(range: DateRange, grid: MetricGrid, ga4: GoogleServiceState, traffic: AdminTrafficData | null): FunnelStep[] {
    const connected = ga4.status === 'connected' && traffic !== null;
    const demoEvents = traffic?.events.find((event) => event.name === 'analyse_demo_lancee')?.count ?? 0;
    const internal = (key: DailyMetricKey) => this.reader.value(key, range, grid);
    const values: Record<FunnelStepKey, { value: number | null; source: 'internal' | 'ga4'; status: MetricStatus }> = {
      landing_visits: { value: connected ? traffic.totals.sessions : null, source: 'ga4', status: googleStatus(ga4) },
      demo_analyses: connected
        ? { value: demoEvents, source: 'ga4', status: 'ok' }
        : { value: internal('analyses_anonymous'), source: 'internal', status: 'ok' },
      signups: { value: internal('signups'), source: 'internal', status: 'ok' },
      email_verified: { value: internal('email_verified'), source: 'internal', status: 'ok' },
      trials_started: { value: internal('trials_started'), source: 'internal', status: 'ok' },
      pro_conversions: { value: internal('subscriptions_new'), source: 'internal', status: 'ok' },
    };
    let previous: number | null = null;
    return FUNNEL_STEPS.map((key, index) => {
      const step = values[key];
      const value = step.value === null ? null : Math.round(step.value);
      const status: MetricStatus = value === null && step.status === 'ok' ? 'unavailable' : step.status;
      const rate = index === 0 ? null : stepRate(value, previous);
      previous = value;
      return { key, value, rateFromPrevious: rate, source: step.source, status };
    });
  }
}
