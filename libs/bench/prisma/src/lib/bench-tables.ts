/**
 * Inventaire des tables de `raijin_bench` (docs/BENCH.md §4, §8) : source unique pour les tests de
 * schéma, `infra/bench-migrate.sh` (T9) et la comparaison du mode ombre.
 */

/** Les 21 tables portées de Supabase (schéma `public`). */
export const PORTED_TABLES = [
  'tokens',
  'token_snapshots',
  'scan_runs',
  'push_subscriptions',
  'alert_settings',
  'alert_log',
  'signal_outcomes',
  'paper_wallets',
  'paper_positions',
  'paper_legs',
  'preset_signals',
  'ohlcv_candles',
  'backtest_runs',
  'backtest_trades',
  'backtest_results',
  'backtest_events',
  'backtest_event_state',
  'label_runs',
  'wallet_study_state',
  'early_buyers',
  'wallet_study_budget',
] as const;
export type PortedTable = (typeof PORTED_TABLES)[number];

/** Tables propres au VPS (compte unique, jobs, mesure des verdicts). */
export const BENCH_TABLES = [
  'bench_owner',
  'bench_owner_totp',
  'bench_recovery_codes',
  'bench_sessions',
  'job_runs',
  'bench_state',
  'verdict_records',
  'follow_up_observations',
  'daily_verdict_metrics',
  'engine_variants',
  'variant_replays',
] as const;
export type BenchTable = (typeof BENCH_TABLES)[number];

/** Tables Supabase mortes, jamais créées dans `public` (import facultatif dans `archive`, P4). */
export const DEAD_TABLES = [
  'watchlist',
  'model_weights',
  'paper_orders_v1',
  'early_candidates',
  'early_observations',
  'early_outcomes',
  'early_runs',
  'fast_watch',
  'fast_ticks',
  'test_push_throttle',
] as const;

/**
 * Colonnes archivées le 21/11 retirées de `public` (ni écrites ni lues par le code porté, P3).
 * Les autres colonnes archivées restent (encore lues : tokens.liquidity_jup_usd par le front,
 * token_snapshots.score / zone_status par x3_backfill_candidates, entry_* de signal_outcomes et
 * preset_signals par backtest-run).
 */
export const DROPPED_ARCHIVED_COLUMNS: Readonly<
  Partial<Record<PortedTable, readonly string[]>>
> = {
  tokens: [
    'score',
    'zone_status',
    'zone_source',
    'swing_low',
    'swing_high',
    'zone_low',
    'zone_high',
    'invalidation',
    'tp1',
    'tp2',
    'rr',
    'zone_candles_at',
    'p_x3',
    'p_dd50',
    'model_version',
    'model_calibrated',
  ],
  alert_log: ['entry_score', 'entry_zone'],
  alert_settings: [
    'min_score',
    'only_in_zone',
    'min_rr',
    'min_p_x3',
    'max_p_dd50',
    'young_strong_enabled',
    'paper_default_strategy',
    'auto_paper_parallel',
    'early_enabled',
    'early_min_score',
  ],
};

/** Tables copiées dans `shadow_ref` et colonne de date de la comparaison par jour. */
export const SHADOW_REF_DAY_COLUMNS = {
  tokens: 'first_seen_at',
  token_snapshots: 'captured_at',
  scan_runs: 'started_at',
  alert_log: 'sent_at',
  paper_positions: 'created_at',
  signal_outcomes: 'detected_at',
  preset_signals: 'detected_at',
} as const satisfies Partial<Record<PortedTable, string>>;
export type ShadowRefTable = keyof typeof SHADOW_REF_DAY_COLUMNS;

/**
 * Colonnes à identité `GENERATED ALWAYS` : un import qui garde les identifiants d'origine doit
 * utiliser `OVERRIDING SYSTEM VALUE` puis recaler la séquence (`setval`).
 */
export const IDENTITY_ALWAYS_TABLES = [
  'alert_log',
  'backtest_events',
  'backtest_runs',
  'label_runs',
  'ohlcv_candles',
  'preset_signals',
  'push_subscriptions',
  'scan_runs',
  'token_snapshots',
] as const satisfies readonly PortedTable[];

/** Contraintes `NOT VALID` (lignes historiques antérieures) : à suspendre pendant un import. */
export const NOT_VALID_CONSTRAINTS = [
  { table: 'alert_log', name: 'alert_log_single_has_plan' },
] as const;
