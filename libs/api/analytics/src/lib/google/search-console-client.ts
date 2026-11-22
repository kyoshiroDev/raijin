import {
  ADMIN_TOP_ROWS_MAX,
  SEO_OPPORTUNITY_POSITION,
  adminSeoDataSchema,
  type AdminSeoData,
  type SeoRow,
  type SeoWindow,
} from '@raijin/shared-contracts';
import { daysBetween, shiftDay, type SeoQuery } from '../reports/report-source';
import { cleanCount, cleanNumber, cleanRatio, cleanText } from '../reports/sanitize';
import { postJson, type FetchFn } from './google-http';

/** Hôte fixe de l'API Search Console (`searchAnalytics.query`, équivalent de `www.googleapis.com/webmasters/v3`). */
export const SEARCH_CONSOLE_API = 'https://searchconsole.googleapis.com/webmasters/v3';
/** Requêtes lues pour trouver les opportunités (positions 5 à 20) au-delà du top 25 par clics. */
export const SEO_QUERY_ROWS = 1_000;

export const SEO_WINDOW_DAYS: Readonly<Record<SeoWindow, number>> = { '28d': 28, '90d': 90 };
/** Décalage habituel de Search Console (repli quand aucune donnée n'est encore disponible). */
export const SEO_DEFAULT_LAG_DAYS = 3;

type Json = Record<string, unknown>;

interface ScRow {
  readonly keys: readonly string[];
  readonly clicks: number;
  readonly impressions: number;
  readonly ctr: number;
  readonly position: number | null;
}

/** Lecture défensive d'une réponse `searchAnalytics.query` (JSON non fiable). */
export function readRows(raw: unknown): ScRow[] {
  const rows = Array.isArray((raw as Json | null)?.['rows']) ? ((raw as Json)['rows'] as unknown[]).slice(0, 25_000) : [];
  return rows.map((row) => {
    const r = (row ?? {}) as Json;
    const impressions = cleanCount(r['impressions']);
    const position = cleanNumber(r['position']);
    return {
      keys: Array.isArray(r['keys']) ? r['keys'].map((key) => String(key ?? '')) : [],
      clicks: cleanCount(r['clicks']),
      impressions,
      ctr: cleanRatio(r['ctr']),
      position: impressions > 0 && position > 0 ? Math.max(1, position) : null,
    };
  });
}

function metricsOf(row: ScRow | undefined) {
  return row
    ? { clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position }
    : { clicks: 0, impressions: 0, ctr: 0, position: null };
}

function seoRow(row: ScRow, max = 2048): SeoRow {
  return { key: cleanText(row.keys[0], max) || '(not set)', ...metricsOf(row) };
}

export interface SeoWindowDates {
  readonly dataThrough: string;
  readonly startDate: string;
  readonly previousStart: string;
  readonly previousEnd: string;
  readonly lagDays: number;
}

/** Fenêtre alignée sur le dernier jour disponible chez Search Console (`dataThrough`). */
export function seoWindowDates(window: SeoWindow, today: string, lastAvailable: string | null): SeoWindowDates {
  const days = SEO_WINDOW_DAYS[window];
  const dataThrough = lastAvailable && lastAvailable <= today ? lastAvailable : shiftDay(today, -SEO_DEFAULT_LAG_DAYS);
  const startDate = shiftDay(dataThrough, -(days - 1));
  const previousEnd = shiftDay(startDate, -1);
  const lag = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dataThrough}T00:00:00Z`)) / 86_400_000);
  return { dataThrough, startDate, previousEnd, previousStart: shiftDay(previousEnd, -(days - 1)), lagDays: Math.min(14, Math.max(0, lag)) };
}

/** Assemble `AdminSeoData` (validé par le contrat). */
export function buildSeo(
  window: SeoWindow,
  dates: SeoWindowDates,
  byDate: readonly ScRow[],
  totals: readonly ScRow[],
  previous: readonly ScRow[],
  queries: readonly ScRow[],
  pages: readonly ScRow[],
): AdminSeoData {
  const perDay = new Map(byDate.map((row) => [row.keys[0] ?? '', row]));
  const opportunities = queries
    .filter((row) => row.position !== null && row.position >= SEO_OPPORTUNITY_POSITION.min && row.position <= SEO_OPPORTUNITY_POSITION.max)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, ADMIN_TOP_ROWS_MAX);
  const data: AdminSeoData = {
    window,
    startDate: dates.startDate,
    dataThrough: dates.dataThrough,
    lagDays: dates.lagDays,
    totals: metricsOf(totals[0]),
    previousTotals: previous[0] ? metricsOf(previous[0]) : null,
    series: daysBetween(dates.startDate, dates.dataThrough).map((date) => ({ date, ...metricsOf(perDay.get(date)) })),
    topQueries: queries.slice(0, ADMIN_TOP_ROWS_MAX).map((row) => seoRow(row)),
    topPages: pages.slice(0, ADMIN_TOP_ROWS_MAX).map((row) => seoRow(row)),
    opportunities: opportunities.map((row) => seoRow(row)),
  };
  return adminSeoDataSchema.parse(data);
}

/**
 * Client Search Console : 5 requêtes `searchAnalytics.query` (`dataState: final`) sur la propriété configurée.
 * La fenêtre se termine au dernier jour présent (décalage de 2 à 3 jours, affiché par l'écran).
 */
export class SearchConsoleClient {
  constructor(
    private readonly siteUrl: string,
    private readonly token: () => Promise<string>,
    private readonly fetchFn: FetchFn,
  ) {}

  private async query(body: Json): Promise<ScRow[]> {
    const url = `${SEARCH_CONSOLE_API}/sites/${encodeURIComponent(this.siteUrl)}/searchAnalytics/query`;
    const token = await this.token();
    return readRows(await postJson(this.fetchFn, url, { type: 'web', dataState: 'final', ...body }, { Authorization: `Bearer ${token}` }));
  }

  async seo(query: SeoQuery): Promise<AdminSeoData> {
    const days = SEO_WINDOW_DAYS[query.window];
    const byDate = await this.query({ startDate: shiftDay(query.today, -(days + 7)), endDate: query.today, dimensions: ['date'], rowLimit: 500 });
    const last = byDate.map((row) => row.keys[0] ?? '').filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort().at(-1) ?? null;
    const dates = seoWindowDates(query.window, query.today, last);
    const current = { startDate: dates.startDate, endDate: dates.dataThrough };
    const [totals, previous, queries, pages] = await Promise.all([
      this.query({ ...current, rowLimit: 1 }),
      this.query({ startDate: dates.previousStart, endDate: dates.previousEnd, rowLimit: 1 }),
      this.query({ ...current, dimensions: ['query'], rowLimit: SEO_QUERY_ROWS }),
      this.query({ ...current, dimensions: ['page'], rowLimit: ADMIN_TOP_ROWS_MAX }),
    ]);
    return buildSeo(query.window, dates, byDate, totals, previous, queries, pages);
  }
}
