// READ-ONLY replay of the « Jeune calme » / « Jeune frénésie » presets AT DETECTION over the last 48 h (feat/young-calm).
// Rules: the production code (backtest.ts youngDetectionFailures + presets.ts youngMomentumClass) through
// ./young-calm-replay-lib.ts. Data through the Supabase CLI `supabase db query --remote --read-only` (strategy-lab-lib
// supabaseCommand): no key is read or printed, nothing is written to the database. See the report notes for what is
// not historised (authorities, top 10: current public.tokens values = look-ahead bias).
//
// Run (repo root): node --experimental-strip-types --no-warnings scripts/young-calm-replay.ts [--hours 48] [--out file.json]
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { argOf, dbQueryArgs, parseCliOutput, supabaseCommand } from './strategy-lab-lib.ts';
import { buildReplayReport, type ReplayRow, replayRow } from './young-calm-replay-lib.ts';

const argv = process.argv.slice(2);
const HOURS = Math.min(168, Math.max(1, Number(argOf(argv, '--hours') ?? '48') || 48));
const OUT = argOf(argv, '--out');

const cli = supabaseCommand((cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }));
function query(sql: string): unknown[] {
  const res = spawnSync(cli.cmd, dbQueryArgs(cli, sql, false), { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return parseCliOutput(res.status, res.stdout);
}

const toMs = Date.now();
const fromMs = toMs - HOURS * 3_600_000;

const SQL = `
select o.mint, o.detected_at, o.entry_mc::float8 as entry_mc, o.entry_liq_eff::float8 as entry_liq_eff, o.entry_zone,
       o.entry_dex_id, o.entry_roundtrip_pct::float8 as entry_roundtrip_pct, o.features,
       o.x2_before_sl30 as x2, o.sl30_before_x2 as sl,
       t.narrative, (extract(epoch from t.pair_created_at) * 1000)::bigint as created_ms,
       t.mint_authority_disabled as mad, t.freeze_authority_disabled as fad, t.top10_pct::float8 as top10,
       t.insiders_detected as ins, t.creator_rug_history as crh, t.lp_locked_pct::float8 as lp_now,
       t.roundtrip_cost_pct::float8 as rt_now
  from public.signal_outcomes o
  left join public.tokens t on t.mint = o.mint
 where o.detected_at >= to_timestamp(${Math.floor(fromMs / 1000)})
 order by o.detected_at`;

const rows: ReplayRow[] = [];
let invalid = 0;
for (const r of query(SQL)) {
  const p = replayRow(r);
  if (p) rows.push(p);
  else invalid++;
}
const report = { ...buildReplayReport(rows, fromMs, toMs), invalid_rows: invalid, generated_at: new Date(toMs).toISOString() };
const json = JSON.stringify(report, null, 2);
if (OUT) writeFileSync(OUT, json + '\n');

const c = report.young_calm;
const f = report.young_frenzy;
console.log(`Détections ${report.detections} (dont < 24 h : ${report.young}), fenêtre ${report.window.hours} h`);
console.log('Jeune calme sans sécurité  :', JSON.stringify(c.sans_securite.per_day), 'total', c.sans_securite.total);
console.log('Jeune calme sécurité (biais):', JSON.stringify(c.avec_securite_connue_biais.per_day), 'total', c.avec_securite_connue_biais.total);
console.log('Jeune frénésie sans sécurité:', JSON.stringify(f.sans_securite.per_day), 'total', f.sans_securite.total);
console.log('Exclusions (< 24 h)        :', JSON.stringify(report.exclusions_young));
if (OUT) console.log(`JSON écrit : ${OUT}`);
