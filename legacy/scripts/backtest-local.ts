// Local run of the strategy-lab backtest (feat/strategy-lab, docs/contracts/strategy-lab.md §B2–B5): the SAME pure
// engine as the backtest-run worker (_shared/backtest.ts), on data read READ-ONLY through the Supabase CLI
// (`supabase db query --remote --read-only`: no key read nor printed). Writes the report JSON to --out.
//
// Run (repo root, after the ohlcv_candles migration and some captured / seeded candles):
//   node --experimental-strip-types scripts/backtest-local.ts --out <file.json> [--results <file.json>] [--bootstrap-all]
//   --results       also writes every backtest_results-shaped row (1 440 variants × 3 narratives × 2 splits)
//   --bootstrap-all bootstrap CI on every test cell (slow), not only on the retained variants
// CLI: `supabase` when on PATH, else `npx supabase`.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import {
  aggregateRun,
  buildReport,
  chronoCutoff,
  dataVersion,
  detectionFromRow,
  type DetectionInput,
  narrativeGroup,
  presetFlags,
  simulateRows,
  splitOf,
  type TradeRecord,
} from '../supabase/functions/_shared/backtest.ts';
import type { CandleTf } from '../supabase/functions/_shared/candles.ts';
import {
  argOf,
  BACKTEST_DETECTIONS_SQL,
  candlesForMintsSql,
  chunks,
  dbQueryArgs,
  detectionSource,
  parseCliOutput,
  supabaseCommand,
} from './strategy-lab-lib.ts';

const args = process.argv.slice(2);
const OUT = argOf(args, '--out');
const RESULTS = argOf(args, '--results');
const BOOTSTRAP_ALL = args.includes('--bootstrap-all');
const log = (...m: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...m);

const CLI = supabaseCommand((cmd, a) => spawnSync(cmd, a, { encoding: 'utf8', timeout: 30_000 }));
const readOnly = (sql: string): unknown[] => {
  const res = spawnSync(CLI.cmd, dbQueryArgs(CLI, sql, false), { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return parseCliOutput(res.status, res.stdout);
};

function main(): void {
  if (!OUT) throw new Error('usage: backtest-local.ts --out <file.json> [--results <file.json>] [--bootstrap-all]');
  const dets: DetectionInput[] = [];
  for (const r of readOnly(BACKTEST_DETECTIONS_SQL)) {
    const s = detectionSource(r);
    const d = s ? detectionFromRow(s.source, s.row) : null;
    if (d) dets.push(d);
  }
  log(`detections with candles: ${dets.length}`);

  const byMint = new Map<string, unknown[]>();
  const mints = [...new Set(dets.map((d) => d.mint))];
  for (const batch of chunks(mints, 40)) {
    for (const row of readOnly(candlesForMintsSql(batch))) {
      const m = (row as Record<string, unknown>).mint;
      if (typeof m !== 'string') continue;
      const list = byMint.get(m) ?? [];
      list.push(row);
      byMint.set(m, list);
    }
  }

  const sims = dets.map((d) => ({ d, sim: simulateRows(byMint.get(d.mint) ?? [], d.detectedAtMs, d.roundtripPct) }));
  const dv = dataVersion(sims.map(({ d, sim }) => ({ detectedAtMs: d.detectedAtMs, finest: sim.finest as CandleTf | null })));
  const cutoff = chronoCutoff(dets.map((d) => d.detectedAtMs));
  if (cutoff === null) throw new Error('not enough detections for a train / test split');
  const trades: TradeRecord[] = sims
    .filter(({ sim }) => sim.traded)
    .map(({ d, sim }) => ({
      source: d.source,
      mint: d.mint,
      detectedAtMs: d.detectedAtMs,
      split: splitOf(d.detectedAtMs, cutoff),
      presetFlags: presetFlags(d),
      narrative: narrativeGroup(d.narrative),
      returns: sim.returns,
      openAtEnd: sim.openAtEnd,
    }));
  log(`trades: ${trades.length}, cutoff ${new Date(cutoff).toISOString()}, resolutions ${JSON.stringify(dv.resolutions)}`);

  const t = performance.now();
  const results = aggregateRun(trades, { bootstrapAll: BOOTSTRAP_ALL });
  log(`aggregated ${results.length} rows in ${Math.round(performance.now() - t)} ms`);
  const report = buildReport(results, dv);
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  if (RESULTS) writeFileSync(RESULTS, JSON.stringify(results));
  log(`retained ${report.retained}, robust ${report.robust}. ${report.warning}`);
}

try {
  main();
} catch (e: unknown) {
  console.error('backtest-local failed:', (e instanceof Error ? e.message : String(e)).slice(0, 300));
  process.exit(1);
}
