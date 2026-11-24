import { describe, expect, it } from 'vitest';
import type { PaperLeg, PaperPosition } from '../models/paper';
import {
  MAX_POINTS,
  RANGE_MS,
  areaPath,
  buildChartGeometry,
  chartSeries,
  chartSummary,
  chartTableRows,
  classifyLevel,
  computeYDomain,
  downsample,
  formatParisTime,
  formatPriceFr,
  formatPriceShort,
  linePath,
  linearScale,
  nearestIndex,
  paperMarkers,
  parseAlertMarkers,
  parseSnapshots,
  placeLabels,
  timeTicks,
  visibleMarkers,
  windowPoints,
  withLivePoint,
  type PricePoint,
} from './price-chart-data';

const H = 3_600_000;
const MIN = 60_000;
/** 2026-11-18 10:00 UTC = 11:00 in Paris (winter time). */
const T0 = Date.parse('2026-11-18T10:00:00Z');

/** One point every 2 min over `hours`, ending at T0 + hours. */
function series(hours: number, price: (i: number) => number = () => 0.0004): PricePoint[] {
  const n = Math.round((hours * 60) / 2) + 1;
  return Array.from({ length: n }, (_, i) => ({ t: T0 + i * 2 * MIN, price: price(i) }));
}

const leg = (over: Partial<PaperLeg> = {}): PaperLeg => ({
  id: 'l1',
  position_id: 'p1',
  size_pct: 100,
  tp_price: 0.0008,
  stop_price: 0.0003,
  status: 'open',
  exit_price: null,
  closed_at: null,
  ...over,
});

const position = (over: Partial<PaperPosition> = {}): PaperPosition => ({
  id: 'p1',
  book: 'main',
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  symbol: 'GTA6',
  strategy: 'all_x2',
  stake_sol: 0.1,
  source: 'manual',
  status: 'open',
  entry_target_price: 0.0004,
  fill_price: 0.000408,
  sl_price: 0.0003,
  sl_pct: 30,
  custom_tp_price: null,
  expires_at: null,
  created_at: new Date(T0).toISOString(),
  filled_at: new Date(T0 + 10 * MIN).toISOString(),
  closed_at: null,
  pnl_sol: null,
  fees_sol: null,
  legs: [leg()],
  ...over,
});

describe('parseSnapshots', () => {
  it('keeps valid rows (numeric text accepted), sorted by time, one per timestamp', () => {
    const rows = [
      { price_usd: '0.0005', captured_at: '2026-11-18T10:04:00Z' },
      { price_usd: 0.0004, captured_at: '2026-11-18T10:00:00Z' },
      { price_usd: 0.00041, captured_at: '2026-11-18T10:00:00Z' },
      { price_usd: 0, captured_at: '2026-11-18T10:06:00Z' },
      { price_usd: -1, captured_at: '2026-11-18T10:08:00Z' },
      { price_usd: 'abc', captured_at: '2026-11-18T10:10:00Z' },
      { price_usd: 0.0006, captured_at: 'not a date' },
      { price_usd: 0.0006 },
      null,
      'junk',
    ];
    expect(parseSnapshots(rows)).toEqual([
      { t: T0, price: 0.0004 },
      { t: T0 + 4 * MIN, price: 0.0005 },
    ]);
  });

  it('returns [] for anything that is not an array', () => {
    expect(parseSnapshots(null)).toEqual([]);
    expect(parseSnapshots({ price_usd: 1 })).toEqual([]);
  });
});

describe('markers', () => {
  it('parses alert entries and ignores rows without an entry price', () => {
    const rows = [
      { sent_at: '2026-11-18T10:30:00Z', entry_price: '0.00042' },
      { sent_at: '2026-11-18T10:40:00Z', entry_price: null },
      { sent_at: 'bad', entry_price: 0.0004 },
      { sent_at: '2026-11-18T10:50:00Z' },
    ];
    expect(parseAlertMarkers(rows)).toEqual([{ kind: 'alert', t: T0 + 30 * MIN, price: 0.00042 }]);
    expect(parseAlertMarkers(undefined)).toEqual([]);
  });

  it('builds paper fills and closed leg exits, skipping pending positions, open legs and duplicates', () => {
    const exitAt = new Date(T0 + 60 * MIN).toISOString();
    const markers = paperMarkers([
      position({
        legs: [
          leg({ id: 'a', status: 'tp_hit', exit_price: 0.0008, closed_at: exitAt }),
          leg({ id: 'b', status: 'tp_hit', exit_price: 0.0008, closed_at: exitAt }),
          leg({ id: 'c', status: 'open' }),
        ],
      }),
      position({ id: 'p2', status: 'pending', fill_price: null, filled_at: null, legs: [leg()] }),
    ]);
    expect(markers).toEqual([
      { kind: 'fill', t: T0 + 10 * MIN, price: 0.000408 },
      { kind: 'exit', t: T0 + 60 * MIN, price: 0.0008 },
    ]);
  });

  it('keeps only markers within the drawn time span', () => {
    const m = [
      { kind: 'alert' as const, t: T0 - 1, price: 1 },
      { kind: 'fill' as const, t: T0, price: 1 },
      { kind: 'exit' as const, t: T0 + H, price: 1 },
      { kind: 'exit' as const, t: T0 + H + 1, price: 1 },
    ];
    expect(visibleMarkers(m, T0, T0 + H).map((x) => x.kind)).toEqual(['fill', 'exit']);
  });
});

describe('series helpers', () => {
  it('appends the live price only when newer than the last snapshot', () => {
    const pts = series(1);
    const last = pts[pts.length - 1];
    expect(withLivePoint(pts, 0.0005, new Date(last!.t + MIN).toISOString()).at(-1)).toEqual({ t: last!.t + MIN, price: 0.0005 });
    expect(withLivePoint(pts, 0.0005, new Date(last!.t).toISOString())).toHaveLength(pts.length);
    expect(withLivePoint(pts, 0, new Date(last!.t + MIN).toISOString())).toHaveLength(pts.length);
    expect(withLivePoint(pts, 0.0005, null)).toHaveLength(pts.length);
    expect(withLivePoint([], 0.0005, new Date(T0).toISOString())).toEqual([]);
  });

  it('windows the last 6 h / 24 h relative to the most recent point', () => {
    const pts = series(24);
    const six = windowPoints(pts, '6h');
    expect(six[0]!.t).toBe(pts[pts.length - 1]!.t - RANGE_MS['6h']);
    expect(six.at(-1)).toEqual(pts.at(-1));
    expect(windowPoints(pts, '24h')).toHaveLength(pts.length);
    expect(windowPoints([], '6h')).toEqual([]);
  });

  it('downsamples to at most MAX_POINTS, keeping the first and last points and the peaks', () => {
    const pts = series(24, (i) => (i === 400 ? 0.002 : 0.0004 + (i % 7) * 1e-6));
    expect(pts.length).toBeGreaterThan(MAX_POINTS);
    const out = downsample(pts);
    expect(out).toHaveLength(MAX_POINTS);
    expect(out[0]).toEqual(pts[0]);
    expect(out.at(-1)).toEqual(pts.at(-1));
    expect(out.some((p) => p.price === 0.002)).toBe(true);
    for (let i = 1; i < out.length; i++) expect(out[i]!.t).toBeGreaterThan(out[i - 1]!.t);
  });

  it('returns a copy when already small enough and handles tiny targets', () => {
    const pts = series(1);
    const out = downsample(pts, 1000);
    expect(out).toEqual(pts);
    expect(out).not.toBe(pts);
    expect(downsample(pts, 2)).toEqual([pts[0], pts.at(-1)]);
    expect(downsample(pts, 1)).toEqual([pts.at(-1)]);
  });

  it('chartSeries = window then downsample, ending on the current price', () => {
    const pts = series(24);
    const six = chartSeries(pts, '6h');
    expect(six.length).toBeLessThanOrEqual(MAX_POINTS);
    expect(six.at(-1)).toEqual(pts.at(-1));
    expect(six[0]!.t).toBeGreaterThanOrEqual(pts[pts.length - 1]!.t - RANGE_MS['6h']);
  });
});

describe('y domain', () => {
  it('classifies values against [min / 3, max × 3]', () => {
    expect(classifyLevel(0.0013, 0.0001, 0.0004)).toBe('above');
    expect(classifyLevel(0.0012, 0.0001, 0.0004)).toBe('in');
    expect(classifyLevel(0.00003, 0.0001, 0.0004)).toBe('below');
  });

  it('pads a flat series by ±5 %, never goes below 0, and returns null without prices', () => {
    expect(computeYDomain([0.001, 0.001])).toEqual({ min: 0.00095, max: 0.00105 });
    expect(computeYDomain([0.0001, 0.001])?.min).toBeGreaterThanOrEqual(0);
    expect(computeYDomain([])).toBeNull();
    expect(computeYDomain([0, Number.NaN])).toBeNull();
  });

  it('includes extra values (markers) only when in range', () => {
    expect(computeYDomain([0.0004, 0.0005], [0.0007])?.max).toBeGreaterThan(0.0007);
    expect(computeYDomain([0.0004, 0.0005], [0.01])?.max).toBeLessThan(0.001);
  });

  it('maps linearly and handles a degenerate domain', () => {
    const s = linearScale(0, 10, 100, 0);
    expect(s(0)).toBe(100);
    expect(s(5)).toBe(50);
    expect(s(10)).toBe(0);
    expect(linearScale(3, 3, 0, 100)(42)).toBe(50);
  });
});

describe('placeLabels', () => {
  it('nudges overlapping labels apart, keeping their order and the input order', () => {
    const out = placeLabels(
      [
        { id: 'tp1', y: 50 },
        { id: 'zone', y: 52 },
        { id: 'current', y: 51 },
      ],
      12,
      0,
      200,
    );
    expect(out.map((l) => l.id)).toEqual(['tp1', 'zone', 'current']);
    const sorted = [...out].sort((a, b) => a.y - b.y);
    expect(sorted.map((l) => l.id)).toEqual(['tp1', 'current', 'zone']);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.y - sorted[i - 1]!.y).toBeGreaterThanOrEqual(12);
  });

  it('pushes labels crowded at the bottom back up inside the bounds', () => {
    const out = placeLabels(
      [
        { id: 'a', y: 198 },
        { id: 'b', y: 199 },
        { id: 'c', y: 200 },
      ],
      12,
      0,
      190,
    );
    expect(Math.max(...out.map((l) => l.y))).toBe(190);
    expect(out.map((l) => l.y)).toEqual([166, 178, 190]);
  });

  it('leaves well-separated labels untouched and clamps to the top', () => {
    expect(placeLabels([{ id: 'a', y: 20 }, { id: 'b', y: 80 }], 12, 10, 190)).toEqual([
      { id: 'a', y: 20 },
      { id: 'b', y: 80 },
    ]);
    expect(placeLabels([{ id: 'a', y: -5 }], 12, 10, 190)).toEqual([{ id: 'a', y: 10 }]);
    expect(placeLabels([], 12, 0, 100)).toEqual([]);
  });
});

describe('paths', () => {
  it('builds the line and the closed area', () => {
    const pts = [
      { x: 0, y: 10 },
      { x: 5.04, y: 2.26 },
    ];
    expect(linePath(pts)).toBe('M0 10 L5 2.3');
    expect(areaPath(pts, 20)).toBe('M0 10 L5 2.3 L5 20 L0 20 Z');
    expect(areaPath([], 20)).toBe('');
  });

  it('finds the nearest x', () => {
    const xs = [0, 10, 20, 30];
    expect(nearestIndex(xs, -5)).toBe(0);
    expect(nearestIndex(xs, 14)).toBe(1);
    expect(nearestIndex(xs, 16)).toBe(2);
    expect(nearestIndex(xs, 99)).toBe(3);
    expect(nearestIndex([], 3)).toBe(-1);
  });
});

describe('time and number formatting', () => {
  it('formats times in Paris time (winter and summer)', () => {
    expect(formatParisTime(Date.parse('2026-11-18T11:00:00Z'))).toBe('12:00');
    expect(formatParisTime(Date.parse('2026-07-01T10:00:00Z'))).toBe('12:00');
    expect(formatParisTime(Date.parse('2026-11-18T23:05:00Z'))).toBe('00:05');
  });

  it('gives 3 round ticks over 6 h and 4 over 24 h, in Paris time', () => {
    const six = timeTicks(T0, T0 + 6 * H);
    expect(six.map((t) => t.label)).toEqual(['12:00', '14:00', '16:00']);
    const day = timeTicks(T0 + 30 * MIN, T0 + 24 * H);
    expect(day).toHaveLength(4);
    expect(day.map((t) => t.label)).toEqual(['12:00', '18:00', '00:00', '06:00']);
    expect(timeTicks(T0, T0 + 90 * MIN).length).toBeGreaterThanOrEqual(3);
    expect(timeTicks(T0, T0)).toEqual([]);
    expect(timeTicks(Number.NaN, T0)).toEqual([]);
  });

  it('formats prices the French way', () => {
    expect(formatPriceFr(0.00041)).toBe('0,00041');
    expect(formatPriceFr(0.000412345)).toBe('0,0004123');
    expect(formatPriceFr(1.5)).toBe('1,5');
    expect(formatPriceFr(0)).toBe('–');
    expect(formatPriceFr(null)).toBe('–');
  });

  it('formats compact labels with subscript zeros below 0,0001', () => {
    expect(formatPriceShort(0.000412)).toBe('0,000412');
    expect(formatPriceShort(0.00001234)).toBe('0,0₄123');
    expect(formatPriceShort(0.0000001)).toBe('0,0₆1');
    expect(formatPriceShort(0.00009999)).toBe('0,0₃1');
    expect(formatPriceShort(2.345)).toBe('2,35');
    expect(formatPriceShort(-1)).toBe('–');
  });
});

describe('summary and hidden table', () => {
  it('summarises the range and the current price (no entry zone, no levels)', () => {
    const pts = [0.00041, 0.00048, 0.00044, 0.00042].map((price, i) => ({ t: T0 + i * MIN, price }));
    expect(chartSummary('GTA6', '6h', pts)).toBe('Prix 6 h de GTA6 : de 0,00041 à 0,00048 $, actuellement 0,00042 $.');
  });

  it('says when there is not enough history', () => {
    expect(chartSummary('X', '6h', series(0.05))).toBe('Prix 6 h de X : pas assez d’historique.');
  });

  it('lists min / max / last and markers for the hidden table', () => {
    const pts = [0.00041, 0.00048, 0.00044, 0.00042].map((price, i) => ({ t: T0 + i * MIN, price }));
    const rows = chartTableRows(pts, [{ kind: 'alert', t: T0 + 2 * MIN, price: 0.00044 }]);
    expect(rows.map((r) => r.label)).toEqual(['Plus bas', 'Plus haut', 'Dernier prix', 'Alerte reçue à 11:02']);
    expect(rows[0]!.value).toBe('0,00041 $');
    expect(chartTableRows([])).toEqual([]);
  });
});

describe('buildChartGeometry', () => {
  const pts = series(6, (i) => 0.0004 + Math.sin(i / 10) * 0.00004);

  it('returns null without points', () => {
    expect(buildChartGeometry([], [], 340)).toBeNull();
  });

  it('draws the line, the area and the current price label inside the plot (no zone band, no level lines)', () => {
    const g = buildChartGeometry(pts, [], 340);
    expect(g).not.toBeNull();
    if (!g) return;
    expect('band' in g).toBe(false);
    expect('lines' in g).toBe(false);
    for (const l of g.labels) {
      expect(l.y).toBeGreaterThanOrEqual(g.plotTop);
      expect(l.y).toBeLessThanOrEqual(g.plotBottom);
    }
    expect(g.plotRight).toBeLessThan(340);
    expect(g.xs).toHaveLength(pts.length);
    expect(g.dot.x).toBeCloseTo(g.xs[g.xs.length - 1]!, 1);
    expect(g.line.startsWith('M')).toBe(true);
    expect(g.area.endsWith('Z')).toBe(true);
  });

  it('places markers within the time span only, and 3 time ticks inside the plot', () => {
    const last = pts[pts.length - 1]!.t;
    const g = buildChartGeometry(
      pts,
      [
        { kind: 'alert', t: T0 + H, price: 0.00042 },
        { kind: 'fill', t: T0 - H, price: 0.00042 },
        { kind: 'exit', t: last, price: 0.00044 },
      ],
      340,
    );
    expect(g?.markers.map((m) => m.kind)).toEqual(['alert', 'exit']);
    for (const tk of g?.ticks ?? []) {
      expect(tk.x).toBeGreaterThan(0);
      expect(tk.x).toBeLessThan(g?.plotRight ?? 0);
    }
    expect(g?.ticks.map((t) => t.label)).toEqual(['12:00', '14:00', '16:00']);
  });

  it('labels the current price', () => {
    const g = buildChartGeometry(pts, [], 340);
    expect(g?.labels).toEqual([expect.objectContaining({ id: 'current', tone: 'current', text: formatPriceShort(pts.at(-1)?.price) })]);
  });
});
