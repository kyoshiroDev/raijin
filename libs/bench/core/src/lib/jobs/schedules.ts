import type { BenchJobName } from '@raijin/bench-contracts';

export interface BenchJobSchedule {
  /** Motif cron (UTC), identique à pg_cron Supabase pour les jobs portés (docs/BENCH.md §3). */
  readonly pattern: string;
  /** Durée du verrou anti-chevauchement, prolongée tant que le job tourne. */
  readonly lockTtlMs: number;
  /** Origine : tâche pg_cron portée, ou nouveau job du VPS (§16). */
  readonly origin: string;
}

const MINUTE = 60_000;

/**
 * Planning des jobs du banc. Les 4 purges nocturnes de Supabase (03:15 snapshots, 03:20 scan_runs, 03:25 alert_log
 * et bougies, 03:30 labo) sont regroupées en `retention-purge` à étapes ordonnées lancé à 03:15, après
 * `verdict-aggregate` (03:05 : les agrégats sont calculés avant la purge, ARCHITECTURE §16.5).
 */
export const BENCH_JOB_SCHEDULES: Readonly<Record<BenchJobName, BenchJobSchedule>> = {
  'scan-tokens': { pattern: '*/2 * * * *', lockTtlMs: 2 * MINUTE, origin: 'raijin-scan' },
  'enrich-tokens': { pattern: '1-59/2 * * * *', lockTtlMs: 2 * MINUTE, origin: 'raijin-enrich' },
  'label-outcomes': { pattern: '1-59/2 * * * *', lockTtlMs: 2 * MINUTE, origin: 'raijin-label' },
  'paper-engine': { pattern: '1-59/2 * * * *', lockTtlMs: 2 * MINUTE, origin: 'raijin-paper' },
  'backtest-run': { pattern: '* * * * *', lockTtlMs: 2 * MINUTE, origin: 'raijin-backtest-worker' },
  'backtest-nightly': { pattern: '40 3 * * *', lockTtlMs: 5 * MINUTE, origin: 'raijin-backtest-nightly' },
  'wallet-study-collect': { pattern: '* * * * *', lockTtlMs: 2 * MINUTE, origin: 'raijin-wallet-study' },
  'verdict-follow-up': { pattern: '*/15 * * * *', lockTtlMs: 10 * MINUTE, origin: 'VPS (§16.1, fenêtres 24 h / 72 h / 7 j)' },
  'verdict-aggregate': { pattern: '5 3 * * *', lockTtlMs: 10 * MINUTE, origin: 'VPS (§16.5, agrégats avant purge)' },
  'retention-purge': { pattern: '15 3 * * *', lockTtlMs: 15 * MINUTE, origin: 'raijin-purge-snapshots, -scan-runs, -alert-log, -candles, -lab + job_runs 30 j' },
  'storage-check': { pattern: '0 * * * *', lockTtlMs: 5 * MINUTE, origin: 'VPS (§16.5, alerte 80 % / 95 %)' },
};
