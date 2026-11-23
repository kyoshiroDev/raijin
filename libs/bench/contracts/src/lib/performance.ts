import * as z from './zod';
import { countSchema } from './common';
import { paperBookSchema } from './paper';

/**
 * Agrégats de performance (ex-RPC `performance_by_preset`, `paper_book_comparison`,
 * `performance_breakdown`), calculés par l'API en lecture : `GET /api/performance/presets`,
 * `GET /api/performance/books`, `GET /api/performance/breakdown`.
 */
export const perfPresetSchema = z.enum(['young_calm', 'young_frenzy']);
export const presetSegmentSchema = z.enum(['all', 'gta', 'other']);

export const presetPerformanceRowSchema = z.object({
  preset: perfPresetSchema,
  segment: presetSegmentSchema,
  signals: countSchema,
  labelled: countSchema,
  x2_before_sl30: countSchema,
  sl30_before_x2: countSchema,
  sim_pnl_sol: z.number().nullable(),
  trades: countSchema,
  paper_pnl_sol: z.number().nullable(),
  paper_open: countSchema,
});
export type PresetPerformanceRow = z.infer<typeof presetPerformanceRowSchema>;
export const presetPerformanceResponseSchema = z.object({ items: z.array(presetPerformanceRowSchema).max(50) });

export const bookComparisonRowSchema = z.object({
  book: paperBookSchema,
  trades: countSchema,
  tp_hits: countSchema,
  sl_hits: countSchema,
  pnl_sol: z.number(),
  max_drawdown_sol: z.number().nonnegative(),
  worst_losing_streak: countSchema,
  open_positions: countSchema,
  target_trades: countSchema,
});
export type BookComparisonRow = z.infer<typeof bookComparisonRowSchema>;
export const bookComparisonResponseSchema = z.object({ items: z.array(bookComparisonRowSchema).max(20) });

export const breakdownDimensionSchema = z.enum(['all', 'dex', 'mc', 'liq']);
export const breakdownRowSchema = z.object({
  source: z.literal('scan'),
  dimension: breakdownDimensionSchema,
  bucket: z.string().min(1).max(40),
  n: countSchema,
  n_final: countSchema,
  x2: countSchema,
  x3: countSchema,
  x2_before_sl30: countSchema,
  sl30_before_x2: countSchema,
  dd50_first: countSchema,
  median_max_multiple: z.number().nonnegative().nullable(),
});
export type BreakdownRow = z.infer<typeof breakdownRowSchema>;
export const breakdownResponseSchema = z.object({ items: z.array(breakdownRowSchema).max(200) });
