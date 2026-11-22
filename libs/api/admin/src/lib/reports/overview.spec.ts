import { fakeTraffic, type AnalyticsService, type GoogleResult } from '@raijin/api-analytics';
import { ADMIN_KPI_KEYS, adminOverviewSchema, type AdminTrafficData, type DailyMetricKey } from '@raijin/shared-contracts';
import { rangeDays, resolveRange } from '../common/range';
import { MetricsReader, aggregateDays, type MetricGrid } from '../metrics/metrics-reader';
import { OverviewService, churnRate, stepRate } from './overview.service';

const NOW = new Date('2026-11-22T12:00:00.000Z');
const RANGE = resolveRange({ period: '7d' }, NOW);

/**
 * Fixture : 14 jours (période précédente + courante) avec des valeurs connues.
 * Inscriptions : 10 / jour avant, 12 / jour pendant ; MRR et abonnés croissants (instantanés).
 */
function fixtureGrid(): MetricGrid {
  const grid: MetricGrid = new Map();
  const put = (key: DailyMetricKey, day: string, value: number) => {
    if (!grid.has(key)) grid.set(key, new Map());
    grid.get(key)?.set(day, value);
  };
  const days = rangeDays({ from: '2026-11-08', to: RANGE.current.to });
  days.forEach((day, index) => {
    const current = day >= RANGE.current.from;
    put('signups', day, current ? 12 : 10);
    put('email_verified', day, current ? 9 : 8);
    put('trials_started', day, current ? 6 : 5);
    put('trials_converted', day, current ? 1 : 0);
    put('subscriptions_new', day, current ? 2 : 1);
    put('subscriptions_canceled', day, index % 7 === 0 ? 1 : 0);
    put('analyses_total', day, 100 + index);
    put('analyses_anonymous', day, 40);
    put('alerts_sent', day, 3);
    put('trials_active', day, 20 + index);
    put('subscribers_active', day, 50 + index);
    put('mrr_cents', day, (50 + index) * 990);
  });
  return grid;
}

const reader = new MetricsReader({} as never, {} as never, {} as never);
const service = new OverviewService(reader, {} as AnalyticsService);
const traffic = fakeTraffic({ current: RANGE.current, previous: RANGE.previous });
const connected = { status: 'connected', fetchedAt: NOW.toISOString(), cachedUntil: NOW.toISOString(), simulated: true } as const;

describe('Agrégation des métriques', () => {
  it('sum, last, moyenne pondérée ; null sans valeur', () => {
    const grid: MetricGrid = new Map([
      ['signups', new Map([['2026-11-01', 3], ['2026-11-02', 4]])],
      ['mrr_cents', new Map([['2026-11-01', 100], ['2026-11-02', 250]])],
      ['analysis_duration_avg_ms', new Map([['2026-11-01', 1000], ['2026-11-02', 4000]])],
      ['analyses_total', new Map([['2026-11-01', 3], ['2026-11-02', 1]])],
    ]);
    const days = ['2026-11-01', '2026-11-02', '2026-11-03'];
    expect(aggregateDays('signups', days, grid)).toBe(7);
    expect(aggregateDays('mrr_cents', days, grid)).toBe(250);
    expect(aggregateDays('analysis_duration_avg_ms', days, grid)).toBe(1750);
    expect(aggregateDays('alerts_sent', days, grid)).toBeNull();
  });
});

describe('KPI de la vue d’ensemble (fixtures)', () => {
  const grid = fixtureGrid();

  it('flux additionnés, instantanés en dernière valeur, variation vs période précédente', () => {
    const signups = service.kpi('signups', RANGE.current, RANGE.previous, grid, connected, traffic);
    expect(signups).toMatchObject({ value: 84, previous: 70, change: 0.2, higherIsBetter: true, status: 'ok', source: 'internal' });
    const mrr = service.kpi('mrr_cents', RANGE.current, RANGE.previous, grid, connected, traffic);
    expect(mrr).toMatchObject({ unit: 'cents', value: 64 * 990, previous: 57 * 990 });
    expect(mrr.change).toBeCloseTo(7 / 57);
    expect(service.kpi('active_subscribers', RANGE.current, RANGE.previous, grid, connected, traffic).value).toBe(64);
    expect(service.kpi('trial_conversions', RANGE.current, RANGE.previous, grid, connected, traffic)).toMatchObject({ value: 7, previous: 0, change: null });
  });

  it('churn : résiliations / abonnés la veille du début, une hausse est mauvaise', () => {
    // Période courante : 1 résiliation (index 7) ; base = abonnés du 2026-11-15 (index 7) = 57.
    expect(churnRate(RANGE.current, reader, grid)).toBeCloseTo(1 / 57);
    const churn = service.kpi('churn_rate', RANGE.current, RANGE.previous, grid, connected, traffic);
    expect(churn.higherIsBetter).toBe(false);
    expect(churn.unit).toBe('ratio');
    // Période précédente : base du 2026-11-08 = 50, 1 résiliation (index 0).
    expect(churn.previous).toBeCloseTo(1 / 50);
  });

  it('visiteurs : GA4 si connecté, sinon « Non connecté » sans valeur', () => {
    const visitors = service.kpi('landing_visitors', RANGE.current, RANGE.previous, grid, connected, traffic);
    expect(visitors).toMatchObject({ source: 'ga4', status: 'ok', value: traffic.totals.activeUsers, previous: traffic.previousTotals?.activeUsers });
    expect(service.kpi('landing_visitors', RANGE.current, RANGE.previous, grid, { status: 'not_connected' }, null)).toMatchObject({ value: null, status: 'not_connected' });
    expect(service.kpi('landing_visitors', RANGE.current, RANGE.previous, grid, { status: 'error', error: 'quota_exceeded' }, null).status).toBe('unavailable');
  });

  it('agrégat absent : valeur nulle et statut unavailable', () => {
    expect(service.kpi('signups', RANGE.current, RANGE.previous, new Map(), connected, traffic)).toMatchObject({ value: null, status: 'unavailable', change: null });
  });
});

describe('Entonnoir visites → démo → inscription → vérifié → essai → Pro (fixtures)', () => {
  const grid = fixtureGrid();

  it('GA4 connecté : visites et analyses démo depuis GA4, taux par étape', () => {
    const data: AdminTrafficData = {
      ...traffic,
      totals: { ...traffic.totals, sessions: 1000 },
      events: [{ name: 'analyse_demo_lancee', count: 250, isKeyEvent: false }],
    };
    const funnel = service.funnel(RANGE.current, grid, connected, data);
    expect(funnel.map((step) => [step.key, step.value, step.rateFromPrevious])).toEqual([
      ['landing_visits', 1000, null],
      ['demo_analyses', 250, 0.25],
      ['signups', 84, 84 / 250],
      ['email_verified', 63, 0.75],
      ['trials_started', 42, 42 / 63],
      ['pro_conversions', 14, 14 / 42],
    ]);
    expect(funnel[1]?.source).toBe('ga4');
  });

  it('GA4 non connecté : visites « Non connecté », démo = analyses anonymes internes', () => {
    const funnel = service.funnel(RANGE.current, grid, { status: 'not_connected' }, null);
    expect(funnel[0]).toMatchObject({ value: null, status: 'not_connected', rateFromPrevious: null });
    expect(funnel[1]).toMatchObject({ value: 280, source: 'internal', rateFromPrevious: null });
    expect(funnel[2]?.rateFromPrevious).toBeCloseTo(84 / 280);
  });

  it('taux borné à 1 et nul sans étape précédente', () => {
    expect(stepRate(5, 2)).toBe(1);
    expect(stepRate(5, 0)).toBeNull();
    expect(stepRate(null, 3)).toBeNull();
  });

  it('réponse complète conforme au contrat', async () => {
    const analytics = { traffic: jest.fn(async (): Promise<GoogleResult<AdminTrafficData>> => ({ service: connected, data: traffic })) };
    const stubReader = Object.assign(Object.create(MetricsReader.prototype) as MetricsReader, {
      grid: async () => grid,
      aggregatedThrough: async () => '2026-11-21',
    });
    const overview = await new OverviewService(stubReader, analytics as unknown as AnalyticsService).overview({ period: '7d' }, NOW);
    expect(adminOverviewSchema.safeParse(overview).success).toBe(true);
    expect(overview.kpis.map((kpi) => kpi.key)).toEqual([...ADMIN_KPI_KEYS]);
    expect(overview.trend[0]?.comparison).toHaveLength(7);
    expect(overview.aggregatedThrough).toBe('2026-11-21');
  });
});
