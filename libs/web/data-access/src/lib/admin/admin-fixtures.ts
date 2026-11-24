import type {
  AdminAcquisition,
  AdminHealth,
  AdminOverview,
  AdminProduct,
  AdminRevenue,
  AdminSeo,
  AdminTraffic,
  AdminTrials,
  AdminUserDetail,
  AdminUserPage,
  ResolvedRange,
  TimeSeries,
} from '@raijin/shared-contracts';

/**
 * Réponses d'exemple des écrans admin (tests unitaires, `/admin/demo`), conformes aux contrats (vérifié par
 * `admin-api.spec.ts`). Valeurs fictives ; quelques textes hostiles pour vérifier l'échappement.
 */

export const ADMIN_FIXTURE_NOW = '2026-11-22T10:00:00.000Z';

export const ADMIN_FIXTURE_RANGE: ResolvedRange = {
  period: '7d',
  current: { from: '2026-11-16', to: '2026-11-22' },
  previous: { from: '2026-11-09', to: '2026-11-15' },
  timezone: 'UTC',
};

const DAYS = ['16', '17', '18', '19', '20', '21', '22'].map((day) => `2026-11-${day}`);
const PREVIOUS_DAYS = ['09', '10', '11', '12', '13', '14', '15'].map((day) => `2026-11-${day}`);

export function fixtureSeries(key: string, values: readonly (number | null)[], previous?: readonly (number | null)[], unit: TimeSeries['unit'] = 'count'): TimeSeries {
  return {
    key,
    unit,
    points: DAYS.map((date, index) => ({ date, value: values[index] ?? null })),
    ...(previous ? { comparison: PREVIOUS_DAYS.map((date, index) => ({ date, value: previous[index] ?? null })) } : {}),
  };
}

const CONNECTED = { status: 'connected', fetchedAt: ADMIN_FIXTURE_NOW, cachedUntil: '2026-11-22T11:00:00.000Z', simulated: true } as const;

export const ADMIN_OVERVIEW_FIXTURE: AdminOverview = {
  generatedAt: ADMIN_FIXTURE_NOW,
  range: ADMIN_FIXTURE_RANGE,
  kpis: [
    { key: 'landing_visitors', unit: 'count', value: 1520, previous: 1310, change: 0.16, higherIsBetter: true, source: 'ga4', status: 'ok' },
    { key: 'signups', unit: 'count', value: 84, previous: 70, change: 0.2, higherIsBetter: true, source: 'internal', status: 'ok' },
    { key: 'verified_accounts', unit: 'count', value: 63, previous: 56, change: 0.125, higherIsBetter: true, source: 'internal', status: 'ok' },
    { key: 'active_trials', unit: 'count', value: 34, previous: 27, change: 0.259, higherIsBetter: true, source: 'internal', status: 'ok' },
    { key: 'trial_conversions', unit: 'count', value: 7, previous: 0, change: null, higherIsBetter: true, source: 'internal', status: 'ok' },
    { key: 'mrr_cents', unit: 'cents', value: 63_360, previous: 56_430, change: 0.123, higherIsBetter: true, source: 'internal', status: 'ok' },
    { key: 'active_subscribers', unit: 'count', value: 64, previous: 57, change: 0.123, higherIsBetter: true, source: 'internal', status: 'ok' },
    { key: 'churn_rate', unit: 'ratio', value: 0.018, previous: 0.02, change: -0.1, higherIsBetter: false, source: 'internal', status: 'ok' },
    { key: 'analyses', unit: 'count', value: 812, previous: 770, change: 0.055, higherIsBetter: true, source: 'internal', status: 'ok' },
    { key: 'alerts_sent', unit: 'count', value: 21, previous: 21, change: 0, higherIsBetter: true, source: 'internal', status: 'ok' },
  ],
  trend: [
    fixtureSeries('signups', [10, 12, 14, 11, 13, 12, 12], [9, 10, 10, 11, 10, 10, 10]),
    fixtureSeries('analyses', [110, 120, 108, 125, 118, 115, 116], [100, 105, 112, 110, 115, 113, 115]),
  ],
  funnel: [
    { key: 'landing_visits', value: 1980, rateFromPrevious: null, exceedsPrevious: false, source: 'ga4', status: 'ok' },
    { key: 'demo_analyses', value: 320, rateFromPrevious: 0.162, exceedsPrevious: false, source: 'ga4', status: 'ok' },
    { key: 'signups', value: 84, rateFromPrevious: 0.263, exceedsPrevious: false, source: 'internal', status: 'ok' },
    { key: 'email_verified', value: 63, rateFromPrevious: 0.75, exceedsPrevious: false, source: 'internal', status: 'ok' },
    { key: 'trials_started', value: 42, rateFromPrevious: 0.667, exceedsPrevious: false, source: 'internal', status: 'ok' },
    { key: 'pro_conversions', value: 14, rateFromPrevious: 0.333, exceedsPrevious: false, source: 'internal', status: 'ok' },
  ],
  ga4: CONNECTED,
  aggregatedThrough: '2026-11-21',
};

export const ADMIN_TRAFFIC_FIXTURE: AdminTraffic = {
  range: ADMIN_FIXTURE_RANGE,
  service: CONNECTED,
  data: {
    totals: { activeUsers: 1520, newUsers: 1094, sessions: 1980, engagementRate: 0.61, averageEngagementSeconds: 84, mobileShare: 0.68 },
    previousTotals: { activeUsers: 1310, newUsers: 950, sessions: 1716, engagementRate: 0.58, averageEngagementSeconds: 79, mobileShare: 0.66 },
    series: [
      fixtureSeries('active_users', [200, 210, 190, 240, 230, 220, 230], [180, 185, 190, 186, 188, 190, 191]),
      fixtureSeries('sessions', [260, 275, 250, 310, 300, 290, 295], [240, 242, 250, 244, 246, 248, 246]),
    ],
    topPages: [
      { path: '/', title: 'Raijin : vérifie un token Solana avant d’acheter', views: 1080, users: 520 },
      { path: '/tarifs', title: 'Tarifs Raijin', views: 380, users: 182 },
      { path: '/guides/reconnaitre-un-rug-pull', title: null, views: 340, users: 167 },
      { path: '/?q=<script>alert(1)</script>', title: '<img src=x onerror=alert(1)>', views: 3, users: 2 },
    ],
    sources: [
      { source: 'google', medium: 'organic', sessions: 910, keyEvents: 36 },
      { source: '(direct)', medium: '(none)', sessions: 435, keyEvents: 12 },
      { source: 'x.com', medium: 'referral', sessions: 218, keyEvents: 9 },
    ],
    channels: [
      { channel: 'Organic Search', sessions: 970, share: 0.49 },
      { channel: 'Direct', sessions: 435, share: 0.22 },
      { channel: 'Referral', sessions: 317, share: 0.16 },
    ],
    devices: [
      { category: 'mobile', sessions: 1346, share: 0.68 },
      { category: 'desktop', sessions: 574, share: 0.29 },
      { category: 'tablet', sessions: 60, share: 0.03 },
    ],
    countries: [
      { countryId: 'FR', country: 'France', sessions: 1030 },
      { countryId: 'BE', country: 'Belgium', sessions: 238 },
      { countryId: '(not set)', country: '(not set)', sessions: 12 },
    ],
    events: [
      { name: 'page_view', count: 4158, isKeyEvent: false },
      { name: 'analyse_demo_lancee', count: 320, isKeyEvent: false },
      { name: 'cta_essai_clic', count: 91, isKeyEvent: true },
      { name: 'inscription_debut', count: 61, isKeyEvent: true },
    ],
  },
};

export const ADMIN_SEO_FIXTURE: AdminSeo = {
  service: CONNECTED,
  data: {
    window: '28d',
    startDate: '2026-10-23',
    dataThrough: '2026-11-19',
    lagDays: 3,
    totals: { clicks: 640, impressions: 15_200, ctr: 0.042, position: 11.4 },
    previousTotals: { clicks: 512, impressions: 13_100, ctr: 0.039, position: 12.6 },
    series: Array.from({ length: 28 }, (_, index) => {
      const date = new Date(Date.parse('2026-10-23T00:00:00Z') + index * 86_400_000).toISOString().slice(0, 10);
      return { date, clicks: 18 + (index % 7) * 2, impressions: 500 + index * 5, ctr: 0.04, position: 11 + (index % 5) * 0.3 };
    }),
    topQueries: [
      { key: 'vérifier token solana', clicks: 120, impressions: 1900, ctr: 0.063, position: 4.2 },
      { key: 'rug pull solana', clicks: 88, impressions: 2600, ctr: 0.034, position: 8.1 },
      { key: '<b>requête hostile</b>', clicks: 1, impressions: 40, ctr: 0.025, position: 19.5 },
    ],
    topPages: [{ key: 'https://raijinshield.com/', clicks: 300, impressions: 6000, ctr: 0.05, position: 6.2 }],
    opportunities: [
      { key: 'rug pull solana', clicks: 88, impressions: 2600, ctr: 0.034, position: 8.1 },
      { key: 'mint authority solana', clicks: 20, impressions: 1400, ctr: 0.014, position: 12.7 },
    ],
  },
};

export const ADMIN_ACQUISITION_FIXTURE: AdminAcquisition = {
  range: ADMIN_FIXTURE_RANGE,
  dimension: 'source',
  rows: [
    { value: 'google', signups: 40, verified: 31, trials: 22, payers: 6, conversionRate: 0.15, mrrCents: 5940, ga4Sessions: 910 },
    { value: null, signups: 24, verified: 18, trials: 12, payers: 3, conversionRate: 0.125, mrrCents: 2970, ga4Sessions: 435 },
    { value: 'x.com', signups: 12, verified: 9, trials: 6, payers: 1, conversionRate: 0.083, mrrCents: 825, ga4Sessions: 218 },
    { value: '<script>utm</script>', signups: 1, verified: 0, trials: 0, payers: 0, conversionRate: 0, mrrCents: 0, ga4Sessions: null },
  ],
  totals: { signups: 77, verified: 58, trials: 40, payers: 10 },
  ga4: CONNECTED,
};

export const ADMIN_REVENUE_FIXTURE: AdminRevenue = {
  range: ADMIN_FIXTURE_RANGE,
  mode: 'simulation',
  currency: 'EUR',
  mrrCents: 63_360,
  mrrPreviousCents: 56_430,
  mrrSeries: fixtureSeries('mrr_cents', [57_420, 58_410, 59_400, 60_390, 61_380, 62_370, 63_360], [50_490, 51_480, 52_470, 53_460, 54_450, 55_440, 56_430], 'cents'),
  activeSubscribers: 64,
  newSubscribers: 9,
  cancellations: 1,
  failedPayments: 2,
  churnRate: 0.018,
  intervalSplit: { month: 48, year: 16 },
  revenueBySource: [
    { source: 'google', payers: 30, mrrCents: 29_700 },
    { source: null, payers: 20, mrrCents: 19_800 },
  ],
};

export const ADMIN_TRIALS_FIXTURE: AdminTrials = {
  generatedAt: ADMIN_FIXTURE_NOW,
  activeTrials: 34,
  endingWithin48h: 6,
  conversion: {
    generatedAt: ADMIN_FIXTURE_NOW,
    totals: { started: 120, active: 34, converted: 21, expired: 65, conversionRate: 0.244 },
    refusals: { email_already_used: 3, disposable_domain: 4, fingerprint_seen: 2 },
    cohorts: [
      { weekStart: '2026-11-16', started: 30, active: 28, converted: 1, expired: 1, conversionRate: 0.5 },
      { weekStart: '2026-11-09', started: 34, active: 6, converted: 7, expired: 21, conversionRate: 0.25 },
      { weekStart: '2026-11-02', started: 31, active: 0, converted: 7, expired: 24, conversionRate: 0.226 },
    ],
  },
  nonConversionReasons: [],
};

export const ADMIN_PRODUCT_FIXTURE: AdminProduct = {
  range: ADMIN_FIXTURE_RANGE,
  analysesTotal: 812,
  analysesSeries: fixtureSeries('analyses_total', [110, 120, 108, 125, 118, 115, 116], [100, 105, 112, 110, 115, 113, 115]),
  verdictSplit: { safe: 420, warn: 250, danger: 142 },
  topTokens: [
    { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', name: 'Bonk', analyses: 54 },
    { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', name: 'USD Coin', analyses: 31 },
    { mint: 'So11111111111111111111111111111111111111112', symbol: null, name: '<img src=x>', analyses: 12 },
  ],
  responseTimeMs: { average: 2140, p95: 4800 },
  responseTimeSeries: fixtureSeries('analysis_duration_avg_ms', [2100, 2200, 2050, 2300, 2150, 2080, 2120], undefined, 'ms'),
  unavailableBySource: [
    { source: 'helius', checks: 812, unavailable: 4, rate: 0.005 },
    { source: 'dexscreener', checks: 812, unavailable: 12, rate: 0.015 },
    { source: 'rugcheck', checks: 790, unavailable: 61, rate: 0.077 },
    { source: 'solana_rpc', checks: 0, unavailable: 0, rate: null },
  ],
  walletScans: 96,
  activeWatches: 410,
};

export const ADMIN_HEALTH_FIXTURE: AdminHealth = {
  generatedAt: ADMIN_FIXTURE_NOW,
  jobs: [
    { name: 'metrics-aggregate', lastRunAt: '2026-11-22T02:15:00.000Z', lastStatus: 'success', lastDurationMs: 1820, consecutiveFailures: 0, lastErrorCode: null, nextRunAt: null },
    { name: 'purge', lastRunAt: '2026-11-22T03:30:00.000Z', lastStatus: 'failed', lastDurationMs: 410, consecutiveFailures: 3, lastErrorCode: 'ECONNRESET', nextRunAt: null },
    { name: 'watch-planner', lastRunAt: '2026-11-22T09:59:00.000Z', lastStatus: 'success', lastDurationMs: 95, consecutiveFailures: 0, lastErrorCode: null, nextRunAt: null },
    { name: 'admin-alerts', lastRunAt: null, lastStatus: null, lastDurationMs: null, consecutiveFailures: 0, lastErrorCode: null, nextRunAt: null },
  ],
  quotas: [
    { service: 'helius', period: 'day', used: 27_500, limit: 33_000, ratio: 0.833, level: 'warning' },
    { service: 'helius_watch', period: 'day', used: 9_000, limit: 15_000, ratio: 0.6, level: 'ok' },
    { service: 'jupiter', period: 'day', used: 1_200, limit: 40_000, ratio: 0.03, level: 'ok' },
    { service: 'rugcheck', period: 'day', used: 790, limit: null, ratio: null, level: 'ok' },
  ],
  api: { window: '24h', requests: 18_400, serverErrors: 12, errorRate: 0.00065, estimated: true },
  emails: { provider: 'smtp', sent24h: 140, failed24h: 1 },
  push: { provider: 'fake', activeSubscriptions: 37 },
  database: { sizeBytes: 182_000_000 },
  services: { database: 'configured', redis: 'configured', helius: 'configured', stripe: 'not_configured', ga4_data_api: 'not_configured', search_console: 'not_configured' },
  alerts: [
    {
      id: '0196f2a1-7c3e-7b2a-9c1d-2e3f4a5b6c7d',
      kind: 'job_failing',
      subject: 'purge',
      level: 'critical',
      details: { consecutiveFailures: 3, lastErrorCode: 'ECONNRESET' },
      createdAt: '2026-11-22T03:31:00.000Z',
      notifiedAt: '2026-11-22T03:40:00.000Z',
      resolvedAt: null,
    },
  ],
};

export const ADMIN_USER_PAGE_FIXTURE: AdminUserPage = {
  items: [
    {
      id: '0196f2a1-7c3e-7b2a-9c1d-2e3f4a5b6c01',
      email: 'alice@exemple.fr',
      plan: 'PRO',
      planSource: 'trial',
      role: 'USER',
      status: 'active',
      trialStatus: 'active',
      createdAt: '2026-11-18T09:12:00.000Z',
      lastLoginAt: '2026-11-22T08:01:00.000Z',
      utmSource: 'google',
    },
    {
      id: '0196f2a1-7c3e-7b2a-9c1d-2e3f4a5b6c02',
      email: 'bob@exemple.fr',
      plan: 'FREE',
      planSource: 'free',
      role: 'USER',
      status: 'unverified',
      trialStatus: 'none',
      createdAt: '2026-11-21T19:40:00.000Z',
      lastLoginAt: null,
      utmSource: null,
    },
  ],
  nextCursor: null,
  total: 2,
};

export const ADMIN_USER_DETAIL_FIXTURE: AdminUserDetail = {
  ...(ADMIN_USER_PAGE_FIXTURE.items[0] as AdminUserPage['items'][number]),
  emailVerified: true,
  trial: { status: 'active', startedAt: '2026-11-18T09:20:00.000Z', endsAt: '2026-11-25T09:20:00.000Z', daysRemaining: 3, endScreenDue: false, notice: null },
  subscription: null,
  stripeDashboardUrl: null,
  giftEndsAt: null,
  suspendedAt: null,
  attribution: { utmSource: 'google', utmMedium: 'organic', utmCampaign: null, referrer: 'https://www.google.com/', landingPath: '/guides/reconnaitre-un-rug-pull' },
  usage: { analysesToday: 3, analyses30d: 41, walletScans30d: 2, alerts30d: 5 },
  watches: { active: 4, paused: 0 },
  pushSubscriptions: 1,
  audit: [],
  availableActions: ['extend_trial', 'grant_pro_month', 'suspend', 'delete'],
};
