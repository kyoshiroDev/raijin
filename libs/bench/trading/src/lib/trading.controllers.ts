import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import {
  ARCHIVED_PAPER_BOOKS,
  BACKTEST_RESULTS_LIMIT_MAX,
  BENCH_ROUTES,
  PAPER_BOOKS,
  backfillProgressSchema,
  backtestResultSchema,
  backtestResultsQuerySchema,
  backtestRunParamsSchema,
  backtestRunSchema,
  backtestRunsQuerySchema,
  bookComparisonRowSchema,
  breakdownRowSchema,
  paperOpenRequestSchema,
  paperPositionParamsSchema,
  paperPositionSchema,
  paperPositionsQuerySchema,
  paperWalletParamsSchema,
  paperWalletSchema,
  presetPerformanceRowSchema,
  type BackfillProgress,
  type BacktestRun,
  type PaperBook,
  type PaperOpenRequest,
  type PaperPosition,
  type PaperPositionsQuery,
  type PaperWallet,
} from '@raijin/bench-contracts';
import { BenchException, BenchZodPipe } from '@raijin/bench-core';
import type { BenchDb, DbError } from '@raijin/bench-engine';
import { BenchSqlService } from '@raijin/bench-prisma';
import * as z from 'zod';
import { BenchTradingJobs } from './trading-jobs';

function validRows<T extends z.ZodType>(schema: T, rows: readonly unknown[]): z.output<T>[] {
  const out: z.output<T>[] = [];
  for (const row of rows) {
    const parsed = schema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function internal(): never {
  throw new BenchException('INTERNAL_ERROR', HttpStatus.INTERNAL_SERVER_ERROR);
}

/** Erreur d'une fonction SQL du paper trading : refus métier (422) ou panne (500). Le message SQL n'est pas renvoyé. */
function paperRefusal(error: DbError): never {
  if (error.code === '42501') throw BenchException.unauthorized();
  if (error.code && /^(22|23|P0)/.test(error.code)) throw new BenchException('PAPER_REJECTED', HttpStatus.UNPROCESSABLE_ENTITY);
  internal();
}

const POSITION_SELECT =
  'id, book, mint, symbol, strategy, stake_sol, source, status, entry_target_price, fill_price, sl_price, sl_pct, ' +
  'custom_tp_price, expires_at, created_at, filled_at, closed_at, pnl_sol, fees_sol, ' +
  'paper_legs(id, position_id, size_pct, tp_price, stop_price, status, exit_price, closed_at)';

/** Ligne SQL → contrat (`legs` triées par TP croissant, jambe A d'abord). */
export function toPaperPosition(row: Record<string, unknown>): PaperPosition | null {
  const legs = Array.isArray(row['paper_legs']) ? [...(row['paper_legs'] as Record<string, unknown>[])] : [];
  legs.sort((a, b) => (Number(a['tp_price'] ?? Infinity) || Infinity) - (Number(b['tp_price'] ?? Infinity) || Infinity));
  const { paper_legs: _legs, ...rest } = row;
  void _legs;
  const parsed = paperPositionSchema.safeParse({ ...rest, legs });
  return parsed.success ? parsed.data : null;
}

async function loadPosition(db: BenchDb, id: string): Promise<PaperPosition> {
  const { data, error } = await db.from('paper_positions').select(POSITION_SELECT).eq('id', id).maybeSingle();
  if (error) internal();
  const position = data ? toPaperPosition(data as Record<string, unknown>) : null;
  if (!position) throw new BenchException('NOT_FOUND', HttpStatus.NOT_FOUND);
  return position;
}

const booksQuerySchema = z.object({ books: paperPositionsQuerySchema.shape.books });

/** Paper trading (SIMULATION) : ex-lectures `paper_wallets` / `paper_positions` et RPC `paper_*` (SQL d'origine). */
@Controller()
export class BenchPaperController {
  constructor(
    private readonly sql: BenchSqlService,
    private readonly jobs: BenchTradingJobs,
  ) {}

  @Get(BENCH_ROUTES.paperWallets)
  async wallets(@Query(new BenchZodPipe(booksQuerySchema)) query: { books?: PaperBook[] }) {
    const books = query.books ?? [...PAPER_BOOKS];
    const { data, error } = await this.sql.db.from('paper_wallets').select('book, balance_sol, initial_sol, created_at, reset_at').in('book', books);
    if (error) internal();
    return { items: validRows(paperWalletSchema, (data ?? []) as unknown[]), truncated: false };
  }

  @Get(BENCH_ROUTES.paperPositions)
  async positions(@Query(new BenchZodPipe(paperPositionsQuerySchema)) query: PaperPositionsQuery) {
    let q = this.sql.db.from('paper_positions').select(POSITION_SELECT);
    if (query.books) q = q.in('book', query.books);
    if (query.status) q = q.eq('status', query.status);
    if (query.mint) q = q.eq('mint', query.mint);
    if (query.since) q = q.gte('created_at', query.since);
    const { data, error } = await q.order('created_at', { ascending: false }).limit(query.limit + 1);
    if (error) internal();
    const rows = (data ?? []) as Record<string, unknown>[];
    const items = rows.slice(0, query.limit).map(toPaperPosition).filter((p): p is PaperPosition => p !== null);
    return { items, truncated: rows.length > query.limit };
  }

  /** Ex-RPC `paper_open_position` (carnet `main`, stratégie `all_x2` : le SQL d'origine revérifie tout). */
  @Post(BENCH_ROUTES.paperPositions)
  @HttpCode(HttpStatus.CREATED)
  async open(@Body(new BenchZodPipe(paperOpenRequestSchema)) body: PaperOpenRequest): Promise<PaperPosition> {
    if ((ARCHIVED_PAPER_BOOKS as readonly string[]).includes(body.book)) throw new BenchException('PAPER_BOOK_ARCHIVED', HttpStatus.UNPROCESSABLE_ENTITY);
    const { data, error } = await this.sql.db.rpc('paper_open_position', {
      p_mint: body.mint,
      p_strategy: body.strategy,
      p_stake: body.stake_sol,
      p_entry: body.entry_price,
      p_sl_pct: body.sl_pct,
      p_custom_tp: body.custom_tp_price,
      p_custom_sl: body.custom_sl_price,
      p_book: body.book,
    });
    if (error) paperRefusal(error);
    const id = (data as { id?: unknown } | null)?.id;
    if (typeof id !== 'string') internal();
    this.jobs.paperChanged(body.book, id);
    return loadPosition(this.sql.db, id);
  }

  /** Ex-RPC `paper_cancel_position` : position `pending` du carnet principal seulement. */
  @Post(BENCH_ROUTES.paperPositionCancel)
  @HttpCode(HttpStatus.OK)
  async cancel(@Param(new BenchZodPipe(paperPositionParamsSchema)) params: { id: string }): Promise<PaperPosition> {
    if (!/^[0-9a-f-]{36}$/i.test(params.id)) throw new BenchException('NOT_FOUND', HttpStatus.NOT_FOUND);
    const before = await loadPosition(this.sql.db, params.id);
    if ((ARCHIVED_PAPER_BOOKS as readonly string[]).includes(before.book)) throw new BenchException('PAPER_BOOK_ARCHIVED', HttpStatus.UNPROCESSABLE_ENTITY);
    const { data, error } = await this.sql.db.rpc('paper_cancel_position', { p_id: params.id });
    if (error) paperRefusal(error);
    if (data !== true) throw new BenchException('PAPER_REJECTED', HttpStatus.UNPROCESSABLE_ENTITY);
    this.jobs.paperChanged(before.book, params.id);
    return loadPosition(this.sql.db, params.id);
  }

  /** Ex-RPC `paper_reset_wallet` (refusé sur un carnet archivé). */
  @Post(BENCH_ROUTES.paperWalletReset)
  @HttpCode(HttpStatus.OK)
  async reset(@Param(new BenchZodPipe(paperWalletParamsSchema)) params: { book: PaperBook }): Promise<PaperWallet> {
    if ((ARCHIVED_PAPER_BOOKS as readonly string[]).includes(params.book)) throw new BenchException('PAPER_BOOK_ARCHIVED', HttpStatus.UNPROCESSABLE_ENTITY);
    const { data, error } = await this.sql.db.rpc('paper_reset_wallet', { p_book: params.book });
    if (error) paperRefusal(error);
    const wallet = paperWalletSchema.safeParse(data);
    if (!wallet.success) internal();
    this.jobs.paperChanged(params.book);
    return wallet.data;
  }
}

/** Ex-RPC `performance_by_preset`, `paper_book_comparison`, `performance_breakdown` (SQL d'origine, lecture). */
@Controller()
export class BenchPerformanceController {
  constructor(private readonly sql: BenchSqlService) {}

  private async rows(fn: string): Promise<unknown[]> {
    const { data, error } = await this.sql.db.rpc(fn);
    if (error) internal();
    return Array.isArray(data) ? data : [];
  }

  @Get(BENCH_ROUTES.performancePresets)
  async presets() {
    return { items: validRows(presetPerformanceRowSchema, await this.rows('performance_by_preset')) };
  }

  @Get(BENCH_ROUTES.performanceBooks)
  async books() {
    return { items: validRows(bookComparisonRowSchema, await this.rows('paper_book_comparison')) };
  }

  @Get(BENCH_ROUTES.performanceBreakdown)
  async breakdown() {
    return { items: validRows(breakdownRowSchema, await this.rows('performance_breakdown')) };
  }
}

const RUN_SELECT = 'id, status, trigger, data_version, n_detections, n_variants, n_distinct_variants, progress, created_at, started_at, finished_at, summary';

function toRun(row: Record<string, unknown>): BacktestRun | null {
  const parsed = backtestRunSchema.safeParse({ ...row, id: String(row['id']), progress: Number(row['progress'] ?? 0) });
  return parsed.success ? parsed.data : null;
}

/** Laboratoire (SIMULATION sur données passées) : runs, résultats, rattrapage, demande de run. */
@Controller()
export class BenchLabController {
  constructor(private readonly sql: BenchSqlService) {}

  @Get(BENCH_ROUTES.labRuns)
  async runs(@Query(new BenchZodPipe(backtestRunsQuerySchema)) query: z.output<typeof backtestRunsQuerySchema>) {
    let q = this.sql.db.from('backtest_runs').select(RUN_SELECT);
    if (query.status) q = q.eq('status', query.status);
    const { data, error } = await q.order('created_at', { ascending: false }).limit(query.limit + 1);
    if (error) internal();
    const rows = (data ?? []) as Record<string, unknown>[];
    const items = rows.slice(0, query.limit).map(toRun).filter((r): r is BacktestRun => r !== null);
    return { items, truncated: rows.length > query.limit };
  }

  @Get(BENCH_ROUTES.labRunResults)
  async results(
    @Param(new BenchZodPipe(backtestRunParamsSchema)) params: { id: string },
    @Query(new BenchZodPipe(backtestResultsQuerySchema)) query: { retained?: boolean },
  ) {
    if (!/^\d{1,19}$/.test(params.id)) throw new BenchException('NOT_FOUND', HttpStatus.NOT_FOUND);
    const rows: Record<string, unknown>[] = [];
    // Pages de 1 000 (plafond PostgREST conservé) jusqu'à BACKTEST_RESULTS_LIMIT_MAX + 1.
    for (let from = 0; from <= BACKTEST_RESULTS_LIMIT_MAX; from += 1000) {
      let q = this.sql.db.from('backtest_results').select('*').eq('run_id', params.id);
      if (query.retained !== undefined) q = q.eq('retained', query.retained);
      const { data, error } = await q.order('avg_net_pct', { ascending: false, nullsFirst: false }).range(from, from + 999);
      if (error) internal();
      rows.push(...((data ?? []) as Record<string, unknown>[]));
      if ((data ?? []).length < 1000) break;
    }
    const items = validRows(backtestResultSchema, rows.slice(0, BACKTEST_RESULTS_LIMIT_MAX).map((r) => ({ ...r, run_id: String(r['run_id']) })));
    return { items, truncated: rows.length > BACKTEST_RESULTS_LIMIT_MAX };
  }

  /** Ex-RPC `backfill_progress` (jsonb) : `category` → `id`, champs du contrat seulement. */
  @Get(BENCH_ROUTES.labBackfill)
  async backfill(): Promise<BackfillProgress> {
    const { data, error } = await this.sql.db.rpc('backfill_progress');
    if (error) internal();
    const raw = (data ?? {}) as Record<string, unknown>;
    const categories = Array.isArray(raw['categories']) ? (raw['categories'] as Record<string, unknown>[]) : [];
    const parsed = backfillProgressSchema.safeParse({
      categories: categories.map((c) => ({
        id: c['category'],
        done: c['done'],
        total: c['total'],
        due_now: c['due_now'] ?? null,
        last_24h: c['last_24h'] ?? null,
        priority: c['priority'] ?? null,
      })),
      rows_per_hour: raw['rows_per_hour'] ?? null,
      due_now: raw['due_now'] ?? 0,
      eta_hours: raw['eta_hours'] ?? null,
      eta_at: raw['eta_at'] ?? null,
    });
    if (!parsed.success) internal();
    return parsed.data;
  }

  /** Ex-RPC `backtest_request_run` : 202 `queued` ; 409 si un run est en file / en cours ou a démarré il y a < 10 min. */
  @Post(BENCH_ROUTES.labRuns)
  @HttpCode(HttpStatus.ACCEPTED)
  async request(): Promise<BacktestRun> {
    const { data, error } = await this.sql.db.rpc('backtest_request_run');
    if (error) {
      if (error.code === '42501') throw BenchException.unauthorized();
      // Message rédigé par la fonction SQL d'origine (français, sans donnée) : repris tel quel.
      if (error.code === '23514') throw new BenchException('BACKTEST_ALREADY_QUEUED', HttpStatus.CONFLICT, error.message.slice(0, 300));
      internal();
    }
    const run = data ? toRun(data as Record<string, unknown>) : null;
    if (!run) internal();
    return run;
  }
}
