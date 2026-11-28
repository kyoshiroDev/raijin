// READ-ONLY offline study (feat/wallet-study): do « smart wallets » among the early buyers (rank 1–50) of past
// detections predict the outcome of later detections? Study only — no alert, no trading, nothing written to the database.
// Protocol (pre-registered) and computations: supabase/functions/_shared/wallet-study.ts. Data through the Supabase CLI
// `supabase db query --remote --read-only` (argument list, no shell); no key is read or printed.
//
// Run (repo root): node --experimental-strip-types --no-warnings scripts/wallet-study.ts [--out report.json] [--no-candles]
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { argOf, chunks, dbQueryArgs, parseCliOutput, supabaseCommand } from './strategy-lab-lib.ts';
import {
  BUYERS_SQL,
  buildStudyInput,
  candlesSql,
  mintsWithBuyers,
  OUTCOMES_SQL,
  parseBuyers,
  parseOutcomes,
  peakMap,
  YOUNG_CALM_SQL,
  youngCalmMap,
} from './wallet-study-lib.ts';
import { runWalletStudy } from '../supabase/functions/_shared/wallet-study.ts';

const argv = process.argv.slice(2);
const OUT = argOf(argv, '--out');
const NO_CANDLES = argv.includes('--no-candles');

const cli = supabaseCommand((cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }));
function query(sql: string): unknown[] {
  const res = spawnSync(cli.cmd, dbQueryArgs(cli, sql, false), { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return parseCliOutput(res.status, res.stdout);
}

const outcomes = parseOutcomes(query(OUTCOMES_SQL));
const buyers = parseBuyers(query(BUYERS_SQL));
const youngCalm = youngCalmMap(query(YOUNG_CALM_SQL));
const peaks = new Map<string, number>();
if (!NO_CANDLES) {
  for (const batch of chunks(mintsWithBuyers(outcomes.rows, buyers.rows), 100)) {
    const sql = candlesSql(batch);
    if (sql) for (const [m, t] of peakMap(query(sql))) peaks.set(m, t);
  }
}

const study = runWalletStudy(buildStudyInput(outcomes.rows, buyers.rows, youngCalm, peaks));
const report = {
  ...study,
  input: {
    outcome_rows_invalid: outcomes.invalid,
    buyer_rows: buyers.rows.length,
    buyer_rows_invalid: buyers.invalid,
    young_calm_mints: youngCalm.size,
    candle_peaks: peaks.size,
    candles_loaded: !NO_CANDLES,
  },
  disclaimer: "Étude hors ligne : aide à la décision, pas une prédiction. La plupart des memecoins finissent à zéro.",
};
const json = JSON.stringify(report, null, 2);
if (OUT) writeFileSync(OUT, json + '\n');
else console.log(json);

const all = study.b_table.all;
console.error(`Tokens A ${study.n_tokens.a} / B ${study.n_tokens.b} (jeunes B ${study.n_tokens.b_young}), smart wallets ${study.wallets.n_smart}`);
console.error(
  `B ≥1 smart : n=${all.smart_ge1.n} gain ${all.smart_ge1.mean_gain_pct} % IC ${JSON.stringify(all.smart_ge1.ci95)} | ` +
    `contrôle : n=${all.control.n} gain ${all.control.mean_gain_pct} % | écart IC ${JSON.stringify(all.diff_vs_control.ci95)}`,
);
console.error(`Verdict : ${study.verdict.label} — ${study.verdict.reason}`);
if (OUT) console.error(`JSON écrit : ${OUT}`);
