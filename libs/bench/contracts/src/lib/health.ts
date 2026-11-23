import { STORAGE_ALERT_RATIOS, STORAGE_LEVELS } from '@raijin/bench-verdicts';
import * as z from './zod';
import { countSchema, fractionSchema, isoDateTimeSchema } from './common';
import { benchJobNameSchema, benchJobStatusSchema } from './jobs';
import { benchModeSchema } from './mode';

/**
 * Santé et stockage du banc.
 * - `GET /api/health` (public derrière le basicAuth Traefik, sans donnée) → `BenchLiveness` ;
 * - `GET /api/status` (session) → `BenchStatus` : dépendances, dernier run par job, taille de base.
 * Seuils de taille (80 % / 95 %, alerte seulement à la hausse) : `@raijin/bench-verdicts`.
 */
export const benchLivenessSchema = z.object({ status: z.enum(['ok', 'degraded']) });
export type BenchLiveness = z.infer<typeof benchLivenessSchema>;

export const dependencyStateSchema = z.enum(['up', 'down', 'not_configured']);

export const storageLevelSchema = z.enum(STORAGE_LEVELS);
export const BENCH_STORAGE_ALERT_RATIOS = STORAGE_ALERT_RATIOS;

export const benchStorageSchema = z.object({
  /** `pg_database_size('raijin_bench')`. */
  used_bytes: countSchema,
  /** Allocation déclarée (`BENCH_DB_ALLOCATED_BYTES`). */
  allocated_bytes: z.number().int().positive(),
  ratio: z.number().nonnegative(),
  level: storageLevelSchema,
  measured_at: isoDateTimeSchema,
});
export type BenchStorage = z.infer<typeof benchStorageSchema>;

export const jobHealthSchema = z.object({
  job: benchJobNameSchema,
  last_status: benchJobStatusSchema.nullable(),
  last_started_at: isoDateTimeSchema.nullable(),
  last_success_at: isoDateTimeSchema.nullable(),
  /** Échecs consécutifs depuis le dernier succès. */
  consecutive_failures: countSchema,
});
export type JobHealth = z.infer<typeof jobHealthSchema>;

/**
 * État de l'étude des premiers acheteurs (wallet-study, BENCH.md §9 P1) : `active` ; `not_configured` (pas de
 * `BENCH_HELIUS_API_KEY`) ; `method_unavailable` (`getTransactionsForAddress` absent de l'offre Helius : étude
 * désactivée, nouvel essai le lendemain) ; `budget_exhausted` (plafond `BENCH_WALLET_STUDY_DAILY_CREDITS` du jour).
 */
export const WALLET_STUDY_STATES = ['active', 'not_configured', 'method_unavailable', 'budget_exhausted'] as const;
export const walletStudyStateSchema = z.enum(WALLET_STUDY_STATES);
export type WalletStudyState = z.infer<typeof walletStudyStateSchema>;

export const walletStudyHealthSchema = z.object({
  state: walletStudyStateSchema,
  /** Crédits consommés aujourd'hui (UTC) par l'étude, compris dans le budget Helius du banc. */
  credits_used: countSchema,
  credits_budget: countSchema,
});
export type WalletStudyHealth = z.infer<typeof walletStudyHealthSchema>;

export const benchStatusSchema = z.object({
  mode: benchModeSchema,
  version: z.string().max(40),
  dependencies: z.object({
    database: dependencyStateSchema,
    redis: dependencyStateSchema,
    helius: dependencyStateSchema,
    push: dependencyStateSchema,
    email: dependencyStateSchema,
  }),
  /** Crédits Helius consommés aujourd'hui (budget du banc : 10 000/jour), `null` sans clé. */
  helius_credits: z.object({ used: countSchema, budget: countSchema, ratio: fractionSchema }).nullable(),
  wallet_study: walletStudyHealthSchema,
  jobs: z.array(jobHealthSchema).max(benchJobNameSchema.options.length),
  storage: benchStorageSchema.nullable(),
});
export type BenchStatus = z.infer<typeof benchStatusSchema>;
