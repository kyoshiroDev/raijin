import { ADMIN_KPI_KEYS, type AdminKpi, type AdminKpiKey, type ResolvedRange, type TimeSeries } from '@raijin/shared-contracts';

/** Données de démonstration des composants admin (page `/admin/demo` en développement, `/_design/admin`, tests). */

const DAY_MS = 86_400_000;
const END = Date.parse('2026-11-22T00:00:00Z');

function isoDay(offset: number): string {
  return new Date(END - offset * DAY_MS).toISOString().slice(0, 10);
}

/** Série journalière déterministe (pas d'aléatoire : captures stables). */
export function demoSeries(key: string, days: number, base: number, amplitude: number, withGap = false): TimeSeries {
  const value = (index: number, shift: number) => Math.max(0, Math.round(base + amplitude * Math.sin((index + shift) / 3.2) + index * (amplitude / days) * 2));
  return {
    key,
    unit: 'count',
    points: Array.from({ length: days }, (_, index) => ({
      date: isoDay(days - 1 - index),
      value: withGap && index === Math.floor(days / 2) ? null : value(index, 0),
    })),
    comparison: Array.from({ length: days }, (_, index) => ({ date: isoDay(2 * days - 1 - index), value: Math.round(value(index, 2) * 0.82) })),
  };
}

export const DEMO_RANGE: ResolvedRange = {
  period: '30d',
  current: { from: isoDay(29), to: isoDay(0) },
  previous: { from: isoDay(59), to: isoDay(30) },
  timezone: 'UTC',
};

const KPI_VALUES: Readonly<Record<AdminKpiKey, Pick<AdminKpi, 'unit' | 'value' | 'previous' | 'higherIsBetter' | 'source' | 'status'>>> = {
  landing_visitors: { unit: 'count', value: 18_430, previous: 15_210, higherIsBetter: true, source: 'ga4', status: 'ok' },
  signups: { unit: 'count', value: 642, previous: 571, higherIsBetter: true, source: 'internal', status: 'ok' },
  verified_accounts: { unit: 'count', value: 519, previous: 498, higherIsBetter: true, source: 'internal', status: 'ok' },
  active_trials: { unit: 'count', value: 87, previous: 92, higherIsBetter: true, source: 'internal', status: 'ok' },
  trial_conversions: { unit: 'ratio', value: 0.184, previous: 0.162, higherIsBetter: true, source: 'internal', status: 'ok' },
  mrr_cents: { unit: 'cents', value: 412_350, previous: 368_900, higherIsBetter: true, source: 'internal', status: 'ok' },
  active_subscribers: { unit: 'count', value: 331, previous: 0, higherIsBetter: true, source: 'internal', status: 'ok' },
  churn_rate: { unit: 'ratio', value: 0.031, previous: 0.024, higherIsBetter: false, source: 'internal', status: 'ok' },
  analyses: { unit: 'count', value: 24_816, previous: 24_790, higherIsBetter: true, source: 'internal', status: 'ok' },
  alerts_sent: { unit: 'count', value: 1_284, previous: 1_410, higherIsBetter: true, source: 'internal', status: 'ok' },
};

export function demoKpis(ga4Connected = true): AdminKpi[] {
  return ADMIN_KPI_KEYS.map((key) => {
    const kpi = KPI_VALUES[key];
    const notConnected = !ga4Connected && kpi.source === 'ga4';
    const change = kpi.value !== null && kpi.previous ? (kpi.value - kpi.previous) / Math.abs(kpi.previous) : null;
    return {
      key,
      ...kpi,
      value: notConnected ? null : kpi.value,
      change: notConnected ? null : change,
      status: notConnected ? 'not_connected' : kpi.status,
    };
  });
}

export interface DemoPageRow {
  readonly path: string;
  readonly title: string;
  readonly views: number;
  readonly users: number;
  readonly engagement: number;
}

export const DEMO_TOP_PAGES: readonly DemoPageRow[] = [
  { path: '/', title: 'Raijin Shield, le bouclier anti-rug des memecoins Solana', views: 8_412, users: 6_120, engagement: 0.62 },
  { path: '/guides/verifier-un-token-solana', title: 'Vérifier un token Solana avant de signer', views: 3_208, users: 2_874, engagement: 0.71 },
  { path: '/guides/autorite-de-mint', title: 'Autorité de mint : le guide', views: 1_944, users: 1_702, engagement: 0.68 },
  { path: '/tarifs', title: 'Tarifs', views: 1_312, users: 1_190, engagement: 0.54 },
  { path: '/guides/liquidite-verrouillee', title: 'Liquidité verrouillée : ce que ça change', views: 988, users: 911, engagement: 0.66 },
];
