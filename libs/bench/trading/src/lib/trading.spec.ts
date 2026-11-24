import type { BenchConfig, BenchEventBus, BenchJobHandler, BenchJobRegistry } from '@raijin/bench-core';
import { BenchDb, MemoryDbExecutor, type RpcHandler } from '@raijin/bench-engine';
import type { BenchSqlService } from '@raijin/bench-prisma';
import type { BenchSolana } from '@raijin/bench-solana';
import { BenchTradingJobs } from './trading-jobs';
import { BenchLabController, BenchPaperController, BenchPerformanceController, toPaperPosition } from './trading.controllers';

const MINT = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump';
const POS = '00000000-0000-4000-8000-000000000001';
const SOLANA = { service: { config: { publicRpcUrl: 'https://api.mainnet-beta.solana.com', dexscreenerBaseUrl: 'https://api.dexscreener.com', geckoterminalBaseUrl: 'https://api.geckoterminal.com/api/v2', jupiterBaseUrl: 'https://lite-api.jup.ag', rugcheckBaseUrl: 'https://api.rugcheck.xyz' } }, backoff: {} } as unknown as BenchSolana;

const sqlError = (code: string, message = 'refus') => () => {
  throw Object.assign(new Error(message), { code });
};

function setup(rpc: Record<string, RpcHandler> = {}, tables: Record<string, Record<string, unknown>[]> = {}) {
  const exec = new MemoryDbExecutor({ rpc, tables });
  const sql = { db: new BenchDb(exec), query: async () => ({ rows: [] }) } as unknown as BenchSqlService;
  const handlers = new Map<string, BenchJobHandler>();
  const registry = { register: (n: string, h: BenchJobHandler) => handlers.set(n, h) } as unknown as BenchJobRegistry;
  const events: unknown[] = [];
  const bus = { publish: (e: unknown) => events.push(e) } as unknown as BenchEventBus;
  const jobs = new BenchTradingJobs({ solanaEnv: {} } as unknown as BenchConfig, SOLANA, registry, sql, bus);
  jobs.onModuleInit();
  return { exec, sql, handlers, events, jobs };
}

const position = (over: Record<string, unknown> = {}) => ({
  id: POS, user_id: 'u', book: 'main', mint: MINT, symbol: 'BAWSAQ', strategy: 'all_x2', stake_sol: 0.1, source: 'manual', status: 'pending',
  entry_target_price: 0.001, fill_price: null, sl_price: 0.0007, sl_pct: 30, custom_tp_price: null, expires_at: '2026-11-25T00:00:00+00:00',
  created_at: '2026-11-24T00:00:00.123456+00:00', filled_at: null, closed_at: null, pnl_sol: null, fees_sol: null, ...over,
});

describe('jobs de simulation', () => {
  it('enregistre paper-engine, backtest-run, backtest-nightly ; le nocturne appelle la fonction SQL d’origine', async () => {
    const { handlers, exec } = setup({ backtest_enqueue_nightly: () => 42 });
    expect([...handlers.keys()]).toEqual(['paper-engine', 'backtest-run', 'backtest-nightly']);
    expect(await handlers.get('backtest-nightly')!({ runId: 'n', startedAt: new Date(), mode: 'shadow', trigger: 'manual' })).toEqual({ run: 42 });
    expect(exec.rpcCalls).toEqual([{ name: 'backtest_enqueue_nightly', args: {} }]);
  });
});

describe('ex-RPC paper (SIMULATION)', () => {
  it('ouverture : arguments de paper_open_position, position relue avec ses jambes, signal SSE', async () => {
    const { sql, jobs, exec, events } = setup(
      { paper_open_position: (_args, db) => (db.table('paper_positions').push(position()), { id: POS }) },
      { paper_legs: [{ id: '00000000-0000-4000-8000-0000000000a1', position_id: POS, size_pct: 100, tp_price: 0.002, stop_price: 0.0007, status: 'open', exit_price: null, closed_at: null }] },
    );
    const ctrl = new BenchPaperController(sql, jobs);
    const res = await ctrl.open({ mint: MINT, strategy: 'all_x2', stake_sol: 0.1, entry_price: 0.001, sl_pct: 30, custom_tp_price: null, custom_sl_price: null, book: 'main' });
    expect(exec.rpcCalls[0]!.args).toEqual({ p_mint: MINT, p_strategy: 'all_x2', p_stake: 0.1, p_entry: 0.001, p_sl_pct: 30, p_custom_tp: null, p_custom_sl: null, p_book: 'main' });
    expect(res.legs).toHaveLength(1);
    expect(events).toEqual([{ type: 'paper.changed', book: 'main', position_id: POS }]);
  });

  it('refus du SQL d’origine (22023) → 422 PAPER_REJECTED ; carnet archivé → PAPER_BOOK_ARCHIVED sans appel SQL', async () => {
    const { sql, jobs, exec } = setup({ paper_open_position: sqlError('22023'), paper_reset_wallet: () => null });
    const ctrl = new BenchPaperController(sql, jobs);
    const req = { mint: MINT, strategy: 'half_x2_rest_x3' as const, stake_sol: 0.1, entry_price: 0.001, sl_pct: 30, custom_tp_price: null, custom_sl_price: null, book: 'main' as const };
    await expect(ctrl.open(req)).rejects.toMatchObject({ code: 'PAPER_REJECTED' });
    await expect(ctrl.reset({ book: 'calm_all_x2' })).rejects.toMatchObject({ code: 'PAPER_BOOK_ARCHIVED' });
    expect(exec.rpcCalls.map((c) => c.name)).toEqual(['paper_open_position']);
  });

  it('annulation : paper_cancel_position faux → 422', async () => {
    const { sql, jobs } = setup({ paper_cancel_position: () => false }, { paper_positions: [position()] });
    await expect(new BenchPaperController(sql, jobs).cancel({ id: POS })).rejects.toMatchObject({ code: 'PAPER_REJECTED' });
  });

  it('jambes triées par TP croissant (jambe A d’abord)', () => {
    const p = toPaperPosition({ ...position({ strategy: 'half_x2_rest_x3' }), paper_legs: [
      { id: '00000000-0000-4000-8000-0000000000b2', position_id: POS, size_pct: 50, tp_price: 0.003, stop_price: 0.0007, status: 'open', exit_price: null, closed_at: null },
      { id: '00000000-0000-4000-8000-0000000000b1', position_id: POS, size_pct: 50, tp_price: 0.002, stop_price: 0.0007, status: 'open', exit_price: null, closed_at: null },
    ] });
    expect(p!.legs.map((l) => l.tp_price)).toEqual([0.002, 0.003]);
  });
});

describe('ex-RPC performance et laboratoire', () => {
  it('paper_book_comparison : colonnes du contrat seulement', async () => {
    const { sql } = setup({ paper_book_comparison: () => [{ book: 'calm_sl30', trades: 3, tp_hits: 1, sl_hits: 2, tp_pct: 33, sl_pct: 66, pnl_sol: -0.02, max_drawdown_sol: 0.05, max_drawdown_pct: 5, worst_losing_streak: 2, open_positions: 1, target_trades: 100, balance_sol: 0.98, initial_sol: 1, since: null }] });
    const res = await new BenchPerformanceController(sql).books();
    expect(res.items).toEqual([{ book: 'calm_sl30', trades: 3, tp_hits: 1, sl_hits: 2, pnl_sol: -0.02, max_drawdown_sol: 0.05, worst_losing_streak: 2, open_positions: 1, target_trades: 100 }]);
  });

  it('backtest_request_run : 23514 → 409 avec le message d’origine ; succès → run « queued »', async () => {
    const busy = setup({ backtest_request_run: sqlError('23514', 'Un backtest est déjà en cours.') });
    await expect(new BenchLabController(busy.sql).request()).rejects.toMatchObject({ code: 'BACKTEST_ALREADY_QUEUED' });
    const ok = setup({ backtest_request_run: () => ({ id: 12, status: 'queued', trigger: 'manual', data_version: null, n_detections: null, n_variants: null, n_distinct_variants: null, progress: 0, created_at: '2026-11-24T10:00:00.1+00:00', started_at: null, finished_at: null, summary: null }) });
    expect(await new BenchLabController(ok.sql).request()).toMatchObject({ id: '12', status: 'queued' });
  });

  it('backfill_progress : `category` → `id`, champs du contrat', async () => {
    const { sql } = setup({ backfill_progress: () => ({ categories: [{ category: 'candles_1m', priority: 1, done: 5, total: 9, due_now: 2, last_24h: 4, eta_hours: 1 }], due_now: 2, rows_per_hour: 3, eta_hours: 0.7, eta_at: '2026-11-24T11:00:00+00:00', measured_hours: 6, generated_at: 'x' }) });
    expect(await new BenchLabController(sql).backfill()).toEqual({ categories: [{ id: 'candles_1m', done: 5, total: 9, due_now: 2, last_24h: 4, priority: 1 }], rows_per_hour: 3, due_now: 2, eta_hours: 0.7, eta_at: '2026-11-24T11:00:00+00:00' });
  });
});
