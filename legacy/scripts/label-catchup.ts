// One-off catch-up of the outcome labels (fix/measurement-and-criteria), run from a workstation.
// Why: from the Edge Function IP GeckoTerminal answers 429 after ~6 requests per run, so label-outcomes only labelled
// ~5 rows per hour and the radar queue never got its turn. This script labels the backlog from another IP, at an
// adaptive pace (starts at 1 request / 10 s, slows down on every 429, speeds up slowly after successes).
//
// Same pure code as the Edge Function: fetchCandleHistory (15-minute candles over the 7-day window) → labelOutcome →
// labelUpdate (+ next_label_at checkpoint, nextLabelAt in _shared/label-queue.ts: needs migration
// 20261119060000_label_checkpoints). Reads the queue and writes the labels through the Supabase CLI (`supabase db query --remote`), so no key
// is read or printed by this script. Candles are cached under CACHE_DIR (re-runs do not call GeckoTerminal again for
// windows already closed).
//
// Run (repo root): node --experimental-strip-types scripts/label-catchup.ts [--cache <dir>] [--limit <n>]
// Writes need the CLI confirmation flag (--yes), passed by the script: run it only when you mean to update production.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { labelOutcome } from '../supabase/functions/_shared/outcomes.ts';
import { isSolanaAddress } from '../supabase/functions/_shared/solana.ts';
import { setupZodForNode } from '../supabase/functions/_shared/test-support/zod-node.ts';
import type { Candle } from '../supabase/functions/_shared/types.ts';

// The _shared modules import `npm:zod` (Deno specifier): register the Node hook, then load them.
if (!(await setupZodForNode())) throw new Error('zod 3 not found in the pnpm store');
const { fetchCandleHistory } = await import('../supabase/functions/_shared/gecko-history.ts');
const { labelFailureUpdate, labelUpdate } = await import('../supabase/functions/_shared/x3-rows.ts');
const { withNextLabelAt } = await import('../supabase/functions/_shared/label-queue.ts');

// chore/slim-down: the radar queue (early_outcomes) is archived: signal_outcomes only.
type Table = 'signal_outcomes';
interface Row {
  tbl: Table;
  mint: string;
  pair: string;
  det: number;
  entry: number;
  attempts: number;
}

const args = process.argv.slice(2);
const argOf = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const CACHE_DIR = argOf('--cache') ?? '.label-cache';
const LIMIT = Number(argOf('--limit') ?? '100000');
const WRITE_BATCH = 25;
const HORIZON_MS = 7 * 24 * 3_600_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...m: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...m);

function cli(sql: string, write: boolean): unknown[] {
  const argv = ['supabase', 'db', 'query', '--remote', '--output-format', 'json', write ? '--yes' : '--read-only', sql];
  const res = spawnSync('npx', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = res.stdout ?? '';
  const start = out.indexOf('{');
  if (res.status !== 0 || start < 0) {
    // CLI error text only (the CLI never prints keys); trimmed.
    const text = `${res.stderr ?? ''}\n${out}`;
    const m = /(ERROR|error)[^\n]*/.exec(text.replace(/update public\.[^;]*;/g, '<sql>'));
    const detail = (m ? m[0] : text.replace(/update public\.[^;]*;/g, '<sql>'))
      // Never echo a connection string or password the CLI might print on a connection failure.
      .replace(/postgres(ql)?:\/\/\S+/gi, '<dsn>')
      .replace(/password=\S+/gi, 'password=<redacted>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    throw new Error(`supabase db query failed (exit ${res.status}): ${detail}`);
  }
  const parsed = JSON.parse(out.slice(start)) as { rows?: unknown[]; error?: { message?: string } };
  if (parsed.error) throw new Error(`supabase db query: ${String(parsed.error.message ?? 'error').slice(0, 200)}`);
  return parsed.rows ?? [];
}

const QUEUE_SQL = `
select tbl, mint, pair_address as pair, (extract(epoch from detected_at) * 1000)::bigint as det,
       entry_price::float8 as entry, label_attempts as attempts
from (
  select 'signal_outcomes' tbl, mint, pair_address, detected_at, entry_price, label_attempts from public.signal_outcomes
   where (x2_before_sl30 is null or (status = 'pending' and next_label_at <= now())) and detected_at <= now() - interval '1 hour'
) q
where pair_address is not null and entry_price > 0
order by detected_at asc`;

function parseRow(r: unknown): Row | null {
  if (typeof r !== 'object' || r === null) return null;
  const o = r as Record<string, unknown>;
  const tbl = o['tbl'] === 'signal_outcomes' ? o['tbl'] : null;
  const mint = typeof o['mint'] === 'string' && isSolanaAddress(o['mint']) ? o['mint'] : null;
  const pair = typeof o['pair'] === 'string' && isSolanaAddress(o['pair']) ? o['pair'] : null;
  const det = Number(o['det']);
  const entry = Number(o['entry']);
  if (!tbl || !mint || !pair || !Number.isFinite(det) || !(entry > 0)) return null;
  return { tbl, mint, pair, det, entry, attempts: Number(o['attempts']) || 0 };
}

const sqlValue = (v: unknown): string => {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  return `'${String(v).replace(/'/g, "''")}'`;
};

function updateSql(row: Row, payload: Record<string, unknown>): string {
  const sets = Object.entries(payload)
    .filter(([k]) => /^[a-z0-9_]+$/.test(k))
    // A final row stays final (a re-label only adds the new columns) and keeps no checkpoint.
    .map(([k, v]) =>
      k === 'status'
        ? `status = case when status = 'final' then 'final' else ${sqlValue(v)} end`
        : k === 'next_label_at'
        ? `next_label_at = case when status = 'final' then null else ${sqlValue(v)}::timestamptz end`
        : `${k} = ${sqlValue(v)}`
    )
    .join(', ');
  return `update public.${row.tbl} set ${sets} where mint = ${sqlValue(row.mint)};`;
}

async function main(): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const queue = cli(QUEUE_SQL, false).map(parseRow).filter((r): r is Row => r !== null).slice(0, LIMIT);
  log(`queue: ${queue.length} rows`);

  let spacing = 10_000;
  let okStreak = 0;
  let lastCall = 0;
  let pending: string[] = [];
  const counts = { labelled: 0, final: 0, failed: 0, cached: 0, rateLimited: 0, written: 0 };
  const flush = () => {
    if (pending.length === 0) return;
    cli(`begin; ${pending.join(' ')} commit;`, true);
    counts.written += pending.length;
    pending = [];
  };

  for (const [i, row] of queue.entries()) {
    const cacheFile = join(CACHE_DIR, `${row.tbl}-${row.mint}.json`);
    const now = Date.now();
    let candles: Candle[] | null = null;
    // A closed window (detection + 7 d in the past) never changes: reuse the cache.
    if (existsSync(cacheFile) && row.det + HORIZON_MS < now) {
      candles = JSON.parse(readFileSync(cacheFile, 'utf8')) as Candle[];
      counts.cached++;
    }
    let payload: Record<string, unknown>;
    if (!candles) {
      for (;;) {
        const wait = lastCall + spacing - Date.now();
        if (wait > 0) await sleep(wait);
        lastCall = Date.now();
        const h = await fetchCandleHistory(row.pair, row.mint, row.det, Date.now(), { maxPages: 2, beforeRequest: () => sleep(spacing) });
        if (h.status === 'rate_limited') {
          counts.rateLimited++;
          okStreak = 0;
          spacing = Math.min(Math.round(spacing * 1.5), 30_000);
          await sleep(30_000);
          continue;
        }
        if (h.status === 'ok') {
          candles = h.candles;
          writeFileSync(cacheFile, JSON.stringify(candles));
          if (++okStreak >= 10 && spacing > 6_000) {
            spacing -= 500;
            okStreak = 0;
          }
        } else {
          const failedAt = Date.now();
          payload = withNextLabelAt(labelFailureUpdate(h.error ?? 'label failed', row.attempts, failedAt), row.det, failedAt, false);
          pending.push(updateSql(row, payload));
          counts.failed++;
        }
        break;
      }
    }
    if (candles) {
      const at = Date.now();
      payload = withNextLabelAt(labelUpdate(labelOutcome(row.entry, row.det, candles, at), row.attempts, at), row.det, at, true);
      pending.push(updateSql(row, payload));
      counts.labelled++;
      if (payload['status'] === 'final') counts.final++;
    }
    if (pending.length >= WRITE_BATCH) flush();
    if ((i + 1) % 25 === 0) log(`${i + 1}/${queue.length}`, JSON.stringify(counts), `spacing ${spacing} ms`);
  }
  flush();
  log('done', JSON.stringify(counts));
}

main().catch((e: unknown) => {
  console.error('label-catchup failed:', (e instanceof Error ? e.message : String(e)).slice(0, 300));
  process.exit(1);
});
