import { TestBed } from '@angular/core/testing';
import { BENCH_ROUTES, type BenchRoute } from '@raijin/bench-contracts';
import { describe, expect, it, vi } from 'vitest';
import { provideFakeBench } from '../../core/api/bench-api.testing';
import { BOOKS_LOAD_ERROR, LOAD_ERROR, PerformanceStore } from './performance-store';
import { bookRow, breakdownRow, performanceApi, presetRow, type PerfResult as Result } from './performance-test-data';

function setup(
  breakdown: () => Promise<Result>,
  presets: () => Promise<Result> = async () => ({ data: [], error: null }),
  books: () => Promise<Result> = async () => ({ data: [], error: null }),
) {
  const rpc = vi.fn((name: BenchRoute) => (name === BENCH_ROUTES.performancePresets ? presets() : name === BENCH_ROUTES.performanceBooks ? books() : breakdown()));
  const api = performanceApi(rpc);
  TestBed.configureTestingModule({ providers: [PerformanceStore, ...provideFakeBench(api)] });
  return { store: TestBed.inject(PerformanceStore), rpc, api };
}

describe('PerformanceStore', () => {
  it('reads GET /api/performance/breakdown, keeps the main scanner rows only, never reads the archived model', async () => {
    const { store, rpc, api } = setup(async () => ({ data: [breakdownRow(), breakdownRow({ source: 'radar', n: 3, n_final: 0, x2: 0, x3: 0, x2_before_sl30: 0, sl30_before_x2: 0, dd50_first: 0 }), { junk: true }], error: null }));
    expect(store.loaded()).toBe(false);
    await store.load();
    expect(rpc).toHaveBeenCalledWith(BENCH_ROUTES.performanceBreakdown);
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(api.calls).toHaveLength(3); // model_weights archived: nothing else is read
    expect(store.loaded()).toBe(true);
    expect(store.rows()).toHaveLength(1);
    expect(store.view().overall?.n).toBe(40);
    expect('set' in store.rows).toBe(false);
  });

  it('degrades to « unavailable » (no error) while the route is not deployed', async () => {
    const { store } = setup(async () => ({ data: null, error: { status: 404 } }));
    await store.load();
    expect(store.error()).toBeNull();
    expect(store.unavailable()).toBe(true);
    expect(store.rows()).toEqual([]);
  });

  it('reports an error, then recovers on retry', async () => {
    let fail = true;
    const { store } = setup(async () => (fail ? { data: null, error: { message: 'boom' } } : { data: [breakdownRow()], error: null }));
    await store.load();
    expect(store.error()).toBe(LOAD_ERROR);
    fail = false;
    await store.load();
    expect(store.error()).toBeNull();
    expect(store.rows()).toHaveLength(1);
  });

  it('ignores a second load while one is running', async () => {
    let release: (r: Result) => void = () => undefined;
    const { store, rpc } = setup(() => new Promise<Result>((resolve) => (release = resolve)));
    const first = store.load();
    void store.load();
    expect(store.loading()).toBe(true);
    release({ data: [], error: null });
    await first;
    expect(rpc.mock.calls.filter(([name]) => name === BENCH_ROUTES.performanceBreakdown)).toHaveLength(1);
    expect(store.loading()).toBe(false);
  });

  describe('« Calme vs Frénésie » (performance_by_preset)', () => {
    const ok = async (): Promise<Result> => ({ data: [breakdownRow()], error: null });

    it('reads GET /api/performance/presets with no argument and keeps the young_calm / young_frenzy rows only', async () => {
      const { store, rpc } = setup(ok, async () => ({
        data: [presetRow(), presetRow({ preset: 'momentum' }), presetRow({ preset: 'young_strong', segment: 'age_lt_3h' }), { preset: 'x' }],
        error: null,
      }));
      await store.load();
      await Promise.resolve();
      expect(rpc).toHaveBeenCalledWith(BENCH_ROUTES.performancePresets);
      expect(rpc.mock.calls.find(([name]) => name === BENCH_ROUTES.performancePresets)).toHaveLength(1);
      expect(store.presetState()).toBe('ready');
      expect(store.presetRows().map((r) => r.preset)).toEqual(['young_calm']);
      expect('set' in store.presetRows).toBe(false);
    });

    it('builds « Calme vs Frénésie » from the same rows, with its own shared segment', async () => {
      const { store } = setup(ok, async () => ({
        data: [
          presetRow({ preset: 'young_calm' }),
          presetRow({ preset: 'young_frenzy', segment: 'gta', signals: 9, labelled: 8, x2_before_sl30: 1, sl30_before_x2: 6 }),
        ],
        error: null,
      }));
      await store.load();
      await Promise.resolve();
      expect(store.comparison().segment).toBe('all');
      expect(store.comparison().columns.map((c) => [c.preset, c.row !== null])).toEqual([
        ['young_calm', true],
        ['young_frenzy', false],
      ]);
      store.selectComparisonSegment('gta');
      expect(store.comparisonSegment()).toBe('gta');
      expect(store.comparison().columns.map((c) => c.n)).toEqual([0, 8]);
      store.selectComparisonSegment('age_lt_3h' as never);
      expect(store.comparisonSegment()).toBe('gta');
      expect('set' in store.comparisonSegment).toBe(false);
    });

    it('is « unavailable » while the route is not deployed, without affecting the breakdown', async () => {
      const { store } = setup(ok, async () => ({ data: null, error: { status: 404 } }));
      await store.load();
      expect(store.presetState()).toBe('unavailable');
      expect(store.error()).toBeNull();
      expect(store.rows()).toHaveLength(1);
    });

    it('reports its own error (breakdown untouched), then recovers with loadPresets()', async () => {
      let fail: 'error' | 'throw' | null = 'error';
      const { store } = setup(ok, async () => {
        if (fail === 'throw') throw new Error('network');
        return fail ? { data: null, error: { message: 'boom' } } : { data: [presetRow()], error: null };
      });
      await store.load();
      expect(store.presetState()).toBe('error');
      expect(store.error()).toBeNull();
      fail = 'throw';
      await store.loadPresets();
      expect(store.presetState()).toBe('error');
      fail = null;
      await store.loadPresets();
      expect(store.presetState()).toBe('ready');
      expect(store.presetRows()).toHaveLength(1);
    });
  });

  describe('test books (paper_book_comparison)', () => {
    const ok = async () => ({ data: [breakdownRow()], error: null });

    it('reads GET /api/performance/books with no argument on load and exposes the 3-book view (read-only signals)', async () => {
      const { store, rpc } = setup(ok, undefined, async () => ({ data: [bookRow(), bookRow({ book: 'calm_all_x2' }), bookRow({ book: 'calm_sl40', trades: 31, tp_hits: 15, sl_hits: 16 })], error: null }));
      expect(store.bookState()).toBe('idle');
      await store.load();
      await Promise.resolve();
      expect(rpc).toHaveBeenCalledWith(BENCH_ROUTES.performanceBooks);
      expect(rpc.mock.calls.find(([name]) => name === BENCH_ROUTES.performanceBooks)).toHaveLength(1);
      expect(store.bookState()).toBe('ready');
      expect(store.bookRows().map((r) => r.book)).toEqual(['calm_sl30', 'calm_sl40']);
      expect(store.bookComparison().columns.map((c) => c.row?.trades ?? null)).toEqual([12, 31, null]);
      expect('set' in store.bookRows).toBe(false);
      expect('set' in store.bookState).toBe(false);
    });

    it('degrades to « unavailable » while the route is not deployed, without touching the breakdown', async () => {
      const { store } = setup(ok, undefined, async () => ({ data: null, error: { status: 404 } }));
      await store.load();
      await Promise.resolve();
      expect(store.bookState()).toBe('unavailable');
      expect(store.error()).toBeNull();
      expect(store.rows()).toHaveLength(1);
    });

    it('reports an error on its own, then recovers through loadBooks()', async () => {
      let fail = true;
      const { store } = setup(ok, undefined, async () => (fail ? { data: null, error: { message: 'boom' } } : { data: [bookRow()], error: null }));
      await store.load();
      await Promise.resolve();
      expect(store.bookState()).toBe('error');
      expect(BOOKS_LOAD_ERROR).toContain('portefeuilles de test');
      expect(store.error()).toBeNull();
      fail = false;
      await store.loadBooks();
      expect(store.bookState()).toBe('ready');
      expect(store.bookRows()).toHaveLength(1);
    });

    it('ignores a second loadBooks() while one is running', async () => {
      let release: (r: Result) => void = () => undefined;
      const { store, rpc } = setup(ok, undefined, () => new Promise<Result>((resolve) => (release = resolve)));
      const first = store.loadBooks();
      void store.loadBooks();
      expect(store.bookState()).toBe('loading');
      release({ data: [], error: null });
      await first;
      expect(rpc.mock.calls.filter(([name]) => name === BENCH_ROUTES.performanceBooks)).toHaveLength(1);
    });

    it('treats a rejected call as an error', async () => {
      const { store } = setup(ok, undefined, () => Promise.reject(new Error('network')));
      await store.loadBooks();
      expect(store.bookState()).toBe('error');
    });
  });
});
