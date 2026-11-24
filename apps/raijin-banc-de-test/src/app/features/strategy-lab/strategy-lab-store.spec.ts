import { TestBed } from '@angular/core/testing';
import { BENCH_ROUTES } from '@raijin/bench-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAB_MSG } from './backtest';
import {
  backfillRows,
  candidateSummary,
  fakeBench,
  resultRow,
  rpcByName,
  runRow,
  variantRows,
  type QueryCall,
  type QueryResult,
} from './lab-test-data';
import { BACKFILL_POLL_MS, LAB_POLL_MS, StrategyLabStore } from './strategy-lab-store';

function setup(handler: (call: QueryCall) => Promise<QueryResult>, rpc?: (name: string) => Promise<QueryResult>) {
  const fake = fakeBench(handler, rpc);
  TestBed.configureTestingModule({ providers: [StrategyLabStore, ...fake.providers] });
  return { store: TestBed.inject(StrategyLabStore), ...fake };
}

/** latest = the latest run (any status), done = the latest done run, results = retained rows. */
function tables(state: { latest: unknown; done?: unknown; results?: unknown; error?: unknown }) {
  return async (call: QueryCall): Promise<QueryResult> => {
    if (state.error) return { data: null, error: state.error };
    if (call.table === 'backtest_runs') {
      const row = call.filters['status'] === 'done' ? (state.done ?? null) : state.latest;
      return { data: row === null ? [] : [row], error: null };
    }
    return { data: state.results ?? [], error: null };
  };
}

describe('StrategyLabStore', () => {
  afterEach(() => vi.useRealTimers());

  it('reads the latest run and the retained results of the latest done run, exposing readonly signals', async () => {
    const { store, calls } = setup(tables({ latest: runRow(), results: [...variantRows(), ...variantRows({ narrative: 'gta', robust: false })] }));
    expect(store.state()).toBe('idle');
    await store.load();
    expect(store.state()).toBe('ready');
    const main = calls.filter((c) => !('preset' in c.filters));
    expect(main.map((c) => c.table)).toEqual(['backtest_runs', 'backtest_results']);
    expect(main[1]!.filters).toEqual({ run_id: '7', retained: true });
    expect(store.lastDone()?.id).toBe('7');
    expect(store.variants()).toHaveLength(1);
    expect(store.robustCount()).toBe(1);
    expect(store.canRequest()).toBe(true);
    store.selectNarrative('gta');
    expect(store.robustCount()).toBe(0);
    store.selectNarrative('ai' as never);
    expect(store.narrative()).toBe('gta');
    expect('set' in store.rows).toBe(false);
    expect('set' in store.state).toBe(false);
  });

  it('shows the latest done run while another one runs, disables the request and polls until it finishes', async () => {
    vi.useFakeTimers();
    const state: { latest: unknown; done: unknown; results: unknown } = {
      latest: runRow({ id: 8, status: 'running', progress: 0.4, finished_at: null }),
      done: runRow(),
      results: variantRows(),
    };
    const { store, calls } = setup(tables(state));
    await store.load();
    expect(store.running()).toBe(true);
    expect(store.canRequest()).toBe(false);
    expect(store.latest()?.id).toBe('8');
    expect(store.lastDone()?.id).toBe('7');
    expect(calls.filter((c) => c.table === 'backtest_runs').map((c) => c.filters)).toEqual([{}, { status: 'done' }]);

    state.latest = runRow({ id: 8 });
    state.results = [...variantRows(), ...variantRows({ sl_pct: 40 })];
    await vi.advanceTimersByTimeAsync(LAB_POLL_MS);
    expect(store.running()).toBe(false);
    expect(store.lastDone()?.id).toBe('8');
    expect(store.variants()).toHaveLength(2);
    const count = calls.length;
    await vi.advanceTimersByTimeAsync(LAB_POLL_MS * 3);
    expect(calls.length).toBe(count);
  });

  it('stops polling when destroyed', async () => {
    vi.useFakeTimers();
    const { store, calls } = setup(tables({ latest: runRow({ status: 'queued' }), done: null }));
    await store.load();
    expect(store.lastDone()).toBeNull();
    expect(store.rows()).toEqual([]);
    const count = calls.length;
    TestBed.resetTestingModule();
    await vi.advanceTimersByTimeAsync(LAB_POLL_MS * 2);
    expect(calls.length).toBe(count);
  });

  it('degrades to « unavailable » when the routes are not deployed, and to an error otherwise', async () => {
    const missing = setup(tables({ latest: null, error: { status: 404, code: 'NOT_FOUND' } }));
    await missing.store.load();
    expect(missing.store.state()).toBe('unavailable');
    TestBed.resetTestingModule();
    const broken = setup(tables({ latest: null, error: { status: 500 } }));
    await broken.store.load();
    expect(broken.store.state()).toBe('error');
    expect(broken.store.canRequest()).toBe(false);
  });

  it('is ready with no run at all', async () => {
    const { store } = setup(tables({ latest: null, done: null }));
    await store.load();
    expect(store.state()).toBe('ready');
    expect([store.latest(), store.lastDone(), store.variants()]).toEqual([null, null, []]);
  });

  it('requests a run through POST /api/lab/runs, then reloads (running → button disabled)', async () => {
    const state: { latest: unknown; done: unknown } = { latest: runRow(), done: runRow() };
    const { store, rpc } = setup(
      tables(state),
      rpcByName({
        [BENCH_ROUTES.labRuns]: async () => {
          state.latest = runRow({ id: 9, status: 'queued', trigger: 'manual' });
          return { data: 9, error: null };
        },
      }),
    );
    await store.load();
    await store.requestRun();
    expect(rpc).toHaveBeenCalledWith(BENCH_ROUTES.labRuns);
    expect(store.feedback()).toEqual({ kind: 'ok', text: LAB_MSG.requested });
    expect(store.running()).toBe(true);
    expect(store.canRequest()).toBe(false);
    await store.requestRun();
    expect(rpc.mock.calls.filter(([name]) => name === BENCH_ROUTES.labRuns)).toHaveLength(1);
    TestBed.resetTestingModule();
  });

  it('surfaces the French refusal of the API (409)', async () => {
    const { store } = setup(
      tables({ latest: runRow(), results: [resultRow()] }),
      rpcByName({
        [BENCH_ROUTES.labRuns]: async () => ({
          data: null,
          error: { status: 409, code: 'BACKTEST_ALREADY_QUEUED', message: 'Le dernier backtest a démarré il y a moins de 10 minutes.' },
        }),
      }),
    );
    await store.load();
    await store.requestRun();
    expect(store.feedback()).toEqual({ kind: 'error', text: 'Le dernier backtest a démarré il y a moins de 10 minutes.' });
    expect(store.requesting()).toBe(false);
  });

  it('exposes the nightly summary of the last finished run (none for a pre-lab-v2 run)', async () => {
    const { store } = setup(tables({ latest: runRow({ summary: candidateSummary() }), results: variantRows() }));
    await store.load();
    expect(store.summary()?.verdict).toBe('candidate');
    expect(store.summary()?.title).toContain('Jeune calme (à la détection)');
    TestBed.resetTestingModule();
    const legacy = setup(tables({ latest: runRow() }));
    await legacy.store.load();
    expect(legacy.store.summary()).toBeNull();
  });

  it('reads the catch-up gauge and polls it every 60 s while rows are due, then stops', async () => {
    vi.useFakeTimers();
    let rows = backfillRows();
    const { store, rpc } = setup(tables({ latest: runRow(), results: variantRows() }), rpcByName({ [BENCH_ROUTES.labBackfill]: async () => ({ data: rows, error: null }) }));
    await store.load();
    expect(store.backfillState()).toBe('ready');
    expect(store.backfill()?.dueNow).toBe(392 + 1392);
    expect(store.backfill()?.rowsPerHour).toBe(30);
    expect('set' in store.backfill).toBe(false);
    const gaugeCalls = () => rpc.mock.calls.filter(([name]) => name === BENCH_ROUTES.labBackfill).length;
    expect(gaugeCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(BACKFILL_POLL_MS);
    expect(gaugeCalls()).toBe(2);
    rows = rows.map((r) => ({ ...r, done: r['total'], due_now: 0 }));
    await vi.advanceTimersByTimeAsync(BACKFILL_POLL_MS);
    expect(gaugeCalls()).toBe(3);
    expect(store.backfill()?.dueNow).toBe(0);
    await vi.advanceTimersByTimeAsync(BACKFILL_POLL_MS * 3);
    expect(gaugeCalls()).toBe(3);
  });

  it('stops the gauge poll when destroyed', async () => {
    vi.useFakeTimers();
    const { store, rpc } = setup(tables({ latest: runRow() }), rpcByName({ [BENCH_ROUTES.labBackfill]: async () => ({ data: backfillRows(), error: null }) }));
    await store.load();
    const count = rpc.mock.calls.length;
    TestBed.resetTestingModule();
    await vi.advanceTimersByTimeAsync(BACKFILL_POLL_MS * 2);
    expect(rpc.mock.calls.length).toBe(count);
  });

  it('marks the gauge unavailable when the route is missing (no poll), keeps the last gauge on a background error', async () => {
    vi.useFakeTimers();
    const missing = setup(tables({ latest: runRow() }));
    await missing.store.load();
    expect(missing.store.state()).toBe('ready');
    expect(missing.store.backfillState()).toBe('unavailable');
    await vi.advanceTimersByTimeAsync(BACKFILL_POLL_MS * 2);
    expect(missing.rpc).toHaveBeenCalledTimes(1);
    TestBed.resetTestingModule();

    let fail = false;
    const flaky = setup(
      tables({ latest: runRow() }),
      rpcByName({ [BENCH_ROUTES.labBackfill]: async () => (fail ? { data: null, error: { status: 500 } } : { data: backfillRows(), error: null }) }),
    );
    await flaky.store.load();
    fail = true;
    await vi.advanceTimersByTimeAsync(BACKFILL_POLL_MS);
    expect(flaky.store.backfillState()).toBe('ready');
    expect(flaky.store.backfill()?.categories).toHaveLength(3);
    TestBed.resetTestingModule();

    const broken = setup(tables({ latest: runRow() }), rpcByName({ [BENCH_ROUTES.labBackfill]: async () => ({ data: null, error: { status: 500 } }) }));
    await broken.store.load();
    expect(broken.store.backfillState()).toBe('error');
    expect(broken.store.state()).toBe('ready');
  });

  it('reads only the retained rows of the last done run (no exploratory query), and ignores removed presets', async () => {
    const { store, calls } = setup(tables({ latest: runRow(), results: [...variantRows(), ...variantRows({ preset: 'momentum_explo' }), ...variantRows({ preset: 'momentum' })] }));
    await store.load();
    expect(calls.filter((c) => c.table === 'backtest_results').map((c) => c.filters)).toEqual([{ run_id: '7', retained: true }]);
    expect(store.variants().map((v) => v.key.preset)).toEqual(['young_calm']);
    const count = calls.length;
    await store.refresh();
    expect(calls.length - count).toBe(1); // same done run: only the run is re-read
  });

  it('ignores a nightly summary naming an exploratory or removed candidate', async () => {
    const candidate = { ...(candidateSummary()['candidate'] as object), preset: 'momentum_explo' };
    const { store } = setup(tables({ latest: runRow({ summary: candidateSummary({ candidate }) }), results: variantRows() }));
    await store.load();
    expect(store.summary()).toBeNull();
  });
});
