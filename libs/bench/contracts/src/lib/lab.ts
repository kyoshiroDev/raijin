import * as z from './zod';
import { countSchema, fractionSchema, isoDateTimeSchema, listResponseSchema, rowIdSchema } from './common';

/**
 * Laboratoire de backtest (`backtest_runs`, `backtest_results`, ex-RPC `backfill_progress` et
 * `backtest_request_run`). SIMULATION : données passées rejouées, rien ne prédit l'avenir.
 * `data_version` et `summary` restent des objets JSON bornés, interprétés par le front (lab-summary).
 */
export const runStatusSchema = z.enum(['queued', 'running', 'done', 'failed']);
export const runTriggerSchema = z.enum(['nightly', 'manual']);
export const labPresetSchema = z.enum(['young_calm', 'young_frenzy', 'young_calm_ev', 'young_frenzy_ev']);
export const labNarrativeSchema = z.enum(['all', 'gta', 'other']);
export const labSplitSchema = z.enum(['train', 'test']);

const jsonObject = z.record(z.string().max(64), z.unknown());

export const backtestRunSchema = z.object({
  id: rowIdSchema,
  status: runStatusSchema,
  trigger: runTriggerSchema,
  data_version: jsonObject.nullable(),
  n_detections: countSchema.nullable(),
  n_variants: countSchema.nullable(),
  n_distinct_variants: countSchema.nullable(),
  progress: fractionSchema,
  created_at: isoDateTimeSchema,
  started_at: isoDateTimeSchema.nullable(),
  finished_at: isoDateTimeSchema.nullable(),
  summary: jsonObject.nullable(),
});
export type BacktestRun = z.infer<typeof backtestRunSchema>;

export const BACKTEST_RUNS_LIMIT_MAX = 50;
/** `GET /api/lab/runs?status=&limit=` : plus récents d'abord. */
export const backtestRunsQuerySchema = z.object({
  status: runStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(BACKTEST_RUNS_LIMIT_MAX).default(10),
});
export const backtestRunsResponseSchema = listResponseSchema(backtestRunSchema, BACKTEST_RUNS_LIMIT_MAX);

const pct = z.number().nullable();

export const backtestResultSchema = z.object({
  run_id: rowIdSchema,
  preset: labPresetSchema,
  exit: z.literal('all_x2'),
  sl_pct: z.number().positive(),
  breakeven: z.boolean(),
  /** 0 = pas de sortie temporelle. */
  time_exit_h: countSchema,
  /** 0 = entrée immédiate. */
  delay_min: countSchema,
  narrative: labNarrativeSchema,
  split: labSplitSchema,
  trades: countSchema,
  win_rate: fractionSchema.nullable(),
  avg_win_pct: pct,
  avg_loss_pct: pct,
  avg_net_pct: pct,
  avg_net_sol: pct,
  /** `null` : aucune perte (infini) ou aucun trade. */
  profit_factor: z.number().nonnegative().nullable(),
  max_drawdown_sol: z.number().nullable(),
  worst_losing_streak: countSchema.nullable(),
  ci_low: pct,
  ci_high: pct,
  ci_contains_zero: z.boolean().nullable(),
  open_at_end: countSchema.nullable(),
  retained: z.boolean(),
  robust: z.boolean(),
});
export type BacktestResult = z.infer<typeof backtestResultSchema>;

export const BACKTEST_RESULTS_LIMIT_MAX = 1000;
/** `GET /api/lab/runs/:id/results?retained=` . */
export const backtestRunParamsSchema = z.object({ id: rowIdSchema });
export const backtestResultsQuerySchema = z.object({
  retained: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});
export const backtestResultsResponseSchema = listResponseSchema(backtestResultSchema, BACKTEST_RESULTS_LIMIT_MAX);

/** `POST /api/lab/runs` (CSRF) → 202 `BacktestRun` (`queued`) ; 409 `BACKTEST_ALREADY_QUEUED`. */
export const backtestRequestResponseSchema = backtestRunSchema;

export const backfillCategoryIdSchema = z.enum(['preset_labels', 'event_candles', 'scan_labels', 'candles_1m', 'candles_5m']);
export const backfillCategorySchema = z.object({
  id: backfillCategoryIdSchema,
  done: countSchema,
  total: countSchema,
  due_now: countSchema.nullable(),
  last_24h: countSchema.nullable(),
  /** 1 = servi en premier. */
  priority: z.number().int().positive().nullable(),
});
/** `GET /api/lab/backfill` (ex-`backfill_progress`). */
export const backfillProgressSchema = z.object({
  categories: z.array(backfillCategorySchema).max(10),
  rows_per_hour: z.number().nonnegative().nullable(),
  due_now: countSchema,
  eta_hours: z.number().nonnegative().nullable(),
  eta_at: isoDateTimeSchema.nullable(),
});
export type BackfillProgress = z.infer<typeof backfillProgressSchema>;
