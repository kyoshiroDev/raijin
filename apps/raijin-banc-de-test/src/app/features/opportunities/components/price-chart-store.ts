import { Injectable, computed, inject, resource, signal } from '@angular/core';
import { BENCH_ROUTES } from '@raijin/bench-contracts';
import { BenchApi, itemsOf } from '../../../core/api/bench-api';
import { parsePaperPositions, isSolanaAddress } from '@raijin/bench-web-logic';
import { CHART_RANGES, DEFAULT_CHART_RANGE, RANGE_MS, chartSeries, paperMarkers, parseAlertMarkers, parseSnapshots, visibleMarkers, withLivePoint, type ChartMarker, type ChartRange, type PricePoint } from '@raijin/bench-web-logic/opportunities';

/** Markers read at most per source (own alerts / own paper positions on one mint). */
export const MARKER_LIMIT = 50;

type ApiReader = Pick<BenchApi, 'get'>;

/** Last 24 h of snapshots for `mint` (`GET /api/tokens/:mint/snapshots?since=`), oldest first. Throws on an API error. */
export async function fetchPriceHistory(api: ApiReader, mint: string, now: number, signal?: AbortSignal): Promise<PricePoint[]> {
  if (!isSolanaAddress(mint)) return [];
  const since = new Date(now - RANGE_MS['24h']).toISOString();
  let body: unknown;
  try {
    body = await api.get(BENCH_ROUTES.tokenSnapshots, { params: { mint }, query: { since }, signal });
  } catch {
    throw new Error('price history query failed');
  }
  return parseSnapshots(itemsOf(body));
}

/**
 * The owner's alert entries and paper fills / exits on `mint` (`GET /api/alerts`, `GET /api/paper/positions`). Best
 * effort: a missing route, an error or a malformed row only removes markers, it never fails the chart.
 */
export async function fetchChartMarkers(api: ApiReader, mint: string, now: number, signal?: AbortSignal): Promise<ChartMarker[]> {
  if (!isSolanaAddress(mint)) return [];
  const since = new Date(now - RANGE_MS['24h']).toISOString();
  const alerts = async (): Promise<ChartMarker[]> => {
    try {
      const body = await api.get(BENCH_ROUTES.alerts, { query: { mint, since, limit: MARKER_LIMIT }, signal });
      return parseAlertMarkers(itemsOf(body));
    } catch {
      return [];
    }
  };
  const paper = async (): Promise<ChartMarker[]> => {
    try {
      const body = await api.get(BENCH_ROUTES.paperPositions, { query: { mint, limit: MARKER_LIMIT }, signal });
      return paperMarkers(parsePaperPositions(itemsOf(body)));
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
  private readonly api = inject(BenchApi);

  private readonly _mint = signal<string | null>(null);
  private readonly _range = signal<ChartRange>(DEFAULT_CHART_RANGE);
  private readonly _live = signal<LivePrice>({ price: null, at: null }, { equal: (a, b) => a.price === b.price && a.at === b.at });

  readonly mint = this._mint.asReadonly();
  readonly range = this._range.asReadonly();

  private readonly history = resource({
    params: () => this._mint() ?? undefined,
    loader: ({ params, abortSignal }) => fetchPriceHistory(this.api, params, Date.now(), abortSignal),
  });

  private readonly markerSource = resource({
    params: () => this._mint() ?? undefined,
    loader: ({ params, abortSignal }) => fetchChartMarkers(this.api, params, Date.now(), abortSignal),
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
    return visibleMarkers(all, pts[0]!.t, pts[pts.length - 1]!.t);
  });

  /** Starts (or switches) the queries; an invalid mint never queries. */
  setMint(mint: string): void {
    this._mint.set(isSolanaAddress(mint) ? mint : null);
  }

  setRange(range: ChartRange): void {
    if (CHART_RANGES.includes(range)) this._range.set(range);
  }

  /** Live price of the token (SSE), appended when newer than the last snapshot. */
  setLive(price: number | null, at: string | null): void {
    this._live.set({ price, at });
  }
}
