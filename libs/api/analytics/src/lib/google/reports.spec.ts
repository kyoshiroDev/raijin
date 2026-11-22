import { GA4_BATCH_MAX, GA4_DATA_API, Ga4Client, buildTraffic, trafficRequests } from './ga4-client';
import type { FetchFn } from './google-http';
import { SEARCH_CONSOLE_API, SearchConsoleClient, buildSeo, readRows, seoWindowDates } from './search-console-client';

const QUERY = { current: { from: '2026-11-16', to: '2026-11-22' }, previous: { from: '2026-11-09', to: '2026-11-15' } };

const report = (dimensionNames: string[], rows: [string[], string[]][]) => ({
  dimensionHeaders: dimensionNames.map((name) => ({ name })),
  metricHeaders: [],
  rows: rows.map(([dims, metrics]) => ({ dimensionValues: dims.map((value) => ({ value })), metricValues: metrics.map((value) => ({ value })) })),
});

function ga4Reports(): unknown[] {
  return [
    report(['dateRange'], [
      [['current'], ['700', '500', '910', '0.61', '52500']],
      [['previous'], ['600', '450', '800', '0.55', '42000']],
    ]),
    report(['date', 'dateRange'], [
      [['20261116', 'current'], ['100', '130']],
      [['20261118', 'current'], ['120', '150']],
      [['20261109', 'previous'], ['90', '110']],
    ]),
    report(['pagePath', 'pageTitle'], [
      [['/', 'Accueil'], ['400', '300']],
      [['/x\u0000<script>', '<img src=x onerror=alert(1)>'], ['3', '2']],
    ]),
    report(['sessionSource', 'sessionMedium'], [[['google', 'organic'], ['500', '20']], [['(direct)', '(none)'], ['200', '5']]]),
    report(['sessionDefaultChannelGroup'], [[['Organic Search'], ['600']], [['Direct'], ['200']]]),
    report(['deviceCategory'], [[['mobile'], ['600']], [['desktop'], ['300']], [['smart tv'], ['100']]]),
    report(['countryId', 'country'], [[['FR', 'France'], ['700']], [['zz', 'Inconnu'], ['10']]]),
    report(['eventName', 'isKeyEvent'], [[['page_view', 'false'], ['2000']], [['Bad Name!', 'false'], ['5']]]),
    report(['eventName', 'isKeyEvent'], [[['inscription_debut', 'true'], ['12']], [['page_view', 'false'], ['2000']]]),
  ];
}

describe('GA4 Data API (runReport par lots)', () => {
  it('requêtes : 2 lots de 5 au plus, périodes courante et précédente, métriques et dimensions officielles', () => {
    const batches = trafficRequests(QUERY);
    expect(batches).toHaveLength(2);
    expect(batches.every((batch) => batch.length <= GA4_BATCH_MAX)).toBe(true);
    expect(batches[0]?.[0]).toMatchObject({ dateRanges: [{ startDate: '2026-11-16', endDate: '2026-11-22', name: 'current' }, { startDate: '2026-11-09', endDate: '2026-11-15', name: 'previous' }] });
    expect(JSON.stringify(batches)).toContain('sessionDefaultChannelGroup');
    expect(JSON.stringify(batches[1]?.[3])).toContain('analyse_demo_lancee');
  });

  it('rapport assemblé : totaux, variation, séries complètes (jours sans visite à 0), parts, textes hostiles nettoyés', () => {
    const data = buildTraffic(ga4Reports(), QUERY);
    expect(data.totals).toMatchObject({ activeUsers: 700, newUsers: 500, sessions: 910, engagementRate: 0.61, averageEngagementSeconds: 75, mobileShare: 0.6 });
    expect(data.previousTotals?.activeUsers).toBe(600);
    expect(data.series[0]?.points).toHaveLength(7);
    expect(data.series[0]?.points.map((point) => point.value)).toEqual([100, 0, 120, 0, 0, 0, 0]);
    expect(data.series[0]?.comparison?.[0]).toEqual({ date: '2026-11-09', value: 90 });
    expect(data.topPages[1]?.path).toBe('/x <script>');
    expect(data.topPages[1]?.title).toBe('<img src=x onerror=alert(1)>');
    expect(data.devices.find((device) => device.category === 'other')).toMatchObject({ sessions: 100, share: 0.1 });
    expect(data.channels[0]).toEqual({ channel: 'Organic Search', sessions: 600, share: 0.75 });
    expect(data.countries[1]?.countryId).toBe('(not set)');
    expect(data.events.map((event) => event.name)).toEqual(['page_view', 'inscription_debut']);
    expect(data.events[1]?.isKeyEvent).toBe(true);
  });

  it('réponses vides ou absurdes : rapport valide à zéro', () => {
    const data = buildTraffic([null, { rows: 'x' }, {}, {}, {}, {}, {}, {}, {}], QUERY);
    expect(data.totals.activeUsers).toBe(0);
    expect(data.previousTotals).toBeNull();
    expect(data.series[1]?.points.every((point) => point.value === 0)).toBe(true);
  });

  it('client : hôte fixe, propriété encodée, jeton Bearer, 2 appels batchRunReports', async () => {
    const reports = ga4Reports();
    const calls: { url: string; body: { requests: unknown[] }; auth: string }[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url, body, auth: (init?.headers as Record<string, string>)['Authorization'] ?? '' });
      const offset = calls.length === 1 ? 0 : 5;
      return new Response(JSON.stringify({ reports: reports.slice(offset, offset + body.requests.length) }), { status: 200 });
    };
    const data = await new Ga4Client('123456', async () => 'jeton', fetchFn).traffic(QUERY);
    expect(calls.map((call) => call.url)).toEqual([`${GA4_DATA_API}/properties/123456:batchRunReports`, `${GA4_DATA_API}/properties/123456:batchRunReports`]);
    expect(calls[0]?.auth).toBe('Bearer jeton');
    expect(data.totals.sessions).toBe(910);
  });
});

describe('Search Console (searchAnalytics.query)', () => {
  it('fenêtre alignée sur le dernier jour disponible et décalage affiché', () => {
    expect(seoWindowDates('28d', '2026-11-22', '2026-11-19')).toEqual({
      dataThrough: '2026-11-19',
      startDate: '2026-10-23',
      previousEnd: '2026-10-22',
      previousStart: '2026-09-25',
      lagDays: 3,
    });
    // Aucune donnée : repli sur un décalage de 3 jours.
    expect(seoWindowDates('90d', '2026-11-22', null)).toMatchObject({ dataThrough: '2026-11-19', lagDays: 3 });
    // Date future (réponse absurde) ignorée.
    expect(seoWindowDates('28d', '2026-11-22', '2027-01-01').dataThrough).toBe('2026-11-19');
  });

  it('lignes : position nulle sans impression, valeurs bornées', () => {
    expect(readRows({ rows: [{ keys: ['a'], clicks: 2, impressions: 0, ctr: 3, position: 0 }] })[0]).toEqual({ keys: ['a'], clicks: 2, impressions: 0, ctr: 1, position: null });
    expect(readRows(null)).toEqual([]);
  });

  it('opportunités : positions 5 à 20, triées par impressions', () => {
    const rows = readRows({
      rows: [
        { keys: ['top'], clicks: 50, impressions: 400, ctr: 0.125, position: 2.1 },
        { keys: ['moyen'], clicks: 5, impressions: 300, ctr: 0.016, position: 8.4 },
        { keys: ['fort'], clicks: 2, impressions: 900, ctr: 0.002, position: 14 },
        { keys: ['loin'], clicks: 0, impressions: 1000, ctr: 0, position: 34 },
      ],
    });
    const dates = seoWindowDates('28d', '2026-11-22', '2026-11-20');
    const data = buildSeo('28d', dates, [], [], [], rows, []);
    expect(data.opportunities.map((row) => row.key)).toEqual(['fort', 'moyen']);
    expect(data.topQueries).toHaveLength(4);
    expect(data.series).toHaveLength(28);
    expect(data.previousTotals).toBeNull();
    expect(data.lagDays).toBe(2);
  });

  it('client : dataState final, propriété encodée, 5 requêtes', async () => {
    const urls: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      urls.push(url);
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const rows = body.dimensions?.[0] === 'date' ? [{ keys: ['2026-11-19'], clicks: 3, impressions: 90, ctr: 0.03, position: 9 }] : [{ keys: ['q'], clicks: 3, impressions: 90, ctr: 0.03, position: 9 }];
      return new Response(JSON.stringify({ rows }), { status: 200 });
    };
    const data = await new SearchConsoleClient('sc-domain:raijinshield.com', async () => 'jeton', fetchFn).seo({ window: '28d', today: '2026-11-22' });
    expect(urls).toHaveLength(5);
    expect(urls[0]).toBe(`${SEARCH_CONSOLE_API}/sites/sc-domain%3Araijinshield.com/searchAnalytics/query`);
    expect(bodies.every((body) => body['dataState'] === 'final' && body['type'] === 'web')).toBe(true);
    expect(data.dataThrough).toBe('2026-11-19');
    expect(data.opportunities[0]?.key).toBe('q');
  });
});
