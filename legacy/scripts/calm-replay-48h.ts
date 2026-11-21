// READ-ONLY replay of the phase-2 « Jeune calme » rules (feat/calm-sl-test) over the last hours, scan by scan, on the
// point-in-time snapshot columns: alerts (Structure cassée included, one alert per calm position episode, caps 4/h –
// 30/day), books calm_sl30 / calm_sl40 / frenzy_sl30 and frenzy matches, per UTC day. Logic: ./calm-replay-48h-lib.ts
// (production predicates and alert guard). Data through the Supabase CLI `db query --remote --read-only`: no key is read
// or printed, nothing is written to the database.
//
// Run (repo root): node --experimental-strip-types --no-warnings scripts/calm-replay-48h.ts [--hours 48] [--out file.json]
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { argOf, dbQueryArgs, parseCliOutput, supabaseCommand } from './strategy-lab-lib.ts';
import { type CandidateRow, parseCandidate, parsePricePoint, type PricePoint, replay } from './calm-replay-48h-lib.ts';

const argv = process.argv.slice(2);
const HOURS = Math.min(168, Math.max(1, Number(argOf(argv, '--hours') ?? '48') || 48));
const OUT = argOf(argv, '--out');

const cli = supabaseCommand((cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }));
function query(sql: string): unknown[] {
  const res = spawnSync(cli.cmd, dbQueryArgs(cli, sql, false), { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return parseCliOutput(res.status, res.stdout);
}

const toMs = Date.now();
const fromMs = toMs - HOURS * 3_600_000;
const from = `to_timestamp(${Math.floor(fromMs / 1000)})`;

// Young PumpSwap scan snapshots of the window (pair < 24 h at the snapshot, tokens.pair_created_at).
const CANDIDATES = `
select s.mint, (extract(epoch from s.captured_at) * 1000)::bigint as at, s.price_usd::float8 as price,
       s.market_cap::float8 as mc, s.liquidity_usd::float8 as liq, s.liquidity_effective_usd::float8 as liq_eff,
       s.volume_1h::float8 as vol1h, s.change_1h::float8 as c1h, s.buys_1h as buys, s.sells_1h as sells,
       s.mint_authority_disabled as mad, s.freeze_authority_disabled as fad, s.top10_pct::float8 as top10,
       s.insiders_detected as ins, s.roundtrip_cost_pct::float8 as rt, s.lp_locked_pct::float8 as lp, s.dex_id as dex,
       (extract(epoch from t.pair_created_at) * 1000)::bigint as created_ms, t.creator_rug_history as crh
  from public.token_snapshots s
  join public.tokens t on t.mint = s.mint
 where s.source = 'scan' and s.captured_at >= ${from} and s.dex_id = 'pumpswap'
   and t.pair_created_at is not null
   and s.captured_at < t.pair_created_at + interval '24 hours'
   and s.captured_at >= t.pair_created_at - interval '5 minutes'`;

// Every price of those mints from 24 h before the window (structure reconstruction) to now (position follow-up).
const PRICES = `
select s.mint, (extract(epoch from s.captured_at) * 1000)::bigint as at, s.price_usd::float8 as price, s.source
  from public.token_snapshots s
 where s.captured_at >= ${from} - interval '24 hours'
   and s.mint in (
     select distinct s2.mint from public.token_snapshots s2 join public.tokens t2 on t2.mint = s2.mint
      where s2.source = 'scan' and s2.captured_at >= ${from} and s2.dex_id = 'pumpswap' and t2.pair_created_at is not null
        and s2.captured_at < t2.pair_created_at + interval '24 hours'
        and s2.captured_at >= t2.pair_created_at - interval '5 minutes')`;

const candidates: CandidateRow[] = [];
let invalid = 0;
for (const r of query(CANDIDATES)) {
  const c = parseCandidate(r);
  if (c) candidates.push(c);
  else invalid++;
}
const prices: PricePoint[] = [];
for (const r of query(PRICES)) {
  const p = parsePricePoint(r);
  if (p) prices.push(p);
  else invalid++;
}

const withStructure = replay(candidates, prices, { fromMs, toMs, structure: true });
const withoutStructure = replay(candidates, prices, { fromMs, toMs, structure: false });

const report = {
  generated_at: new Date(toMs).toISOString(),
  window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), hours: HOURS, days: 'UTC' },
  input: { candidate_snapshots: candidates.length, price_points: prices.length, invalid_rows: invalid },
  rules:
    'Jeune calme phase 2: pair < 24 h, pumpswap, change1h 0–100 %, ratio (b+1)/(s+1) 0.8–1.3, effective liquidity ≥ 30 k$ ' +
    '(DexScreener liquidity when unknown), round trip < 5 % (unknown = refused), mint/freeze disabled, top10 < 25 %, no ' +
    'insiders / creator rug, LP ≥ 90 % when known, no Structure cassée. Alerts: persistence 5 min, one alert per calm ' +
    'position episode (12 h guard when no position), caps 4/h – 30/24 h, 3 singles + 1 grouped per scan. Books: every ' +
    'match (≤ 10 per preset per scan), entry at the next snapshot, TP ×2, SL 30 / 40 / 30 %, no stacking, 12 h cooldown ' +
    'per book, caps 50 active / 200 per 24 h. Frenzy = same base filters, change1h > 150 % or ratio > 1.3, never alerted.',
  with_structure: withStructure,
  without_structure_rule: { totals: withoutStructure.totals, per_day: withoutStructure.per_day },
  notes: [
    'Structure cassée is not historised (tokens.flags = current state only): it is RECONSTRUCTED from the snapshot price ' +
      'path with the production structureBroken (5 min / 1 h = stored change_1h / 6 h / 24 h ago; pair younger than the ' +
      'window → first price seen after the pair creation). coverage.structure_full = snapshots where every point was found.',
    'buys_1h / sells_1h / liquidity_effective_usd snapshot columns exist only since 2026-11-20 17:08 UTC: before that the ' +
      'ratio is unknown and the live rule refuses (coverage.ratio_known).',
    'creator_rug_history is not historised: current tokens value (look-ahead). Quiet hours ignored (one user, alerts on).',
    'Positions: observed snapshot prices only (no fees, no slippage, no quote impact): P&L approximate.',
  ],
};
const json = JSON.stringify(report, null, 2);
if (OUT) writeFileSync(OUT, json + '\n');

const t = withStructure.totals;
console.log(`Fenêtre ${HOURS} h — ${candidates.length} snapshots jeunes PumpSwap, ${prices.length} prix`);
for (const [d, s] of Object.entries(withStructure.per_day)) {
  console.log(
    `${d} · calme : ${s.calm.alerts_single} alertes (+${s.calm.alerts_grouped} groupées), ${s.calm.matched_tokens} tokens · ` +
      `frénésie : ${s.frenzy.matched_tokens} tokens (${s.frenzy.match_scans} scans) · ratio connu ${s.coverage.ratio_known}/${s.coverage.young_pumpswap_scan_snapshots}`,
  );
}
console.log(`Total calme : ${t.calm.alerts_single} alertes individuelles, ${t.calm.alerts_grouped} groupées, ${t.calm.alerted_tokens} tokens alertés, ${t.calm.matched_tokens} tokens`);
console.log(`Sans la règle Structure cassée : ${withoutStructure.totals.calm.alerts_single} alertes, ${withoutStructure.totals.calm.matched_tokens} tokens`);
if (OUT) console.log(`JSON écrit : ${OUT}`);
