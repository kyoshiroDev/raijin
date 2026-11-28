import * as z from './zod';
import { countSchema, isoDateTimeSchema, listResponseSchema } from './common';

/**
 * Jobs BullMQ du banc (préfixe `raijin-bench`), un par Edge Function / tâche pg_cron portée, plus
 * les jobs de la mesure des verdicts. Fréquences : `docs/BENCH.md` (inventaire, identiques à
 * pg_cron). Chaque exécution écrit une ligne `job_runs` ; un chevauchement est journalisé `skipped`.
 */
export const BENCH_JOB_NAMES = [
  'scan-tokens',
  'enrich-tokens',
  'label-outcomes',
  'paper-engine',
  'backtest-run',
  /** Ex-pg_cron `raijin-backtest-nightly` (03:40 UTC) : met en file le run nocturne. */
  'backtest-nightly',
  'wallet-study-collect',
  'verdict-follow-up',
  'verdict-aggregate',
  'retention-purge',
  'storage-check',
] as const;
export const benchJobNameSchema = z.enum(BENCH_JOB_NAMES);
export type BenchJobName = z.infer<typeof benchJobNameSchema>;

export const BENCH_JOB_STATUSES = [
  'running',
  'success',
  'failed',
  'skipped',
] as const;
export const benchJobStatusSchema = z.enum(BENCH_JOB_STATUSES);
export type BenchJobStatus = z.infer<typeof benchJobStatusSchema>;

/** Erreur tronquée et sans secret (le runner retire URL, en-têtes et clés avant écriture). */
export const JOB_ERROR_MAX_LENGTH = 500;

export const jobRunSchema = z.object({
  id: z.string().min(1).max(40),
  job: benchJobNameSchema,
  status: benchJobStatusSchema,
  started_at: isoDateTimeSchema,
  finished_at: isoDateTimeSchema.nullable(),
  duration_ms: countSchema.nullable(),
  error: z.string().max(JOB_ERROR_MAX_LENGTH).nullable(),
});
export type JobRun = z.infer<typeof jobRunSchema>;

export const JOB_RUNS_LIMIT_MAX = 200;
/** `GET /api/jobs/runs?job=&status=&limit=`. */
export const jobRunsQuerySchema = z.object({
  job: benchJobNameSchema.optional(),
  status: benchJobStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(JOB_RUNS_LIMIT_MAX).default(50),
});
export type JobRunsQuery = z.infer<typeof jobRunsQuerySchema>;
export const jobRunsResponseSchema = listResponseSchema(
  jobRunSchema,
  JOB_RUNS_LIMIT_MAX,
);
export type JobRunsResponse = z.infer<typeof jobRunsResponseSchema>;
