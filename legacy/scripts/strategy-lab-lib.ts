// Pure helpers of the strategy-lab local scripts (scripts/candle-catchup.ts, scripts/backtest-local.ts): Supabase CLI
// command choice, SQL builders, seed-file parsing, detection loading. No I/O except through injected functions, no zod
// (the scripts load the zod-dependent _shared modules themselves). Tests: scripts/strategy-lab-lib_test.ts.
import type { SpawnSyncReturns } from 'node:child_process';
import {
  cleanCandles,
  type OhlcvCandlesRow,
  ohlcvRow,
} from '../supabase/functions/_shared/candles.ts';
import { isSolanaAddress } from '../supabase/functions/_shared/solana.ts';

// ---------------------------------------------------------------------------------------------------------------
// Supabase CLI

export interface CliCommand {
  cmd: string;
  /** Arguments placed before the `db query …` arguments. */
  prefix: string[];
}

type Probe = (cmd: string, args: string[]) => Pick<SpawnSyncReturns<string>, 'status' | 'error'>;

/**
 * `supabase` when it is on PATH (probe: `supabase --version` exits 0), else `npx supabase` (the security review
 * flagged bare npx as a supply-chain risk: install the CLI to avoid the fallback). Never a shell: argument lists only.
 */
export function supabaseCommand(probe: Probe): CliCommand {
  try {
    const r = probe('supabase', ['--version']);
    if (!r.error && r.status === 0) return { cmd: 'supabase', prefix: [] };
  } catch {
    // not on PATH
  }
  return { cmd: 'npx', prefix: ['supabase'] };
}

/** Argument list of `supabase db query` (read-only unless write). The SQL is ONE argument (no shell). */
export function dbQueryArgs(c: CliCommand, sql: string, write: boolean): string[] {
  return [...c.prefix, 'db', 'query', '--remote', '--output-format', 'json', write ? '--yes' : '--read-only', sql];
}

/** CLI stdout → rows. Throws a short message (never the stdout itself, which could echo SQL). */
export function parseCliOutput(status: number | null, stdout: string | null | undefined): unknown[] {
  const out = stdout ?? '';
  const start = out.indexOf('{');
  if (status !== 0 || start < 0) throw new Error(`supabase db query failed (exit ${status})`);
  const parsed = JSON.parse(out.slice(start)) as { rows?: unknown[]; error?: { message?: string } };
  if (parsed.error) throw new Error(`supabase db query: ${String(parsed.error.message ?? 'error').slice(0, 200)}`);
  return Array.isArray(parsed.rows) ? parsed.rows : [];
}

/** Linux caps ONE argv string at 128 KiB (MAX_ARG_STRLEN): SQL batches stay well below. */
export const MAX_SQL_CHARS = 100_000;

// ---------------------------------------------------------------------------------------------------------------
// SQL builders

export const sqlString = (v: string): string => `'${v.replace(/'/g, "''")}'`;

export const sqlValue = (v: unknown): string => {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  return sqlString(String(v));
};

/** Postgres array literal of finite numbers, e.g. '{1,2.5}'::real[]. Throws on a non-finite value. */
export function sqlNumArray(values: readonly number[], type: 'real' | 'int'): string {
  for (const v of values) if (typeof v !== 'number' || !Number.isFinite(v)) throw new RangeError('sqlNumArray: non-finite value');
  if (type === 'int' && !values.every((v) => Number.isInteger(v))) throw new RangeError('sqlNumArray: non-integer value');
  // real is float32 (~7 significant digits): 8 digits lose nothing and keep one 864-candle row near 50 KB.
  const text = type === 'real' ? values.map((v) => String(Number(v.toPrecision(8)))) : values.map(String);
  return `'{${text.join(',')}}'::${type}[]`;
}

const OHLCV_COLUMNS = 'mint, pool, tf, ts_start, step_s, ts, o, h, l, c, v, source, detected_at, fetched_at';

/** VALUES tuple of one ohlcv_candles row (addresses re-validated). */
export function ohlcvValues(r: OhlcvCandlesRow): string {
  if (!isSolanaAddress(r.mint) || !isSolanaAddress(r.pool)) throw new RangeError('ohlcvValues: invalid address');
  return `(${[
    sqlString(r.mint),
    sqlString(r.pool),
    sqlString(r.tf),
    `${sqlString(r.ts_start)}::timestamptz`,
    String(Math.floor(r.step_s)),
    sqlNumArray(r.ts, 'int'),
    sqlNumArray(r.o, 'real'),
    sqlNumArray(r.h, 'real'),
    sqlNumArray(r.l, 'real'),
    sqlNumArray(r.c, 'real'),
    sqlNumArray(r.v, 'real'),
    sqlString(r.source),
    `${sqlString(r.detected_at)}::timestamptz`,
    `${sqlString(r.fetched_at)}::timestamptz`,
  ].join(', ')})`;
}

/** INSERT of several rows; an existing (mint, tf, ts_start) is left as is (never re-downloaded / overwritten). */
export function insertOhlcvSql(rows: readonly OhlcvCandlesRow[]): string {
  if (rows.length === 0) return '';
  return `insert into public.ohlcv_candles (${OHLCV_COLUMNS}) values ${rows.map(ohlcvValues).join(', ')} on conflict (mint, tf, ts_start) do nothing;`;
}

/** Groups statements into transactions `begin; … commit;` of at most maxChars each (a longer statement goes alone). */
export function batchStatements(statements: readonly string[], maxChars = MAX_SQL_CHARS): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let size = 0;
  for (const s of statements) {
    if (!s) continue;
    if (cur.length > 0 && size + s.length + 1 > maxChars - 16) {
      out.push(`begin; ${cur.join(' ')} commit;`);
      cur = [];
      size = 0;
    }
    cur.push(s);
    size += s.length + 1;
  }
  if (cur.length > 0) out.push(`begin; ${cur.join(' ')} commit;`);
  return out;
}

const QUEUE_KEYS = new Set(['candles_1m_at', 'candles_5m_at', 'candles_attempts']);

/** UPDATE of the capture-queue columns of one detection row (only candles_* keys are accepted). */
export function queueUpdateSql(
  table: 'signal_outcomes' | 'preset_signals',
  keyColumn: 'mint' | 'id',
  keyValue: string | number,
  payload: Record<string, unknown>,
): string {
  if (table !== 'signal_outcomes' && table !== 'preset_signals') throw new RangeError('queueUpdateSql: table');
  if ((table === 'signal_outcomes') !== (keyColumn === 'mint')) throw new RangeError('queueUpdateSql: key');
  if (keyColumn === 'mint' && !isSolanaAddress(keyValue)) throw new RangeError('queueUpdateSql: mint');
  if (keyColumn === 'id' && !(typeof keyValue === 'number' && Number.isSafeInteger(keyValue) && keyValue > 0)) {
    throw new RangeError('queueUpdateSql: id');
  }
  const sets = Object.entries(payload)
    .filter(([k]) => QUEUE_KEYS.has(k))
    .map(([k, v]) => `${k} = ${k === 'candles_attempts' ? sqlValue(v) : v === null ? 'null' : `${sqlValue(v)}::timestamptz`}`);
  if (sets.length === 0) return '';
  return `update public.${table} set ${sets.join(', ')} where ${keyColumn} = ${sqlValue(keyValue)};`;
}

// ---------------------------------------------------------------------------------------------------------------
// 15-minute seed (label cache)

/** Label-cache file names `<table>-<mint>.json` → the signal_outcomes ones (the radar is not covered). */
export function seedFiles(names: readonly string[]): { mint: string; file: string }[] {
  const out: { mint: string; file: string }[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const m = /^signal_outcomes-([1-9A-HJ-NP-Za-km-z]{32,44})\.json$/.exec(name);
    if (!m || !isSolanaAddress(m[1]) || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ mint: m[1], file: name });
  }
  return out;
}

const SEED_STEP_S = 900;
const SEED_HORIZON_S = 7 * 24 * 3600;

/**
 * 15-minute ohlcv_candles row from a cached label window: candles from the one containing the detection to
 * detection + 7 days (the label window), source signal_outcomes. null when nothing valid remains.
 */
export function seedRow(
  candles: unknown,
  det: { mint: string; pool: string; detectedAtMs: number },
  fetchedAtMs: number,
): OhlcvCandlesRow | null {
  if (!Array.isArray(candles) || !Number.isFinite(det?.detectedAtMs)) return null;
  const detSec = det.detectedAtMs / 1000;
  const from = Math.floor(detSec / SEED_STEP_S) * SEED_STEP_S;
  const inWindow = cleanCandles(candles).filter((c) => c[0] >= from && c[0] <= detSec + SEED_HORIZON_S);
  return ohlcvRow({ mint: det.mint, pool: det.pool, tf: '15m', candles: inWindow, source: 'signal_outcomes', detectedAtMs: det.detectedAtMs, fetchedAtMs });
}

/** `select mint, pair_address, detected_at from signal_outcomes where mint in (…)` for validated mints. */
export function seedDetectionsSql(mints: readonly string[]): string {
  const valid = mints.filter((m) => isSolanaAddress(m));
  if (valid.length === 0) return '';
  return `select mint, pair_address, detected_at from public.signal_outcomes where pair_address is not null and mint in (${valid.map(sqlString).join(', ')})`;
}

// ---------------------------------------------------------------------------------------------------------------
// Capture queue (catch-up)

/** Due capture rows of both tables (pair known), oldest first. */
export const CANDLE_QUEUE_SQL = `
select 'signal_outcomes' as tbl, null::bigint as id, mint, pair_address, detected_at, candles_1m_at, candles_5m_at, candles_attempts
  from public.signal_outcomes
 where pair_address is not null and (candles_1m_at <= now() or candles_5m_at <= now())
union all
select 'preset_signals', id, mint, pair_address, detected_at, candles_1m_at, candles_5m_at, candles_attempts
  from public.preset_signals
 where pair_address is not null and (candles_1m_at <= now() or candles_5m_at <= now())
order by detected_at asc`;

/** Windows already stored (to skip a second download for another detection of the same mint). */
export const STORED_WINDOWS_SQL = `select mint, tf, detected_at from public.ohlcv_candles where tf in ('1m', '5m')`;

// ---------------------------------------------------------------------------------------------------------------
// Local backtest reads (read-only)

/** Detections at detection time, with the narrative fallback on tokens.narrative. Only mints with stored candles. */
export const BACKTEST_DETECTIONS_SQL = `
select 'signal_outcomes' as src, null::bigint as id, o.mint, o.detected_at, o.entry_mc, o.entry_liq_eff, o.entry_zone, o.entry_dex_id,
       o.entry_roundtrip_pct, null::numeric as entry_change_1h, null::numeric as pair_age_h, o.features,
       t.narrative
  from public.signal_outcomes o left join public.tokens t on t.mint = o.mint
 where exists (select 1 from public.ohlcv_candles c where c.mint = o.mint)
union all
select 'preset_signals', p.id, p.mint, p.detected_at, p.entry_mc, p.entry_liq_eff, p.entry_zone, p.entry_dex_id,
       p.entry_roundtrip_pct, p.entry_change_1h, p.pair_age_h, null::jsonb,
       coalesce(p.narrative, t.narrative)
  from public.preset_signals p left join public.tokens t on t.mint = p.mint
 where exists (select 1 from public.ohlcv_candles c where c.mint = p.mint)
order by detected_at asc`;

/** ohlcv_candles rows of a batch of mints. */
export function candlesForMintsSql(mints: readonly string[]): string {
  const valid = mints.filter((m) => isSolanaAddress(m));
  if (valid.length === 0) return '';
  return `select mint, tf, ts_start, step_s, ts, o, h, l, c from public.ohlcv_candles where mint in (${valid.map(sqlString).join(', ')})`;
}

/** A BACKTEST_DETECTIONS_SQL row → (source, row) for detectionFromRow. */
export function detectionSource(row: unknown): { source: 'signal_outcomes' | 'preset_signals'; row: Record<string, unknown> } | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  if (r.src !== 'signal_outcomes' && r.src !== 'preset_signals') return null;
  let features = r.features;
  if (typeof features === 'string' && features.length <= 16_384) {
    try {
      features = JSON.parse(features);
    } catch {
      features = null;
    }
  }
  return { source: r.src, row: { ...r, features } };
}

/** Splits a list into chunks of `size`. */
export function chunks<T>(items: readonly T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** Value of `--name <value>` in argv. */
export function argOf(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
