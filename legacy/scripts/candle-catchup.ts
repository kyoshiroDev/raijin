// Local catch-up of the backtest candles (feat/strategy-lab, docs/contracts/strategy-lab.md §B1), run from a
// workstation. Same model as scripts/label-catchup.ts: the Supabase CLI (`supabase db query --remote`) reads the queue
// and writes the rows, so this script never reads nor prints a key; GeckoTerminal is called at an adaptive pace
// (starts at 1 request / 10 s, slows down on every 429, speeds up slowly after successes); windows already fetched
// are cached under --cache (a closed window never changes).
//
// Modes:
//   default            1m / 5m backlog: rows of signal_outcomes / preset_signals whose candles_1m_at / candles_5m_at
//                      is due → ONE GeckoTerminal request per window (fetchCandleWindow) → ohlcv_candles row + queue
//                      update (candlesDoneUpdate / candlesFailureUpdate). A window already covered by a stored window
//                      of the same mint (another detection minutes apart) is marked done without a request.
//   --seed-15m <dir>   imports the label catch-up cache (files signal_outcomes-<mint>.json = Candle[] of 15-minute
//                      candles over the 7-day label window) as tf '15m' rows. NO GeckoTerminal call. The radar files
//                      (early_outcomes-*) are skipped (not covered by the lab).
// Options: --cache <dir> (default .candle-cache), --limit <n>, --dry-run (no write; the default mode still calls
//          GeckoTerminal unless combined with --seed-15m).
//
// Run (repo root, after the ohlcv_candles migration):
//   node --experimental-strip-types scripts/candle-catchup.ts --seed-15m <dir> [--dry-run]
//   node --experimental-strip-types scripts/candle-catchup.ts [--limit <n>] [--cache <dir>]
// Writes pass the CLI confirmation flag (--yes): run it only when you mean to update production.
// CLI: `supabase` when on PATH, else `npx supabase` (install the CLI to avoid npx).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupZodForNode } from '../supabase/functions/_shared/test-support/zod-node.ts';
import { candlePlan, captureWindow, isWindowCovered, ohlcvRow, type OhlcvCandlesRow } from '../supabase/functions/_shared/candles.ts';
import type { Candle } from '../supabase/functions/_shared/types.ts';
import {
  argOf,
  batchStatements,
  CANDLE_QUEUE_SQL,
  chunks,
  dbQueryArgs,
  insertOhlcvSql,
  parseCliOutput,
  queueUpdateSql,
  seedDetectionsSql,
  seedFiles,
  seedRow,
  STORED_WINDOWS_SQL,
  supabaseCommand,
} from './strategy-lab-lib.ts';

const args = process.argv.slice(2);
const SEED_DIR = argOf(args, '--seed-15m');
const CACHE_DIR = argOf(args, '--cache') ?? '.candle-cache';
const LIMIT = Number(argOf(args, '--limit') ?? '100000');
const DRY_RUN = args.includes('--dry-run');
/** One row per INSERT (a 5m row is ~50 KB of SQL); batchStatements packs them under the argv limit. */
const ROWS_PER_INSERT = 1;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...m: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...m);

const CLI = supabaseCommand((cmd, a) => spawnSync(cmd, a, { encoding: 'utf8', timeout: 30_000 }));

function cli(sql: string, write: boolean): unknown[] {
  if (write && DRY_RUN) return [];
  const res = spawnSync(CLI.cmd, dbQueryArgs(CLI, sql, write), { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return parseCliOutput(res.status, res.stdout);
}

/** Inserts rows + runs extra statements, in transactions small enough for one argv string. */
function writeAll(rows: OhlcvCandlesRow[], extra: string[]): number {
  const statements = [...chunks(rows, ROWS_PER_INSERT).map(insertOhlcvSql), ...extra].filter((s) => s.length > 0);
  for (const sql of batchStatements(statements)) cli(sql, true);
  return statements.length;
}

async function seed15m(dir: string): Promise<void> {
  const files = seedFiles(readdirSync(dir));
  log(`seed 15m: ${files.length} signal_outcomes files in the cache`);
  const dets = new Map<string, { pool: string; detectedAtMs: number }>();
  for (const batch of chunks(files.map((f) => f.mint), 200)) {
    for (const r of cli(seedDetectionsSql(batch), false)) {
      const o = r as Record<string, unknown>;
      const ms = typeof o.detected_at === 'string' ? Date.parse(o.detected_at) : NaN;
      if (typeof o.mint === 'string' && typeof o.pair_address === 'string' && Number.isFinite(ms)) {
        dets.set(o.mint, { pool: o.pair_address, detectedAtMs: ms });
      }
    }
  }
  const rows: OhlcvCandlesRow[] = [];
  const counts = { files: files.length, noDetection: 0, empty: 0, rows: 0, candles: 0 };
  for (const f of files.slice(0, LIMIT)) {
    const det = dets.get(f.mint);
    if (!det) {
      counts.noDetection++;
      continue;
    }
    const path = join(dir, f.file);
    let candles: unknown;
    try {
      candles = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch {
      counts.empty++;
      continue;
    }
    const row = seedRow(candles, { mint: f.mint, ...det }, statSync(path).mtimeMs);
    if (!row) {
      counts.empty++;
      continue;
    }
    rows.push(row);
    counts.rows++;
    counts.candles += row.ts.length;
  }
  if (!DRY_RUN) writeAll(rows, []);
  log(DRY_RUN ? 'seed 15m (dry run, nothing written)' : 'seed 15m done', JSON.stringify(counts));
}

async function catchUp(): Promise<void> {
  if (!(await setupZodForNode())) throw new Error('zod 3 not found in the pnpm store');
  const { fetchCandleWindow } = await import('../supabase/functions/_shared/gecko-history.ts');
  const { candlesDoneUpdate, candlesFailureUpdate, mergeWorkQueue, parseCandleRow } = await import(
    '../supabase/functions/_shared/candle-queue.ts'
  );
  mkdirSync(CACHE_DIR, { recursive: true });
  const now = Date.now();
  const items = cli(CANDLE_QUEUE_SQL, false).flatMap((r) => {
    const o = r as Record<string, unknown>;
    return o.tbl === 'signal_outcomes' || o.tbl === 'preset_signals' ? parseCandleRow(o.tbl, o, now) : [];
  });
  // Same order as label-outcomes: preset windows first, then scan windows (labels are not handled here).
  const queue = mergeWorkQueue([], items, LIMIT).flatMap((w) => (w.kind === 'candles' ? [w.item] : []));
  const stored = new Map<string, { tf: unknown; detected_at: unknown }[]>();
  for (const r of cli(STORED_WINDOWS_SQL, false)) {
    const o = r as Record<string, unknown>;
    if (typeof o.mint !== 'string') continue;
    const list = stored.get(o.mint) ?? [];
    list.push({ tf: o.tf, detected_at: o.detected_at });
    stored.set(o.mint, list);
  }
  log(`queue: ${queue.length} windows (${queue.filter((i) => i.tf === '1m').length} × 1m)`);

  let spacing = 10_000;
  let okStreak = 0;
  let lastCall = 0;
  let rows: OhlcvCandlesRow[] = [];
  let updates: string[] = [];
  const counts = { captured: 0, empty: 0, covered: 0, cached: 0, failed: 0, rateLimited: 0, statements: 0 };
  const flush = () => {
    counts.statements += writeAll(rows, updates);
    rows = [];
    updates = [];
  };

  for (const [i, item] of queue.entries()) {
    const w = captureWindow(item.tf, item.detectedAtMs);
    if (!w) continue;
    const upd = (payload: Record<string, unknown>) => updates.push(queueUpdateSql(item.table, item.keyColumn, item.keyValue, payload));
    const already = stored.get(item.mint) ?? [];
    if (isWindowCovered(already, w)) {
      upd(candlesDoneUpdate(item.tf));
      counts.covered++;
      continue;
    }
    const cacheFile = join(CACHE_DIR, `${item.table}-${item.keyValue}-${item.tf}.json`);
    let candles: Candle[] | null = null;
    if (existsSync(cacheFile)) {
      candles = JSON.parse(readFileSync(cacheFile, 'utf8')) as Candle[];
      counts.cached++;
    }
    while (!candles) {
      const wait = lastCall + spacing - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      const h = await fetchCandleWindow(item.pairAddress, item.mint, candlePlan(w));
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
        upd(candlesFailureUpdate(item.tf, item.attempts, Date.now(), h.status === 'not_found' || h.status === 'invalid' ? h.status : 'error'));
        counts.failed++;
      }
      break;
    }
    if (candles) {
      const row = ohlcvRow({
        mint: item.mint,
        pool: item.pairAddress,
        tf: item.tf,
        candles,
        source: item.table,
        detectedAtMs: item.detectedAtMs,
        fetchedAtMs: Date.now(),
      });
      if (row) {
        rows.push(row);
        already.push({ tf: item.tf, detected_at: row.detected_at });
        stored.set(item.mint, already);
        counts.captured++;
      } else {
        counts.empty++;
      }
      upd(candlesDoneUpdate(item.tf));
    }
    if (rows.length >= 4 || updates.length >= 50) flush();
    if ((i + 1) % 25 === 0) log(`${i + 1}/${queue.length}`, JSON.stringify(counts), `spacing ${spacing} ms`);
  }
  flush();
  log(DRY_RUN ? 'done (dry run, nothing written)' : 'done', JSON.stringify(counts));
}

(SEED_DIR ? seed15m(SEED_DIR) : catchUp()).catch((e: unknown) => {
  console.error('candle-catchup failed:', (e instanceof Error ? e.message : String(e)).slice(0, 300));
  process.exit(1);
});
