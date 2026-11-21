import { Injectable, computed, inject, resource, signal } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE } from '../../../core/supabase/supabase-client';
import { PAPER_POSITION_COLUMNS, parsePaperPositions } from '../../../shared/models/paper';
import { isSolanaAddress } from '../../../shared/utils/solana-address';
import {
  CHART_RANGES,
  DEFAULT_CHART_RANGE,
  HISTORY_LIMIT,
  RANGE_MS,
  chartSeries,
  paperMarkers,
  parseAlertMarkers,
  parseSnapshots,
  visibleMarkers,
  withLivePoint,
  type ChartMarker,
  type ChartRange,
  type PricePoint,
} from './price-chart-data';

/** Markers read at most per source (own alerts / own paper positions on one mint). */
export const MARKER_LIMIT = 50;

/** Last 24 h of snapshots for `mint` (authenticated read), oldest first. Throws on a query error. */
export async function fetchPriceHistory(
  supabase: SupabaseClient,
  mint: string,
  now: number,
  signal?: AbortSignal,
): Promise<PricePoint[]> {
  if (!isSolanaAddress(mint)) return [];
  const since = new Date(now - RANGE_MS['24h']).toISOString();
  let query = supabase
    .from('token_snapshots')
    .select('price_usd,captured_at')
    .eq('mint', mint)
    .gte('captured_at', since)
    .order('captured_at', { ascending: true })
    .limit(HISTORY_LIMIT);
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error) throw new Error('price history query failed');
  return parseSnapshots(data);
}

/**
 * The user's alert entries and paper fills / exits on `mint` (owner RLS). Best effort: a missing table or column,
 * an error or a malformed row only removes markers, it never fails the chart.
 */
export async function fetchChartMarkers(
  supabase: SupabaseClient,
  mint: string,
  now: number,
  signal?: AbortSignal,
): Promise<ChartMarker[]> {
  if (!isSolanaAddress(mint)) return [];
  const since = new Date(now - RANGE_MS['24h']).toISOString();
  const alerts = async (): Promise<ChartMarker[]> => {
    try {
      let query = supabase
        .from('alert_log')
        .select('sent_at,entry_price')
        .eq('mint', mint)
        .gte('sent_at', since)
        .order('sent_at', { ascending: true })
        .limit(MARKER_LIMIT);
      if (signal) query = query.abortSignal(signal);
      const { data, error } = await query;
      return error ? [] : parseAlertMarkers(data);
    } catch {
      return [];
    }
  };
  const paper = async (): Promise<ChartMarker[]> => {
    try {
      let query = supabase
        .from('paper_positions')
        .select(PAPER_POSITION_COLUMNS)
        .eq('mint', mint)
        .order('created_at', { ascending: false })
        .limit(MARKER_LIMIT);
      if (signal) query = query.abortSignal(signal);
      const { data, error } = await query;
      return error ? [] : paperMarkers(parsePaperPositions(data));
    } catch {
      return [];
    }
  };
  const [a, p] = await Promise.all([alerts(), paper()]);
  return [...a, ...p].sort((x, y) => x.t - y.t);
}

interface LivePrice {
  price: number | null;
  at: string | null;
}

/**
 * Price history + markers of one token, for the chart of the detail. Provided by PriceChart: the queries start
 * when the detail opens (setMint) and are aborted when it closes (the resources die with the component).
 * The range toggle only re-slices the 24 h already loaded.
 */
@Injectable()
export class PriceChartStore {
  private readonly supabase = inject(SUPABASE);

  private readonly _mint = signal<string | null>(null);
  private readonly _range = signal<ChartRange>(DEFAULT_CHART_RANGE);
  private readonly _live = signal<LivePrice>({ price: null, at: null }, { equal: (a, b) => a.price === b.price && a.at === b.at });

  readonly mint = this._mint.asReadonly();
  readonly range = this._range.asReadonly();

  private readonly history = resource({
    params: () => this._mint() ?? undefined,
    loader: ({ params, abortSignal }) => fetchPriceHistory(this.supabase, params, Date.now(), abortSignal),
  });

  private readonly markerSource = resource({
    params: () => this._mint() ?? undefined,
    loader: ({ params, abortSignal }) => fetchChartMarkers(this.supabase, params, Date.now(), abortSignal),
  });

  readonly loading = computed(() => this.history.isLoading());
  readonly failed = computed(() => this.history.status() === 'error');

  /** Series drawn for the selected range (≤ MAX_POINTS, last point = current price). */
  readonly points = computed<PricePoint[]>(() => {
    const raw = this.history.hasValue() ? this.history.value() : [];
    const live = this._live();
    return chartSeries(withLivePoint(raw, live.price, live.at), this._range());
  });

  /** Markers within the time span of the drawn series. */
  readonly markers = computed<ChartMarker[]>(() => {
    const pts = this.points();
    const all = this.markerSource.hasValue() ? this.markerSource.value() : [];
    if (pts.length === 0) return [];
    return visibleMarkers(all, pts[0].t, pts[pts.length - 1].t);
  });

  /** Starts (or switches) the queries; an invalid mint never queries. */
  setMint(mint: string): void {
    this._mint.set(isSolanaAddress(mint) ? mint : null);
  }

  setRange(range: ChartRange): void {
    if (CHART_RANGES.includes(range)) this._range.set(range);
  }

  /** Live price of the token (Realtime), appended when newer than the last snapshot. */
  setLive(price: number | null, at: string | null): void {
    this._live.set({ price, at });
  }
}
