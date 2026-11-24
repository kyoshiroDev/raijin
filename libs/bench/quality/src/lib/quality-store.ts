import { Injectable } from '@nestjs/common';
import type { EngineVariant, FollowUpObservation, OutcomeClassification, VerdictRecord, FollowUpHorizon, StorageLevel } from '@raijin/bench-verdicts';
import { BenchSqlService } from '@raijin/bench-prisma';
import { toObservation, toVariant, toVerdictRecord, type DailyMetricRow, type VerdictRow } from './verdict-model';

/** Accès base de la mesure des verdicts, de la purge et de l'alerte de taille (SQL brut sur `raijin_bench`). */
export abstract class QualityStore {
  /** Détections récentes du banc (`signal_outcomes`), plus récentes d'abord. */
  abstract recentDetections(since: string, limit: number): Promise<string[]>;
  abstract recordedMints(mints: readonly string[], engineVersion: string): Promise<Set<string>>;
  abstract insertVerdict(row: VerdictRow): Promise<boolean>;
  /** Verdicts émis dans `[from ; to]` sans observation à `horizon`. */
  abstract dueRecords(horizon: FollowUpHorizon, from: string, to: string, limit: number): Promise<VerdictRecord[]>;
  abstract insertObservation(observation: FollowUpObservation, classification: OutcomeClassification | null): Promise<void>;
  abstract loadMeasured(since: string, limit: number): Promise<{ records: VerdictRecord[]; observations: FollowUpObservation[] }>;
  abstract upsertDailyMetrics(rows: readonly DailyMetricRow[]): Promise<number>;
  abstract enabledVariants(): Promise<EngineVariant[]>;
  abstract insertReplay(row: { variantId: string; fingerprint: string; referenceVersion: string; variantVersion: string; from: string; to: string; records: number; skipped: number; report: object }): Promise<void>;
  /** Étape de purge : nombre de lignes supprimées. */
  abstract purge(step: PurgeStep, cutoffs: { verdictRecordsBefore: string; jobRunsBefore: string }): Promise<number>;
  /** Abonnements push du propriétaire (≤ 10, déclencheur SQL), endpoints revalidés par `server-push`. */
  abstract pushTargets(): Promise<{ endpoint: string; p256dh: string; auth: string }[]>;
  abstract storageLevel(): Promise<StorageLevel | null>;
  abstract setStorageLevel(level: StorageLevel, ratio: number): Promise<void>;
}

/**
 * Étapes de `retention-purge`, dans l'ordre des anciens crons (03:15 → 03:30, docs/BENCH.md §3), puis les verdicts
 * (365 j, ARCHITECTURE §16.5) et `job_runs` (30 j). Le SQL des 5 premières est **celui de pg_cron**, inchangé.
 */
export const PURGE_STEPS = ['snapshots', 'scan-runs', 'alert-log', 'candles', 'lab', 'verdicts', 'job-runs'] as const;
export type PurgeStep = (typeof PURGE_STEPS)[number];

export const PURGE_SQL: Readonly<Record<Exclude<PurgeStep, 'verdicts' | 'job-runs'>, readonly string[]>> = {
  // raijin-purge-snapshots (schedule_purge_snapshots.sql)
  snapshots: [
    `delete from public.token_snapshots s
  where s.captured_at < now() - interval '30 days'
     or (s.captured_at < now() - interval '3 days'
         and not exists (
           select 1 from public.alert_log l
           where l.mint = s.mint and l.sent_at > now() - interval '30 days'
         )
         and exists (select 1 from public.signal_outcomes o where o.mint = s.mint))`,
  ],
  // raijin-purge-scan-runs (schedule_cron.sql)
  'scan-runs': [`delete from public.scan_runs where started_at < now() - interval '7 days'`],
  // raijin-purge-alert-log (schedule_cron.sql ; absent de la liste du 21/11, BENCH.md §9 P9)
  'alert-log': [`delete from public.alert_log where sent_at < now() - interval '30 days'`],
  // raijin-purge-candles (schedule_backtest.sql)
  candles: [`delete from public.ohlcv_candles where detected_at < now() - interval '30 days'`],
  // raijin-purge-lab (schedule_backtest.sql)
  lab: [
    `delete from public.backtest_events where event_at < now() - interval '30 days'`,
    `delete from public.backtest_event_state where key <> 'cursor' and updated_at < now() - interval '7 days'`,
    `delete from public.label_runs where at < now() - interval '7 days'`,
  ],
};

const STORAGE_STATE_KEY = 'storage.level';

@Injectable()
export class SqlQualityStore extends QualityStore {
  constructor(private readonly sql: BenchSqlService) {
    super();
  }

  async recentDetections(since: string, limit: number): Promise<string[]> {
    const r = await this.sql.query<{ mint: string }>(
      'select mint from public.signal_outcomes where detected_at >= $1 order by detected_at desc limit $2',
      [since, limit],
    );
    return r.rows.map((x) => x.mint);
  }

  async recordedMints(mints: readonly string[], engineVersion: string): Promise<Set<string>> {
    if (mints.length === 0) return new Set();
    const r = await this.sql.query<{ mint: string }>('select mint from public.verdict_records where engine_version = $1 and mint = any($2)', [engineVersion, [...mints]]);
    return new Set(r.rows.map((x) => x.mint));
  }

  async insertVerdict(row: VerdictRow): Promise<boolean> {
    const r = await this.sql.query(
      `insert into public.verdict_records (mint, verdict_at, engine_version, verdict, reason_codes, flagged_checks,
         baseline_price_usd, baseline_liquidity_usd, baseline_supply_raw, facts, facts_version)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
       on conflict (mint, engine_version) do nothing returning id`,
      [row.mint, row.verdict_at, row.engine_version, row.verdict, row.reason_codes, row.flagged_checks, row.baseline_price_usd, row.baseline_liquidity_usd, row.baseline_supply_raw, JSON.stringify(row.facts), row.facts_version],
    );
    return r.rows.length === 1;
  }

  async dueRecords(horizon: FollowUpHorizon, from: string, to: string, limit: number): Promise<VerdictRecord[]> {
    const r = await this.sql.query<{ j: string }>(
      `select coalesce(json_agg(v), '[]')::text as j from (
         select v.* from public.verdict_records v
          where v.verdict_at >= $1 and v.verdict_at <= $2
            and not exists (select 1 from public.follow_up_observations o where o.record_id = v.id and o.horizon = $3)
          order by v.verdict_at asc limit $4) v`,
      [from, to, horizon, limit],
    );
    return (JSON.parse(r.rows[0]?.j ?? '[]') as Record<string, unknown>[]).map(toVerdictRecord).filter((x): x is VerdictRecord => x !== null);
  }

  async insertObservation(o: FollowUpObservation, c: OutcomeClassification | null): Promise<void> {
    await this.sql.query(
      `insert into public.follow_up_observations (record_id, horizon, observed_at, pool_found, lp_removed, price_usd,
         liquidity_usd, volume_24h_usd, supply_raw, status, events)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict (record_id, horizon) do nothing`,
      [o.recordId, o.horizon, o.observedAt, o.poolFound, o.lpRemoved, o.priceUsd, o.liquidityUsd, o.volume24hUsd, o.supplyRaw, c?.status ?? null, c?.events ?? []],
    );
  }

  async loadMeasured(since: string, limit: number): Promise<{ records: VerdictRecord[]; observations: FollowUpObservation[] }> {
    const r = await this.sql.query<{ j: string }>(
      `select coalesce(json_agg(v), '[]')::text as j from (
         select * from public.verdict_records where verdict_at >= $1 order by verdict_at asc limit $2) v`,
      [since, limit],
    );
    const records = (JSON.parse(r.rows[0]?.j ?? '[]') as Record<string, unknown>[]).map(toVerdictRecord).filter((x): x is VerdictRecord => x !== null);
    if (records.length === 0) return { records, observations: [] };
    const o = await this.sql.query<{ j: string }>(
      `select coalesce(json_agg(o), '[]')::text as j from public.follow_up_observations o where o.record_id = any($1::uuid[])`,
      [records.map((x) => x.id)],
    );
    const observations = (JSON.parse(o.rows[0]?.j ?? '[]') as Record<string, unknown>[]).map(toObservation).filter((x): x is FollowUpObservation => x !== null);
    return { records, observations };
  }

  async upsertDailyMetrics(rows: readonly DailyMetricRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    await this.sql.query(
      `insert into public.daily_verdict_metrics (day, engine_version, horizon, verdict, outcome_status, n, signal_counts, computed_at)
       select x.day, x.engine_version, x.horizon, x.verdict, x.outcome_status, x.n, x.signal_counts, now()
         from json_populate_recordset(null::public.daily_verdict_metrics, $1::json) x
       on conflict (day, engine_version, horizon, verdict, outcome_status)
       do update set n = excluded.n, signal_counts = excluded.signal_counts, computed_at = now()`,
      [JSON.stringify(rows)],
    );
    return rows.length;
  }

  async enabledVariants(): Promise<EngineVariant[]> {
    const r = await this.sql.query<Record<string, unknown>>('select id, label, overrides, reason_weights from public.engine_variants where enabled order by id');
    return r.rows.map(toVariant).filter((x): x is EngineVariant => x !== null);
  }

  async insertReplay(row: { variantId: string; fingerprint: string; referenceVersion: string; variantVersion: string; from: string; to: string; records: number; skipped: number; report: object }): Promise<void> {
    await this.sql.query(
      `insert into public.variant_replays (variant_id, fingerprint, reference_version, variant_version, period_from, period_to, records, skipped_records, report)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [row.variantId, row.fingerprint, row.referenceVersion, row.variantVersion, row.from, row.to, row.records, row.skipped, JSON.stringify(row.report)],
    );
  }

  async purge(step: PurgeStep, cutoffs: { verdictRecordsBefore: string; jobRunsBefore: string }): Promise<number> {
    const statements: { text: string; values: unknown[] }[] =
      step === 'verdicts'
        ? [{ text: 'delete from public.verdict_records where verdict_at < $1', values: [cutoffs.verdictRecordsBefore] }]
        : step === 'job-runs'
          ? [{ text: "delete from public.job_runs where started_at < $1 and status <> 'running'", values: [cutoffs.jobRunsBefore] }]
          : PURGE_SQL[step].map((text) => ({ text, values: [] }));
    let deleted = 0;
    for (const s of statements) {
      const r = (await this.sql.query(s.text, s.values)) as { rows: unknown[]; rowCount?: number | null };
      deleted += r.rowCount ?? 0;
    }
    return deleted;
  }

  async pushTargets(): Promise<{ endpoint: string; p256dh: string; auth: string }[]> {
    const r = await this.sql.query<{ endpoint: string; p256dh: string; auth: string }>(
      'select endpoint, p256dh, auth from public.push_subscriptions order by created_at desc limit 10',
    );
    return r.rows;
  }

  async storageLevel(): Promise<StorageLevel | null> {
    const r = await this.sql.query<{ value: { level?: unknown } }>('select value from public.bench_state where key = $1', [STORAGE_STATE_KEY]);
    const level = r.rows[0]?.value?.level;
    return level === 'ok' || level === 'warn' || level === 'critical' ? level : null;
  }

  async setStorageLevel(level: StorageLevel, ratio: number): Promise<void> {
    await this.sql.query(
      `insert into public.bench_state (key, value, updated_at) values ($1, $2::jsonb, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [STORAGE_STATE_KEY, JSON.stringify({ level, ratio: Math.round(ratio * 10_000) / 10_000 })],
    );
  }
}
