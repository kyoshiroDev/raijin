import {
  ADMIN_TOP_ROWS_MAX,
  GA4_DEVICE_CATEGORIES,
  GA4_EVENT_NAMES,
  adminTrafficDataSchema,
  type AdminTrafficData,
  type DateRange,
  type Ga4DeviceCategory,
  type TrafficTotals,
} from '@raijin/shared-contracts';
import { daysBetween, type TrafficQuery } from '../reports/report-source';
import { cleanCount, cleanNumber, cleanRatio, cleanText, share } from '../reports/sanitize';
import { postJson, type FetchFn } from './google-http';

/** Hôte fixe de l'API Google Analytics Data (v1beta). Au plus 5 rapports par lot (`batchRunReports`). */
export const GA4_DATA_API = 'https://analyticsdata.googleapis.com/v1beta';
export const GA4_BATCH_MAX = 5;

interface Ga4Row {
  readonly dimensions: readonly string[];
  readonly metrics: readonly string[];
}

interface Ga4Report {
  readonly dimensionNames: readonly string[];
  readonly rows: readonly Ga4Row[];
}

type Json = Record<string, unknown>;

const range = (r: DateRange, name: string) => ({ startDate: r.from, endDate: r.to, name });
const metrics = (...names: string[]) => names.map((name) => ({ name }));
const dimensions = (...names: string[]) => names.map((name) => ({ name }));
const byMetricDesc = (metricName: string) => [{ metric: { metricName }, desc: true }];

/** Requêtes `runReport` de l'écran Trafic (2 lots de 5 au plus). */
export function trafficRequests(query: TrafficQuery): Json[][] {
  const both = [range(query.current, 'current'), range(query.previous, 'previous')];
  const current = [range(query.current, 'current')];
  const top = ADMIN_TOP_ROWS_MAX;
  return [
    [
      { dateRanges: both, metrics: metrics('activeUsers', 'newUsers', 'sessions', 'engagementRate', 'userEngagementDuration') },
      { dateRanges: both, dimensions: dimensions('date'), metrics: metrics('activeUsers', 'sessions'), limit: 1000 },
      { dateRanges: current, dimensions: dimensions('pagePath', 'pageTitle'), metrics: metrics('screenPageViews', 'activeUsers'), orderBys: byMetricDesc('screenPageViews'), limit: top },
      { dateRanges: current, dimensions: dimensions('sessionSource', 'sessionMedium'), metrics: metrics('sessions', 'keyEvents'), orderBys: byMetricDesc('sessions'), limit: top },
      { dateRanges: current, dimensions: dimensions('sessionDefaultChannelGroup'), metrics: metrics('sessions'), orderBys: byMetricDesc('sessions'), limit: top },
    ],
    [
      { dateRanges: current, dimensions: dimensions('deviceCategory'), metrics: metrics('sessions'), limit: 10 },
      { dateRanges: current, dimensions: dimensions('countryId', 'country'), metrics: metrics('sessions'), orderBys: byMetricDesc('sessions'), limit: top },
      { dateRanges: current, dimensions: dimensions('eventName', 'isKeyEvent'), metrics: metrics('eventCount'), orderBys: byMetricDesc('eventCount'), limit: top },
      {
        dateRanges: current,
        dimensions: dimensions('eventName', 'isKeyEvent'),
        metrics: metrics('eventCount'),
        dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: [...GA4_EVENT_NAMES] } } },
        limit: top,
      },
    ],
  ];
}

/** Lecture défensive d'un `RunReportResponse` (JSON non fiable). */
export function readReport(raw: unknown): Ga4Report {
  const report = (raw ?? {}) as Json;
  const names = (list: unknown) => (Array.isArray(list) ? list.map((header) => String((header as Json)?.['name'] ?? '')) : []);
  const values = (list: unknown) => (Array.isArray(list) ? list.map((cell) => String((cell as Json)?.['value'] ?? '')) : []);
  const rows = Array.isArray(report['rows']) ? report['rows'].slice(0, 2_000) : [];
  return {
    dimensionNames: names(report['dimensionHeaders']),
    rows: rows.map((row) => ({ dimensions: values((row as Json)?.['dimensionValues']), metrics: values((row as Json)?.['metricValues']) })),
  };
}

/** Valeur de la dimension `dateRange` ajoutée par GA4 quand plusieurs périodes sont demandées. */
function rangeOf(report: Ga4Report, row: Ga4Row): string {
  const index = report.dimensionNames.indexOf('dateRange');
  return index >= 0 ? (row.dimensions[index] ?? 'current') : 'current';
}

function totalsOf(report: Ga4Report, name: string, devices: AdminTrafficData['devices'] | null): TrafficTotals | null {
  const row = report.rows.find((candidate) => rangeOf(report, candidate) === name);
  if (!row) return null;
  const activeUsers = cleanCount(row.metrics[0]);
  return {
    activeUsers,
    newUsers: cleanCount(row.metrics[1]),
    sessions: cleanCount(row.metrics[2]),
    engagementRate: cleanRatio(row.metrics[3]),
    averageEngagementSeconds: activeUsers > 0 ? cleanNumber(row.metrics[4]) / activeUsers : 0,
    mobileShare: devices?.find((device) => device.category === 'mobile')?.share ?? 0,
  };
}

/** `AAAAMMJJ` (format GA4) → `AAAA-MM-JJ`. */
function isoDate(value: string): string | null {
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : null;
}

function seriesOf(report: Ga4Report, query: TrafficQuery): AdminTrafficData['series'] {
  const byRange = new Map<string, Map<string, Ga4Row>>();
  for (const row of report.rows) {
    const date = isoDate(row.dimensions[0] ?? '');
    if (!date) continue;
    const name = rangeOf(report, row);
    if (!byRange.has(name)) byRange.set(name, new Map());
    byRange.get(name)?.set(date, row);
  }
  const currentDays = daysBetween(query.current.from, query.current.to);
  const previousDays = daysBetween(query.previous.from, query.previous.to);
  // Un jour absent chez GA4 = aucune visite (0), pas une donnée manquante.
  const points = (days: string[], name: string, metric: number) =>
    days.map((date) => ({ date, value: cleanCount(byRange.get(name)?.get(date)?.metrics[metric] ?? 0) }));
  return [
    { key: 'active_users', unit: 'count', points: points(currentDays, 'current', 0), comparison: points(previousDays, 'previous', 0) },
    { key: 'sessions', unit: 'count', points: points(currentDays, 'current', 1), comparison: points(previousDays, 'previous', 1) },
  ];
}

function devicesOf(report: Ga4Report): AdminTrafficData['devices'] {
  const sessions = new Map<Ga4DeviceCategory, number>();
  for (const row of report.rows) {
    const raw = (row.dimensions[0] ?? '').toLowerCase();
    const category: Ga4DeviceCategory = (GA4_DEVICE_CATEGORIES as readonly string[]).includes(raw) ? (raw as Ga4DeviceCategory) : 'other';
    sessions.set(category, (sessions.get(category) ?? 0) + cleanCount(row.metrics[0]));
  }
  const total = [...sessions.values()].reduce((sum, value) => sum + value, 0);
  return [...sessions.entries()]
    .map(([category, value]) => ({ category, sessions: value, share: share(value, total) }))
    .sort((a, b) => b.sessions - a.sessions);
}

function eventsOf(...reports: Ga4Report[]): AdminTrafficData['events'] {
  const events = new Map<string, { count: number; isKeyEvent: boolean }>();
  for (const report of reports) {
    for (const row of report.rows) {
      const name = row.dimensions[0] ?? '';
      if (!/^[a-z0-9_]{1,40}$/.test(name)) continue;
      const entry = events.get(name);
      const count = cleanCount(row.metrics[0]);
      const isKeyEvent = row.dimensions[1] === 'true';
      // Le même événement peut revenir dans les deux rapports : on garde la plus grande valeur (pas de double compte).
      events.set(name, { count: Math.max(entry?.count ?? 0, count), isKeyEvent: (entry?.isKeyEvent ?? false) || isKeyEvent });
    }
  }
  return [...events.entries()]
    .map(([name, value]) => ({ name, ...value }))
    .sort((a, b) => b.count - a.count)
    .slice(0, ADMIN_TOP_ROWS_MAX);
}

/** Construit `AdminTrafficData` à partir des 9 rapports (ordre de `trafficRequests`), validé par le contrat. */
export function buildTraffic(reports: readonly unknown[], query: TrafficQuery): AdminTrafficData {
  const [totals, series, pages, sources, channels, devices, countries, events, ourEvents] = reports.map(readReport);
  const empty: Ga4Report = { dimensionNames: [], rows: [] };
  const deviceRows = devicesOf(devices ?? empty);
  const channelTotal = (channels ?? empty).rows.reduce((sum, row) => sum + cleanCount(row.metrics[0]), 0);
  const zero: TrafficTotals = { activeUsers: 0, newUsers: 0, sessions: 0, engagementRate: 0, averageEngagementSeconds: 0, mobileShare: 0 };
  const data: AdminTrafficData = {
    totals: totalsOf(totals ?? empty, 'current', deviceRows) ?? zero,
    previousTotals: totalsOf(totals ?? empty, 'previous', null),
    series: seriesOf(series ?? empty, query),
    topPages: (pages ?? empty).rows.slice(0, ADMIN_TOP_ROWS_MAX).map((row) => ({
      path: cleanText(row.dimensions[0], 512) || '/',
      title: cleanText(row.dimensions[1], 300) || null,
      views: cleanCount(row.metrics[0]),
      users: cleanCount(row.metrics[1]),
    })),
    sources: (sources ?? empty).rows.slice(0, ADMIN_TOP_ROWS_MAX).map((row) => ({
      source: cleanText(row.dimensions[0], 200) || '(not set)',
      medium: cleanText(row.dimensions[1], 200) || '(not set)',
      sessions: cleanCount(row.metrics[0]),
      keyEvents: cleanCount(row.metrics[1]),
    })),
    channels: (channels ?? empty).rows.slice(0, ADMIN_TOP_ROWS_MAX).map((row) => {
      const sessions = cleanCount(row.metrics[0]);
      return { channel: cleanText(row.dimensions[0], 100) || '(not set)', sessions, share: share(sessions, channelTotal) };
    }),
    devices: deviceRows,
    countries: (countries ?? empty).rows.slice(0, ADMIN_TOP_ROWS_MAX).map((row) => {
      const id = row.dimensions[0] ?? '';
      return {
        countryId: /^[A-Z]{2}$/.test(id) ? id : '(not set)',
        country: cleanText(row.dimensions[1], 100) || '(not set)',
        sessions: cleanCount(row.metrics[0]),
      };
    }),
    events: eventsOf(events ?? empty, ourEvents ?? empty),
  };
  return adminTrafficDataSchema.parse(data);
}

/** Client GA4 : deux `batchRunReports` sur la propriété configurée, avec un jeton OAuth en lecture seule. */
export class Ga4Client {
  constructor(
    private readonly propertyId: string,
    private readonly token: () => Promise<string>,
    private readonly fetchFn: FetchFn,
  ) {}

  async traffic(query: TrafficQuery): Promise<AdminTrafficData> {
    const url = `${GA4_DATA_API}/properties/${encodeURIComponent(this.propertyId)}:batchRunReports`;
    const reports: unknown[] = [];
    for (const requests of trafficRequests(query)) {
      const token = await this.token();
      const body = (await postJson(this.fetchFn, url, { requests }, { Authorization: `Bearer ${token}` })) as Json | null;
      const batch = Array.isArray(body?.['reports']) ? body['reports'] : [];
      for (let i = 0; i < requests.length; i += 1) reports.push(batch[i] ?? null);
    }
    return buildTraffic(reports, query);
  }
}
