import { adminSeoSchema, adminTrafficDataSchema, adminTrafficSchema } from '@raijin/shared-contracts';
import { fakeSeo, fakeTraffic } from '../testing/fixtures/fake-reports';
import { AnalyticsService, type ReportSources } from './analytics.service';
import { MemoryAnalyticsCache } from './cache/analytics-cache';
import { analyticsConfigFrom, type AnalyticsConfig } from './config/analytics-config';
import { GoogleApiError } from './google/google-http';
import type { ReportSource } from './reports/report-source';
import { createReportSources, FakeReportSource } from './reports/sources';

const QUERY = { current: { from: '2026-11-16', to: '2026-11-22' }, previous: { from: '2026-11-09', to: '2026-11-15' } };
const NOW = new Date('2026-11-22T10:00:00.000Z');

const base: AnalyticsConfig = {
  provider: 'google',
  serviceAccount: { clientEmail: 'a@b.iam.gserviceaccount.com', privateKey: 'pem' },
  serviceAccountInvalid: false,
  ga4PropertyId: '123',
  searchConsoleSiteUrl: 'sc-domain:raijinshield.com',
  cacheTtlS: 3600,
  errorCacheTtlS: 300,
};

function source(traffic: jest.Mock, simulated = false): ReportSource {
  return { simulated, traffic, seo: jest.fn() };
}

describe('AnalyticsService', () => {
  it('sans compte de service : « Non connecté », aucun appel', async () => {
    const service = new AnalyticsService({ ...base, provider: 'none', serviceAccount: null }, new MemoryAnalyticsCache(), { ga4: null, searchConsole: null });
    await expect(service.traffic(QUERY)).resolves.toEqual({ service: { status: 'not_connected' }, data: null });
    await expect(service.seo({ window: '28d', today: '2026-11-22' })).resolves.toEqual({ service: { status: 'not_connected' }, data: null });
    expect(service.isConfigured('ga4')).toBe(false);
  });

  it('propriété manquante : non connecté ; JSON illisible : auth_failed', async () => {
    const traffic = jest.fn();
    const noProperty = new AnalyticsService({ ...base, ga4PropertyId: null }, new MemoryAnalyticsCache(), { ga4: source(traffic), searchConsole: null });
    expect((await noProperty.traffic(QUERY)).service).toEqual({ status: 'not_connected' });
    const invalid = new AnalyticsService({ ...base, serviceAccount: null, serviceAccountInvalid: true }, new MemoryAnalyticsCache(), { ga4: null, searchConsole: null });
    expect((await invalid.traffic(QUERY)).service).toEqual({ status: 'error', error: 'auth_failed' });
    expect(traffic).not.toHaveBeenCalled();
  });

  it('connecté : données validées, cache 1 h (un seul appel), fetchedAt / cachedUntil', async () => {
    const traffic = jest.fn(async () => fakeTraffic(QUERY));
    const cache = new MemoryAnalyticsCache(() => NOW.getTime());
    const service = new AnalyticsService(base, cache, { ga4: source(traffic), searchConsole: null }, () => NOW);
    const first = await service.traffic(QUERY);
    const second = await service.traffic(QUERY);
    expect(traffic).toHaveBeenCalledTimes(1);
    expect(first.service).toEqual({ status: 'connected', fetchedAt: NOW.toISOString(), cachedUntil: '2026-11-22T11:00:00.000Z', simulated: false });
    expect(second).toEqual(first);
    expect(adminTrafficSchema.safeParse({ range: { period: '7d', current: QUERY.current, previous: QUERY.previous, timezone: 'UTC' }, ...first }).success).toBe(true);
  });

  it('erreur Google : code interne, gardée 5 min (pas de martèlement), jamais d’exception', async () => {
    let now = NOW.getTime();
    const traffic = jest.fn(async () => {
      throw new GoogleApiError('permission_denied', 403);
    });
    const service = new AnalyticsService(base, new MemoryAnalyticsCache(() => now), { ga4: source(traffic), searchConsole: null }, () => new Date(now));
    expect(await service.traffic(QUERY)).toEqual({ service: { status: 'error', error: 'permission_denied' }, data: null });
    await service.traffic(QUERY);
    expect(traffic).toHaveBeenCalledTimes(1);
    now += 301_000;
    await service.traffic(QUERY);
    expect(traffic).toHaveBeenCalledTimes(2);
  });

  it('erreur inattendue (réponse hors contrat) → unavailable', async () => {
    const traffic = jest.fn(async () => {
      throw new Error('schema');
    });
    const service = new AnalyticsService(base, new MemoryAnalyticsCache(), { ga4: source(traffic), searchConsole: null });
    expect((await service.traffic(QUERY)).service).toEqual({ status: 'error', error: 'unavailable' });
  });

  it('entrée de cache altérée : ignorée et relue chez Google', async () => {
    const cache = new MemoryAnalyticsCache();
    const traffic = jest.fn(async () => fakeTraffic(QUERY));
    const service = new AnalyticsService(base, cache, { ga4: source(traffic), searchConsole: null });
    await service.traffic(QUERY);
    const key = [...(cache as unknown as { entries: Map<string, unknown> }).entries.keys()][0] as string;
    expect(key).toMatch(/^analytics:v1:ga4:[0-9a-f]{64}$/);
    await cache.set(key, JSON.stringify({ ok: true, fetchedAt: 'x', cachedUntil: 'y', data: { totals: 'piégé' } }), 60);
    await service.traffic(QUERY);
    expect(traffic).toHaveBeenCalledTimes(2);
  });

  it('simulation (fake) : données déterministes marquées simulated', async () => {
    const config = { ...base, provider: 'fake' as const, serviceAccount: null };
    const sources: ReportSources = createReportSources(config);
    expect(sources.ga4).toBeInstanceOf(FakeReportSource);
    const service = new AnalyticsService(config, new MemoryAnalyticsCache(), sources);
    const traffic = await service.traffic(QUERY);
    expect(traffic.service).toMatchObject({ status: 'connected', simulated: true });
    const seo = await service.seo({ window: '90d', today: '2026-11-22' });
    expect(adminSeoSchema.parse(seo).data?.lagDays).toBe(3);
  });

  it('sources réelles seulement avec compte de service et propriété', () => {
    expect(createReportSources({ ...base, provider: 'none', serviceAccount: null })).toEqual({ ga4: null, searchConsole: null });
    const partial = createReportSources({ ...base, searchConsoleSiteUrl: null });
    expect(partial.ga4).not.toBeNull();
    expect(partial.searchConsole).toBeNull();
  });
});

describe('analyticsConfigFrom', () => {
  it('JSON illisible : signalé (auth_failed), jamais de valeur dans l’avertissement', () => {
    const warn = jest.fn();
    const config = analyticsConfigFrom({ provider: 'google', ga4PropertyId: '1', searchConsoleSiteUrl: null, serviceAccountJson: '{"secret":"x"}', cacheTtlS: 3600 }, warn);
    expect(config).toMatchObject({ serviceAccount: null, serviceAccountInvalid: true, errorCacheTtlS: 300 });
    expect(warn.mock.calls[0]?.[0]).not.toContain('secret');
  });
});

describe('Données simulées', () => {
  it('déterministes et conformes aux contrats', () => {
    expect(fakeTraffic(QUERY)).toEqual(fakeTraffic(QUERY));
    expect(adminTrafficDataSchema.safeParse(fakeTraffic(QUERY)).success).toBe(true);
    const seo = fakeSeo({ window: '28d', today: '2026-11-22' });
    expect(seo.dataThrough).toBe('2026-11-19');
    expect(seo.opportunities.every((row) => (row.position ?? 0) >= 5 && (row.position ?? 99) <= 20)).toBe(true);
  });
});
