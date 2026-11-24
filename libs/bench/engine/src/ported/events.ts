// Backtest events (feat/lab-v2, docs/contracts/lab-v2.md §2). SIMULATION ONLY. Pure: no I/O, no Date.now(), no zod.
//
// Chronological, INCREMENTAL replay of token_snapshots, one mint at a time (replayMint). One event per (preset, mint):
// the FIRST snapshot where the conditions become true. Only values known AT the snapshot are used (never future data).
// chore/slim-down: only the two « Jeune calme » / « Jeune frénésie » event presets are left (young_calm_ev /
// young_frenzy_ev); momentum, young_24h, young_3h, post_migration, narrative_leader and the exploratory presets were
// removed (their backtest_events rows are archived history, docs/ARCHIVE.md).
// - young_calm_ev / young_frenzy_ev (feat/young-calm): the « Jeune calme » / « Jeune frénésie » rules of presets.ts
//   (YOUNG_BASE_RULES + youngMomentumClass) on 'scan' snapshots, with the point-in-time columns buys_1h / sells_1h
//   (ratio (b + 1) / (s + 1)), liquidity_effective_usd and lp_locked_pct written by scan-tokens since young-calm:
//   ratio unknown → 'ratio_unknown', effective liquidity unknown → 'liquidity_eff_unknown' (excluded, never the
//   liquidity_usd fallback: not point-in-time-equivalent), LP unknown → accepted (live rule), known < 90 % → 'lp';
//   pair age from tokens.pair_created_at (a past fact);
//   - mint / freeze authority: a pump.fun mint (address ending in `pump` AND first dex seen pumpfun / pumpswap) whose
//     CURRENT value is « revoked » is revoked by construction at any instant (revocation is irreversible and the
//     pump.fun program creates its tokens revoked); otherwise the snapshot value; otherwise unknown → excluded;
//   - insiders: snapshot value, null accepted (as the live preset); top10_pct: snapshot value, must be known;
//   - change_1h: snapshot value, else derived from the snapshot of the same mint 50–70 min earlier (closest to
//     60 min), else unknown (condition false);
//   - roundtrip cost: filter applied only when known at the snapshot (fees = known value, else 3 % in backtest.ts);
//   - creator rug history and « Structure cassée » are not historised: not checked (look-ahead otherwise).
// The replay state (ReplayState) is plain JSON (stored in the database between calls).
import { pairAgeHours, YOUNG_BASE_RULES, youngLpOk, youngMomentumClass, youngRatio } from './presets';
import { isSolanaAddress } from './solana';

/** « Jeune calme » / « Jeune frénésie » event presets (feat/young-calm), youngCriteriaFailures. */
export type YoungEventPreset = 'young_calm_ev' | 'young_frenzy_ev';
export const YOUNG_EVENT_PRESETS: readonly YoungEventPreset[] = ['young_calm_ev', 'young_frenzy_ev'];
/** Every event preset of the live scanner (backtest-run). */
export type EventPreset = YoungEventPreset;
export const EVENT_PRESETS: readonly EventPreset[] = YOUNG_EVENT_PRESETS;
/** Presets decided per mint by replayMint (all of them since chore/slim-down). */
export type MintEventPreset = EventPreset;
export const MINT_EVENT_PRESETS: readonly MintEventPreset[] = EVENT_PRESETS;
/** Every preset with data-gap diagnostics. */
export type GapPreset = YoungEventPreset;
export const GAP_PRESETS: readonly GapPreset[] = YOUNG_EVENT_PRESETS;

export const parseEventPreset = (v: unknown): EventPreset | null =>
  typeof v === 'string' && (EVENT_PRESETS as readonly string[]).includes(v) ? (v as EventPreset) : null;

const MIN_MS = 60_000;

export const CHANGE_1H_FALLBACK = {
  /** Reference snapshot captured between t − maxAgo and t − minAgo (inclusive), closest to t − targetAgo. */
  minAgoMs: 50 * MIN_MS,
  maxAgoMs: 70 * MIN_MS,
  targetAgoMs: 60 * MIN_MS,
} as const;

/** History kept in the state: enough for the change_1h fallback (70 min). */
export const HISTORY_MS = 75 * MIN_MS;
const HISTORY_MAX = 400;

// ---------------------------------------------------------------------------------------------------------------
// Inputs

export interface EventSnapshot {
  id: number;
  capturedAtMs: number;
  source: 'scan' | 'tracking';
  priceUsd: number | null;
  marketCap: number | null;
  liquidityUsd: number | null;
  dexId: string | null;
  holderCount: number | null;
  /** Point-in-time columns (null for the snapshots written before lab-v2). */
  mintAuthorityDisabled: boolean | null;
  freezeAuthorityDisabled: boolean | null;
  /** PERCENT 0–100. */
  top10Pct: number | null;
  insidersDetected: boolean | null;
  /** PERCENT. */
  roundtripCostPct: number | null;
  /** PERCENT. */
  change1h: number | null;
  /** Point-in-time columns of feat/young-calm (null before it): DexScreener 1 h buys / sells, effective liquidity, LP %. */
  buys1h?: number | null;
  sells1h?: number | null;
  liquidityEffectiveUsd?: number | null;
  lpLockedPct?: number | null;
}

const num = (v: unknown): number | null => {
  const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && v.length <= 40 ? Number(v) : NaN;
  return Number.isFinite(x) ? x : null;
};
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : v === 't' || v === 'true' ? true : v === 'f' || v === 'false' ? false : null);
const dex = (v: unknown): string | null => (typeof v === 'string' && /^[a-z0-9_.-]{1,32}$/i.test(v) ? v.toLowerCase() : null);
const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

function timeMs(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== 'string' || v.length > 40) return null;
  if (/^\d{10,16}$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * A token_snapshots row → EventSnapshot, or null (invalid id / time). captured_at: ISO string or epoch ms. Missing
 * point-in-time columns (older rows, or a SELECT without them) are null. Out-of-range values are dropped (null).
 */
export function parseSnapshotRow(row: unknown): EventSnapshot | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  const id = num(r['id']);
  if (id === null || !Number.isSafeInteger(id) || id <= 0) return null;
  const at = timeMs(r['captured_at']);
  if (at === null) return null;
  const pos = (v: unknown, max = 1e15): number | null => {
    const x = num(v);
    return x !== null && x >= 0 && x < max ? x : null;
  };
  const top10 = num(r['top10_pct']);
  const rt = num(r['roundtrip_cost_pct']);
  const ch = num(r['change_1h']);
  const holders = num(r['holder_count']);
  const count = (v: unknown): number | null => {
    const x = num(v);
    return x !== null && Number.isSafeInteger(x) && x >= 0 && x <= 100_000_000 ? x : null;
  };
  const lp = num(r['lp_locked_pct']);
  return {
    id,
    capturedAtMs: at,
    source: r['source'] === 'tracking' ? 'tracking' : 'scan',
    priceUsd: pos(r['price_usd'], 1e12),
    marketCap: pos(r['market_cap']),
    liquidityUsd: pos(r['liquidity_usd']),
    dexId: dex(r['dex_id']),
    holderCount: holders !== null && Number.isSafeInteger(holders) && holders >= 0 ? holders : null,
    mintAuthorityDisabled: bool(r['mint_authority_disabled']),
    freezeAuthorityDisabled: bool(r['freeze_authority_disabled']),
    top10Pct: top10 !== null && top10 >= 0 && top10 <= 100 ? top10 : null,
    insidersDetected: bool(r['insiders_detected']),
    roundtripCostPct: rt !== null && rt >= 0 && rt <= 100 ? rt : null,
    change1h: ch !== null && ch > -100 && ch < 1e7 ? ch : null,
    buys1h: count(r['buys_1h']),
    sells1h: count(r['sells_1h']),
    liquidityEffectiveUsd: pos(r['liquidity_effective_usd']),
    lpLockedPct: lp !== null && lp >= 0 && lp <= 100 ? lp : null,
  };
}

/** Static facts of the token (public.tokens): none of them is a future observation. */
export interface TokenFacts {
  mint: string;
  /** tokens.pair_address (pool used for the candles). */
  pool: string | null;
  /** tokens.pair_created_at, epoch ms. */
  pairCreatedAtMs: number | null;
  /** tokens.narrative (derived from name / symbol, static): recorded on the event (GTA / other split). */
  narrative: string | null;
  /** CURRENT tokens.mint_authority_disabled / freeze_authority_disabled (pump.fun by-construction rule only). */
  mintAuthorityDisabled: boolean | null;
  freezeAuthorityDisabled: boolean | null;
  /** First dex the token was seen on; absent → the dex of the first replayed snapshot (kept in the state). */
  firstDexSeen?: string | null;
}

const NARRATIVE_RE = /^[A-Za-z0-9_ &.+-]{1,24}$/;
const cleanNarrative = (v: unknown): string | null => (typeof v === 'string' && NARRATIVE_RE.test(v) ? v : null);

// ---------------------------------------------------------------------------------------------------------------
// State

/** [snapshot id, captured_at ms, price, holder_count, dex]. */
export type HistoryEntry = [number, number, number | null, number | null, string | null];

export interface ReplayState {
  v: 1;
  /** Cursor: last snapshot replayed (captured_at ms, id); later snapshots only. */
  lastAtMs: number | null;
  lastId: number | null;
  /** Dex of the first replayed snapshot that had one (pump.fun rule when TokenFacts.firstDexSeen is absent). */
  firstDex: string | null;
  /** Last dex seen. */
  lastDex: string | null;
  /** Snapshots of the last HISTORY_MS (change_1h fallback). */
  hist: HistoryEntry[];
  /** Legacy fields of the removed post_migration preset: kept so the stored states stay readable, never updated. */
  migrationAtMs: number | null;
  migrationBy: 'pair_created_at' | 'snapshot_transition' | null;
  migrationDone: boolean;
  /** Per-mint presets already fired (one event per preset and mint). */
  fired: MintEventPreset[];
}

export const initialReplayState = (): ReplayState => ({
  v: 1,
  lastAtMs: null,
  lastId: null,
  firstDex: null,
  lastDex: null,
  hist: [],
  migrationAtMs: null,
  migrationBy: null,
  migrationDone: false,
  fired: [],
});

/**
 * Stored state (jsonb) → ReplayState, or null when absent / malformed (the caller then replays from scratch). Fired
 * presets that no longer exist (removed by chore/slim-down) are dropped, not rejected: the cursor is kept.
 */
export function parseReplayState(raw: unknown): ReplayState | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r['v'] !== 1) return null;
  const optNum = (v: unknown): number | null | undefined => (v === null ? null : finite(v as number) ? (v as number) : undefined);
  const lastAtMs = optNum(r['lastAtMs']);
  const lastId = optNum(r['lastId']);
  const migrationAtMs = optNum(r['migrationAtMs']);
  if (lastAtMs === undefined || lastId === undefined || migrationAtMs === undefined) return null;
  if (typeof r['migrationDone'] !== 'boolean' || !Array.isArray(r['hist']) || !Array.isArray(r['fired'])) return null;
  const optDex = (v: unknown): string | null | undefined => (v === null ? null : dex(v) ?? undefined);
  const firstDex = optDex(r['firstDex']);
  const lastDex = optDex(r['lastDex']);
  if (firstDex === undefined || lastDex === undefined) return null;
  const hist: HistoryEntry[] = [];
  for (const e of r['hist'].slice(-HISTORY_MAX)) {
    if (!Array.isArray(e) || e.length !== 5) return null;
    const [id, at, price, holders, d] = e as unknown[];
    if (!finite(id as number) || !finite(at as number)) return null;
    hist.push([
      id as number,
      at as number,
      finite(price as number) ? (price as number) : null,
      finite(holders as number) ? (holders as number) : null,
      dex(d),
    ]);
  }
  const fired: MintEventPreset[] = [];
  for (const p of r['fired']) {
    if (typeof p !== 'string' || p.length > 32) return null;
    if (!(MINT_EVENT_PRESETS as readonly unknown[]).includes(p)) continue;
    if (!fired.includes(p as MintEventPreset)) fired.push(p as MintEventPreset);
  }
  const migrationBy = r['migrationBy'] === 'pair_created_at' || r['migrationBy'] === 'snapshot_transition' ? r['migrationBy'] : null;
  if (r['migrationBy'] !== undefined && r['migrationBy'] !== null && migrationBy === null) return null;
  return { v: 1, lastAtMs, lastId, firstDex, lastDex, hist, migrationAtMs, migrationBy, migrationDone: r['migrationDone'], fired };
}

// ---------------------------------------------------------------------------------------------------------------
// Point-in-time values

/** pump.fun mint: address ending in `pump` AND first dex seen pumpfun or pumpswap. */
export const isPumpFunMint = (mint: string, firstDex: string | null | undefined): boolean =>
  typeof mint === 'string' && mint.endsWith('pump') && (firstDex === 'pumpfun' || firstDex === 'pumpswap');

export type KnownBy = 'snapshot' | 'pumpfun_construction' | 'derived';

/** Authority at the snapshot: revoked by construction (pump.fun + currently revoked), else the snapshot value. */
export function authorityAt(
  snapshotValue: boolean | null,
  currentValue: boolean | null,
  pumpFun: boolean,
): { value: boolean | null; by: KnownBy | null } {
  if (pumpFun && currentValue === true) return { value: true, by: 'pumpfun_construction' };
  if (typeof snapshotValue === 'boolean') return { value: snapshotValue, by: 'snapshot' };
  return { value: null, by: null };
}

/**
 * change_1h at time `atMs`: the snapshot value when known, else (price / reference − 1) × 100 with the reference = the
 * history entry captured 50–70 min earlier closest to 60 min (ties: the more recent), else null.
 */
export function change1hAt(
  snapshotValue: number | null,
  priceUsd: number | null,
  atMs: number,
  hist: readonly HistoryEntry[],
): { value: number | null; by: KnownBy | null } {
  if (finite(snapshotValue)) return { value: snapshotValue, by: 'snapshot' };
  if (!finite(priceUsd) || priceUsd <= 0) return { value: null, by: null };
  const r = CHANGE_1H_FALLBACK;
  let best: HistoryEntry | null = null;
  let bestD = Infinity;
  for (const e of hist) {
    const ago = atMs - e[1];
    if (ago < r.minAgoMs || ago > r.maxAgoMs || !(finite(e[2]) && e[2] > 0)) continue;
    const d = Math.abs(ago - r.targetAgoMs);
    if (d < bestD || (d === bestD && best !== null && e[1] > best[1])) {
      best = e;
      bestD = d;
    }
  }
  if (!best || best[2] === null) return { value: null, by: null };
  return { value: (priceUsd / best[2] - 1) * 100, by: 'derived' };
}

// ---------------------------------------------------------------------------------------------------------------
// Criteria

/** Missing data (the token cannot be judged on this condition at this instant). */
export type DataGap =
  | 'change_1h_unknown'
  | 'safety_unknown'
  | 'top10_unknown'
  | 'ratio_unknown'
  | 'liquidity_eff_unknown';
export const DATA_GAPS: readonly DataGap[] = [
  'change_1h_unknown',
  'safety_unknown',
  'top10_unknown',
  'ratio_unknown',
  'liquidity_eff_unknown',
];
export type CriteriaFailure =
  | 'dex'
  | 'liquidity'
  | 'age'
  | 'momentum'
  | 'safety'
  | 'top10'
  | 'roundtrip'
  | 'lp'
  | DataGap;

export interface PointInTime {
  marketCap: number | null;
  liquidityUsd: number | null;
  dexId: string | null;
  change1h: number | null;
  mintAuthorityDisabled: boolean | null;
  freezeAuthorityDisabled: boolean | null;
  insidersDetected: boolean | null;
  top10Pct: number | null;
  roundtripCostPct: number | null;
  pairAgeH: number | null;
}

/** Point-in-time values of a young-calm event preset (PointInTime + the feat/young-calm snapshot columns). */
export interface YoungPointInTime extends PointInTime {
  liquidityEffectiveUsd: number | null;
  buys1h: number | null;
  sells1h: number | null;
  lpLockedPct: number | null;
}

/**
 * Every failed condition of young_calm_ev / young_frenzy_ev, in this order: dex (pumpswap), age (< 24 h), effective
 * liquidity (unknown → 'liquidity_eff_unknown', < 30 k$ → 'liquidity'), momentum (ratio unknown → 'ratio_unknown',
 * change_1h unknown → 'change_1h_unknown', else youngMomentumClass ≠ calm / frenzy → 'momentum'), safety (lab-v2:
 * known not revoked or insiders = true → 'safety', unknown authority → 'safety_unknown'), top10 (unknown →
 * 'top10_unknown', ≥ 25 % → 'top10'), roundtrip (only when known, ≥ 5 % → 'roundtrip', lab-v2 rule), LP (known
 * < 90 % → 'lp'). [] = match.
 */
export function youngCriteriaFailures(preset: YoungEventPreset, p: YoungPointInTime): CriteriaFailure[] {
  const out: CriteriaFailure[] = [];
  const r = YOUNG_BASE_RULES;
  if (p.dexId !== r.dexId) out.push('dex');
  if (!(finite(p.pairAgeH) && p.pairAgeH >= 0 && p.pairAgeH < r.maxPairAgeH)) out.push('age');
  if (!finite(p.liquidityEffectiveUsd)) out.push('liquidity_eff_unknown');
  else if (!(p.liquidityEffectiveUsd >= r.minLiquidity)) out.push('liquidity');
  const ratio = youngRatio(p.buys1h, p.sells1h);
  if (ratio === null) out.push('ratio_unknown');
  if (!finite(p.change1h)) out.push('change_1h_unknown');
  if (ratio !== null && finite(p.change1h)) {
    const want = preset === 'young_calm_ev' ? 'calm' : 'frenzy';
    if (youngMomentumClass(p.change1h, ratio) !== want) out.push('momentum');
  }
  if (p.mintAuthorityDisabled === false || p.freezeAuthorityDisabled === false || p.insidersDetected === true) out.push('safety');
  else if (p.mintAuthorityDisabled !== true || p.freezeAuthorityDisabled !== true) out.push('safety_unknown');
  if (!finite(p.top10Pct)) out.push('top10_unknown');
  else if (!(p.top10Pct >= 0 && p.top10Pct < r.maxTop10Pct)) out.push('top10');
  if (finite(p.roundtripCostPct) && !(p.roundtripCostPct >= 0 && p.roundtripCostPct < r.maxRoundtripPct)) out.push('roundtrip');
  if (!youngLpOk(p.lpLockedPct)) out.push('lp');
  return out;
}

/** Every failure is a data gap (the market conditions hold, only missing data blocks): the « excluded » case. */
export const onlyDataGaps = (f: readonly CriteriaFailure[]): f is DataGap[] =>
  f.length > 0 && f.every((x) => (DATA_GAPS as readonly string[]).includes(x));

// ---------------------------------------------------------------------------------------------------------------
// Events

export type ConditionValue = string | number | boolean | null;

/** Insert shape of public.backtest_events (candle queue columns set by the database trigger). */
export interface BacktestEvent {
  preset: EventPreset;
  mint: string;
  pool: string | null;
  /** ISO, captured_at of the entry snapshot. */
  event_at: string;
  entry_snapshot_id: number;
  price_at_event: number;
  mc: number | null;
  liquidity: number | null;
  narrative: string | null;
  pair_age_h: number | null;
  roundtrip_known: boolean;
  /** PERCENT, null = unknown (the backtest charges 3 %). */
  roundtrip_pct: number | null;
  /** Values the decision used and how each was known (jsonb). */
  conditions: Record<string, ConditionValue>;
}

export interface ReplayResult {
  /** New events (each (preset, mint) at most once over the whole replay). */
  events: BacktestEvent[];
  state: ReplayState;
  /**
   * Per preset not fired: the data gaps of the FIRST snapshot (of this call) where the market conditions held but
   * data was missing (diagnostics).
   */
  gaps: Partial<Record<GapPreset, DataGap[]>>;
  /** Snapshots replayed in this call (after the cursor). */
  processed: number;
}

const round = (x: number | null, d = 6): number | null => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Replays the snapshots of ONE mint after the state's cursor (any order in, sorted by (captured_at, id); rows at or
 * before the cursor are skipped, so a call may safely overlap the previous one). Returns the new events and the new
 * state (JSON). Invalid mint → nothing, state unchanged.
 */
export function replayMint(
  facts: TokenFacts,
  snapshots: readonly EventSnapshot[],
  previous: ReplayState | null,
): ReplayResult {
  const prev = previous ?? initialReplayState();
  const state: ReplayState = { ...prev, hist: prev.hist.map((e) => [...e] as HistoryEntry), fired: [...prev.fired] };
  const out: ReplayResult = { events: [], state, gaps: {}, processed: 0 };
  if (!facts || !isSolanaAddress(facts.mint)) return out;
  const mint = facts.mint;
  const pool = isSolanaAddress(facts.pool) ? facts.pool : null;
  const narrative = cleanNarrative(facts.narrative);
  const after = (s: EventSnapshot) =>
    state.lastAtMs === null || s.capturedAtMs > state.lastAtMs ||
    (s.capturedAtMs === state.lastAtMs && state.lastId !== null && s.id > state.lastId);
  const rows = (Array.isArray(snapshots) ? snapshots : [])
    .filter((s) => s && Number.isFinite(s.capturedAtMs) && Number.isSafeInteger(s.id))
    .slice()
    .sort((a, b) => a.capturedAtMs - b.capturedAtMs || a.id - b.id);

  for (const s of rows) {
    if (!after(s)) continue;
    out.processed++;
    const t = s.capturedAtMs;
    if (state.firstDex === null && s.dexId !== null) state.firstDex = s.dexId;
    const firstDex = facts.firstDexSeen !== undefined && facts.firstDexSeen !== null ? dex(facts.firstDexSeen) : state.firstDex;
    const hist = state.hist;

    if (s.source === 'scan') {
      const pumpFun = isPumpFunMint(mint, firstDex);
      const ma = authorityAt(s.mintAuthorityDisabled, facts.mintAuthorityDisabled, pumpFun);
      const fa = authorityAt(s.freezeAuthorityDisabled, facts.freezeAuthorityDisabled, pumpFun);
      const ch = change1hAt(s.change1h, s.priceUsd, t, hist);
      const ageH = pairAgeHours(facts.pairCreatedAtMs, t);
      const pit: PointInTime = {
        marketCap: s.marketCap,
        liquidityUsd: s.liquidityUsd,
        dexId: s.dexId,
        change1h: ch.value,
        mintAuthorityDisabled: ma.value,
        freezeAuthorityDisabled: fa.value,
        insidersDetected: s.insidersDetected,
        top10Pct: s.top10Pct,
        roundtripCostPct: s.roundtripCostPct,
        pairAgeH: ageH,
      };
      const ypit: YoungPointInTime = {
        ...pit,
        liquidityEffectiveUsd: s.liquidityEffectiveUsd ?? null,
        buys1h: s.buys1h ?? null,
        sells1h: s.sells1h ?? null,
        lpLockedPct: s.lpLockedPct ?? null,
      };
      for (const preset of YOUNG_EVENT_PRESETS) {
        if (state.fired.includes(preset)) continue;
        const failed = youngCriteriaFailures(preset, ypit);
        if (failed.length > 0) {
          if (out.gaps[preset] === undefined && onlyDataGaps(failed)) out.gaps[preset] = failed;
          continue;
        }
        if (!(finite(s.priceUsd) && s.priceUsd > 0)) continue;
        state.fired.push(preset);
        delete out.gaps[preset];
        out.events.push({
          preset,
          mint,
          pool,
          event_at: iso(t),
          entry_snapshot_id: s.id,
          price_at_event: s.priceUsd,
          mc: s.marketCap,
          liquidity: ypit.liquidityEffectiveUsd,
          narrative,
          pair_age_h: round(ageH, 4),
          roundtrip_known: s.roundtripCostPct !== null,
          roundtrip_pct: s.roundtripCostPct,
          conditions: {
            dex_id: s.dexId,
            market_cap: s.marketCap,
            liquidity_effective_usd: ypit.liquidityEffectiveUsd,
            change_1h: round(ch.value, 4),
            change_1h_by: ch.by,
            buys_1h: ypit.buys1h,
            sells_1h: ypit.sells1h,
            buy_sell_ratio_1h: round(youngRatio(ypit.buys1h, ypit.sells1h), 4),
            mint_authority_by: ma.by,
            freeze_authority_by: fa.by,
            insiders_detected: s.insidersDetected,
            top10_pct: s.top10Pct,
            roundtrip_pct: s.roundtripCostPct,
            lp_locked_pct: ypit.lpLockedPct,
            liquidity_source: 'snapshot_liquidity_effective_usd',
            not_checked: 'creator_rug_history',
          },
        });
      }
    }

    // History + cursor.
    hist.push([s.id, t, s.priceUsd, s.holderCount, s.dexId]);
    while (hist.length > 0 && (hist[0]![1] < t - HISTORY_MS || hist.length > HISTORY_MAX)) hist.shift();
    if (s.dexId !== null) state.lastDex = s.dexId;
    state.lastAtMs = t;
    state.lastId = s.id;
  }
  return out;
}
