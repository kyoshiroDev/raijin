// Strategy lab: pure backtest engine (feat/strategy-lab, docs/contracts/strategy-lab.md §B2–B5). SIMULATION ONLY.
// No I/O, no Date.now(), no zod: the backtest-run worker and scripts/backtest-local.ts run the same code.
//
// Pipeline:
//   1. per detection / event: ohlcv_candles rows → mergePath (candles.ts, finest resolution at each instant) →
//      simulateDetection(path, detectedAtMs, roundtripPct): the 6 combos of the grid (YOUNG_GRID) in ONE call, written
//      at their index of the 384-slot storage layout (the other slots stay NaN = not simulated), net returns in % of
//      the stake;
//   2. tradeRow / parseTradeRow: the backtest_trades row (returns real[384], open flags as a hex bitset — the layout
//      and its CHECKs are unchanged since feat/strategy-lab, so the archived runs stay readable);
//   3. chronoCutoff: global chronological 70 / 30 split by detected_at (same cutoff for every preset);
//   4. aggregatePreset(trades, preset): metrics per distinct variant × narrative × split, retained / robust rules,
//      bootstrap CI (seeded PRNG) on the TEST part. Can run one preset per worker call.
//
// Trade rules (B2), deliberately pessimistic:
// - entry = CLOSE of the first candle whose open ≥ detection + delay (0 / 2 min); no such candle → no trade;
// - exit all_x2 (sell everything at ×2), stop −20 / −30 / −40 %, no breakeven, no time exit (chore/slim-down);
// - candles after the entry candle are replayed in order; within a candle the stop is checked FIRST (a candle that
//   reaches both the TP and the stop counts as stopped), stop filled at min(stop level, candle close), TP filled at
//   the TP level;
// - end of data with the position open: sold at the last close, flagged open_at_end;
// - costs: entry_roundtrip_pct of the detection (3 % when unknown, clamped to [0, 100]) charged once on the stake,
//   + 0.0002 SOL per transaction (1 buy + 1 sell) on a 0.1 SOL stake; token-account rent is returned (0).
import { type CandlePath, type CandleSeries, decodeOhlcvRow, firstAtOrAfter, mergePath, type CandleTf } from './candles';
import { NETWORK_FEE_PER_TX_SOL } from './paper';
import { YOUNG_BASE_RULES, type YoungMomentum, youngLpOk, youngMomentumClass } from './presets';

// ---------------------------------------------------------------------------------------------------------------
// Grid (B3)
//
// STORAGE LAYOUT (unchanged, backtest_trades.returns real[384] CHECK): 4 exits × 4 stops × 2 breakeven × 4 time exits
// × 3 delays. Only the 6 combos of YOUNG_GRID are simulated and aggregated since chore/slim-down; the other values of
// the layout describe the archived runs.

export type BacktestExit = 'all_x2' | 'half_x2_rest_x3' | 'thirds_x2_x3_x4' | 'all_x1_5';
export const EXITS: readonly BacktestExit[] = ['all_x2', 'half_x2_rest_x3', 'thirds_x2_x3_x4', 'all_x1_5'];
export const SL_PCTS: readonly number[] = [20, 30, 40, 50];
export const BREAKEVENS: readonly boolean[] = [false, true];
/** Time exit after the detection, hours; null = none. */
export const TIME_EXITS_H: readonly (number | null)[] = [null, 1, 6, 24];
export const DELAYS_MIN: readonly number[] = [0, 2, 5];

/**
 * Presets of a run (chore/slim-down: the Laboratoire keeps « Jeune calme » / « Jeune frénésie » only):
 *   young_calm / young_frenzy       DETECTION mode (values at detection of the scan detections, youngDetectionFailures);
 *   young_calm_ev / young_frenzy_ev EVENT mode (events.ts, point-in-time snapshot columns, entry on 1-minute candles).
 * Each on YOUNG_GRID (6 variants), so 24 variants per run. The former presets (all, mc_300k_1m, momentum, young_24h,
 * young_3h, post_migration, narrative_leader and the exploratory ones) are archived: their backtest_results rows stay
 * readable, no run produces them any more.
 */
export type YoungDetectionPreset = 'young_calm' | 'young_frenzy';
export type YoungEventPreset = 'young_calm_ev' | 'young_frenzy_ev';
export type YoungCalmPreset = YoungDetectionPreset | YoungEventPreset;
export type BacktestPreset = YoungCalmPreset;
export type BacktestMode = 'detection' | 'event';
export const YOUNG_DETECTION_PRESETS: readonly YoungDetectionPreset[] = ['young_calm', 'young_frenzy'];
export const YOUNG_EVENT_PRESETS: readonly YoungEventPreset[] = ['young_calm_ev', 'young_frenzy_ev'];
/** Every young-calm preset (detection then event). */
export const YOUNG_CALM_PRESETS: readonly YoungCalmPreset[] = [...YOUNG_DETECTION_PRESETS, ...YOUNG_EVENT_PRESETS];
/** Every preset of a run, in simulation / aggregation order. */
export const PRESETS: readonly BacktestPreset[] = YOUNG_CALM_PRESETS;
export const isYoungCalmPreset = (v: unknown): v is YoungCalmPreset =>
  typeof v === 'string' && (YOUNG_CALM_PRESETS as readonly string[]).includes(v);
export const PRESET_MODE: Readonly<Record<BacktestPreset, BacktestMode>> = {
  young_calm: 'detection',
  young_frenzy: 'detection',
  young_calm_ev: 'event',
  young_frenzy_ev: 'event',
};
export const PRESET_LABELS: Readonly<Record<BacktestPreset, string>> = {
  young_calm: 'Jeune calme (détection)',
  young_frenzy: 'Jeune frénésie (détection)',
  young_calm_ev: 'Jeune calme (événement)',
  young_frenzy_ev: 'Jeune frénésie (événement)',
};
/**
 * preset_flags bit of each preset (backtest_trades CHECK unchanged): a detection row carries DETECTION_ROW_BIT (1, the
 * former 'all' bit, required by the CHECK: odd detection bitsets) plus young_calm 1024 / young_frenzy 2048; an event
 * row carries exactly ONE event bit (young_calm_ev 4096 / young_frenzy_ev 8192).
 */
export const DETECTION_ROW_BIT = 1;
export const PRESET_BIT: Readonly<Record<BacktestPreset, number>> = {
  young_calm: 1024,
  young_frenzy: 2048,
  young_calm_ev: 4096,
  young_frenzy_ev: 8192,
};
export const PRESET_FLAGS_MAX = 16383;

export type Narrative = 'all' | 'gta' | 'other';
export const NARRATIVES: readonly Narrative[] = ['all', 'gta', 'other'];
export type Split = 'train' | 'test';

/** Legs of each exit: sizes (fractions, sum 1) and TP multiples of the entry, ascending. */
export const EXIT_LEGS: Readonly<Record<BacktestExit, { sizes: readonly number[]; mults: readonly number[] }>> = {
  all_x2: { sizes: [1], mults: [2] },
  half_x2_rest_x3: { sizes: [0.5, 0.5], mults: [2, 3] },
  thirds_x2_x3_x4: { sizes: [0.33, 0.33, 0.34], mults: [2, 3, 4] },
  all_x1_5: { sizes: [1], mults: [1.5] },
};
const singleLeg = (e: BacktestExit): boolean => EXIT_LEGS[e].sizes.length === 1;

export interface Combo {
  index: number;
  exit: BacktestExit;
  slPct: number;
  breakeven: boolean;
  timeExitH: number | null;
  delayMin: number;
  /** false for breakeven = true on a single-leg exit (identical to breakeven = false). */
  distinct: boolean;
}

/** index = (((exit × 4 + sl) × 2 + breakeven) × 4 + time) × 3 + delay (positions in the grid arrays). */
export function comboIndex(exitI: number, slI: number, beI: number, timeI: number, delayI: number): number {
  return (((exitI * SL_PCTS.length + slI) * BREAKEVENS.length + beI) * TIME_EXITS_H.length + timeI) * DELAYS_MIN.length + delayI;
}

export const N_COMBOS = EXITS.length * SL_PCTS.length * BREAKEVENS.length * TIME_EXITS_H.length * DELAYS_MIN.length; // 384

export const COMBOS: readonly Combo[] = (() => {
  const out: Combo[] = [];
  EXITS.forEach((exit, e) =>
    SL_PCTS.forEach((slPct, s) =>
      BREAKEVENS.forEach((breakeven, b) =>
        TIME_EXITS_H.forEach((timeExitH, t) =>
          DELAYS_MIN.forEach((delayMin, d) => {
            const index = comboIndex(e, s, b, t, d);
            out[index] = { index, exit, slPct, breakeven, timeExitH, delayMin, distinct: !(breakeven && singleLeg(exit)) };
          })
        )
      )
    )
  );
  return out;
})();

export const DISTINCT_COMBOS: readonly Combo[] = COMBOS.filter((c) => c.distinct);

/**
 * The grid of every preset (chore/slim-down): sell everything at ×2, stop −20 / −30 / −40 %, no breakeven, no time
 * exit, delays 0 / 2 min = 6 variants per preset.
 */
export const YOUNG_GRID = {
  exits: ['all_x2'] as readonly BacktestExit[],
  slPcts: [20, 30, 40] as readonly number[],
  breakevens: [false] as readonly boolean[],
  timeExitsH: [null] as readonly (number | null)[],
  delaysMin: [0, 2] as readonly number[],
} as const;
export const YOUNG_COMBOS: readonly Combo[] = DISTINCT_COMBOS.filter((c) =>
  YOUNG_GRID.exits.includes(c.exit) && YOUNG_GRID.slPcts.includes(c.slPct) && YOUNG_GRID.breakevens.includes(c.breakeven) &&
  YOUNG_GRID.timeExitsH.includes(c.timeExitH) && YOUNG_GRID.delaysMin.includes(c.delayMin)
);
const YOUNG_COMBO_SET: ReadonlySet<number> = new Set(YOUNG_COMBOS.map((c) => c.index));

/** The combo belongs to the grid (YOUNG_GRID, for every preset). */
export const comboInPresetGrid = (_preset: BacktestPreset, combo: Combo): boolean => combo.distinct && YOUNG_COMBO_SET.has(combo.index);

/** Combos aggregated for a preset: the 6 of YOUNG_GRID. */
export const presetCombos = (_preset: BacktestPreset): readonly Combo[] => YOUNG_COMBOS;

/** 4 presets × 6 combos = 24 variants announced, all distinct. combos / distinctCombos = the storage layout. */
export const GRID_COUNTS = {
  combos: N_COMBOS,
  distinctCombos: DISTINCT_COMBOS.length,
  variants: PRESETS.length * YOUNG_COMBOS.length,
  distinctVariants: PRESETS.length * YOUNG_COMBOS.length,
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Costs

export const DEFAULT_ROUNDTRIP_PCT = 3;
export const STAKE_SOL = 0.1;
export const TX_FEE_SOL = NETWORK_FEE_PER_TX_SOL; // 0.0002

/** entry_roundtrip_pct → percent charged: unknown / non-finite → 3, else clamped to [0, 100]. */
export function roundtripPct(v: unknown): number {
  const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(x) ? Math.min(100, Math.max(0, x)) : DEFAULT_ROUNDTRIP_PCT;
}

/** Net return in % of the stake from a gross return (FRACTION), the round trip (%) and the number of legs. */
export function netPct(grossFrac: number, rtPct: number, nLegs: number): number {
  return grossFrac * 100 - rtPct - ((1 + nLegs) * TX_FEE_SOL * 100) / STAKE_SOL;
}

/** SOL result of a trade of STAKE_SOL from its net percent. */
export const netSol = (pct: number): number => (pct / 100) * STAKE_SOL;

// ---------------------------------------------------------------------------------------------------------------
// Engine (B2)

/** The array itself, or [] for a non-array (keeps the element type: Array.isArray narrows readonly arrays to any[]). */
const arr = <T>(x: readonly T[] | null | undefined): readonly T[] => (Array.isArray(x) ? x : []);

/**
 * One candle pass of all_x2 (TP ×2, stop −slPct) from entry candle k: GROSS return (fraction of the stake) and the
 * open_at_end flag. Stop checked first in every candle.
 */
function runPass(path: CandlePath, k: number, entry: number, slPct: number): { gross: number; open: boolean } {
  const stop = entry * (1 - slPct / 100);
  const tp = entry * 2;
  for (let j = k + 1; j < path.n; j++) {
    if (path.l[j]! <= stop) return { gross: Math.min(stop, path.c[j]!) / entry - 1, open: false };
    if (path.h[j]! >= tp) return { gross: 1, open: false };
  }
  return { gross: path.c[path.n - 1]! / entry - 1, open: true };
}

export interface DetectionSim {
  /** Net return (% of the stake, fees included) per combo index; NaN = no trade (no entry candle). */
  returns: Float32Array;
  /** 1 = sold at the last close (open_at_end), per combo index. */
  openAtEnd: Uint8Array;
  /** Entry candle index per delay (DELAYS_MIN order), -1 = none. */
  entryIdx: Int32Array;
  /** Finest timeframe of the path. */
  finest: CandleTf | null;
  /** At least one delay produced a trade. */
  traded: boolean;
}

/** The 6 grid combos of one detection on its merged path (other layout slots NaN). roundtrip = entry_roundtrip_pct (null → 3 %). */
export function simulateDetection(path: CandlePath, detectedAtMs: number, roundtrip: unknown): DetectionSim {
  return simulatePath(path, detectedAtMs, roundtrip, null);
}

/**
 * Engine of simulateDetection / simulateEvent: entry candle per delay = first candle with open ≥ anchor + delay,
 * accepted only when `entryOk(k, delay index)` (null = always); time exits counted from the anchor.
 */
function simulatePath(path: CandlePath, detectedAtMs: number, roundtrip: unknown, entryOk: ((k: number, delayIdx: number) => boolean) | null): DetectionSim {
  const returns = new Float32Array(N_COMBOS).fill(Number.NaN);
  const openAtEnd = new Uint8Array(N_COMBOS);
  const entryIdx = new Int32Array(DELAYS_MIN.length).fill(-1);
  const sim: DetectionSim = { returns, openAtEnd, entryIdx, finest: path?.finest ?? null, traded: false };
  if (!path || path.n === 0 || !Number.isFinite(detectedAtMs)) return sim;
  const rt = roundtripPct(roundtrip);
  const detSec = detectedAtMs / 1000;
  DELAYS_MIN.forEach((delay, d) => {
    if (!YOUNG_GRID.delaysMin.includes(delay)) return;
    const k = firstAtOrAfter(path, detSec + delay * 60);
    if (k >= path.n) return;
    if (entryOk !== null && !entryOk(k, d)) return;
    const entry = path.c[k];
    if (!(entry! > 0)) return;
    entryIdx[d] = k;
    sim.traded = true;
    for (const combo of YOUNG_COMBOS) {
      if (combo.delayMin !== delay) continue;
      const pass = runPass(path, k, entry!, combo.slPct);
      returns[combo.index] = netPct(pass.gross, rt, 1);
      openAtEnd[combo.index] = pass.open ? 1 : 0;
    }
  });
  return sim;
}

export interface TradeResult {
  entryIdx: number;
  entryPrice: number;
  grossPct: number;
  netPct: number;
  netSol: number;
  openAtEnd: boolean;
}

/** One all_x2 trade on one path (same engine as simulateDetection, for tests and drill-downs). null = no trade. */
export function simulateTrade(
  path: CandlePath,
  detectedAtMs: number,
  roundtrip: unknown,
  strategy: { slPct: number; delayMin: number },
): TradeResult | null {
  if (!path || path.n === 0 || !Number.isFinite(detectedAtMs)) return null;
  if (!(strategy.slPct > 0 && strategy.slPct < 100)) return null;
  const detSec = detectedAtMs / 1000;
  const k = firstAtOrAfter(path, detSec + strategy.delayMin * 60);
  if (k >= path.n || !(path.c[k]! > 0)) return null;
  const pass = runPass(path, k, path.c[k]!, strategy.slPct);
  const net = netPct(pass.gross, roundtripPct(roundtrip), 1);
  return { entryIdx: k, entryPrice: path.c[k]!, grossPct: pass.gross * 100, netPct: net, netSol: netSol(net), openAtEnd: pass.open };
}

/** ohlcv_candles rows of a mint (any order, any timeframes) → merged path → simulateDetection. */
export function simulateRows(rows: readonly unknown[], detectedAtMs: number, roundtrip: unknown): DetectionSim {
  const series: CandleSeries[] = [];
  for (const r of arr(rows)) {
    const s = decodeOhlcvRow(r);
    if (s) series.push(s);
  }
  return simulateDetection(mergePath(series), detectedAtMs, roundtrip);
}

export interface EventSim extends DetectionSim {
  /** No delay had a 1-minute entry candle: the event is not simulated (« en attente de bougies »). */
  pending: boolean;
}

/**
 * The grid combos of one EVENT (lab-v2 §2): same engine as a detection, anchored at event_at, but the entry candle of
 * a delay must be a 1-MINUTE candle (the first candle with open ≥ event_at + delay, inside a 1-minute series whose
 * span [first open, last open + 60 s) contains event_at + delay). A delay without one gives no trade (NaN); no delay
 * with one → pending. After the entry the merged path (1m, then 5m / 15m beyond the 1-minute window) is replayed.
 */
export function simulateEvent(series: readonly CandleSeries[], eventAtMs: number, roundtrip: unknown): EventSim {
  const path = mergePath(series);
  const spans: Array<[number, number]> = [];
  for (const s of arr(series)) {
    if (s?.tf !== '1m' || !Array.isArray(s.candles) || s.candles.length === 0) continue;
    const c = s.candles;
    spans.push([c[0]![0], c[c.length - 1]![0] + 60]);
  }
  const startSec = eventAtMs / 1000;
  // Entry of delay d: a 1-minute candle of the same 1-minute span as event_at + delay.
  const entryOk = (k: number, d: number): boolean => {
    if (path.end[k]! - path.t[k]! !== 60) return false;
    const target = startSec + DELAYS_MIN[d]! * 60;
    return spans.some(([from, to]) => from <= target && target < to && path.t[k]! < to);
  };
  const sim = simulatePath(path, eventAtMs, roundtrip, entryOk);
  return { ...sim, pending: !sim.traded };
}

/** ohlcv_candles rows of a mint → simulateEvent. */
export function simulateEventRows(rows: readonly unknown[], eventAtMs: number, roundtrip: unknown): EventSim {
  const series: CandleSeries[] = [];
  for (const r of arr(rows)) {
    const s = decodeOhlcvRow(r);
    if (s) series.push(s);
  }
  return simulateEvent(series, eventAtMs, roundtrip);
}

// ---------------------------------------------------------------------------------------------------------------
// Detections and preset filters (values AT DETECTION)

export type DetectionSource = 'signal_outcomes' | 'preset_signals';

export interface DetectionInput {
  source: DetectionSource;
  /** mint for signal_outcomes, id for preset_signals (as text). */
  key: string;
  mint: string;
  detectedAtMs: number;
  entryMc: number | null;
  entryLiqEff: number | null;
  entryZone: string | null;
  entryDexId: string | null;
  /** PERCENT. */
  change1h: number | null;
  /** entry_roundtrip_pct (PERCENT), null = unknown (3 % charged). */
  roundtripPct: number | null;
  pairAgeH: number | null;
  /** 'GTA', 'AI'… at detection (preset_signals.narrative, else tokens.narrative); null = none. */
  narrative: string | null;
  /**
   * feat/young-calm, signal_outcomes only (features at detection; preset_signals → null): 1 h buy/sell ratio
   * (buys + 1) / (sells + 1), RugCheck LP locked PERCENT, insiders / creator rug history (true / false / unknown).
   */
  buySellRatio1h?: number | null;
  lpLockedPct?: number | null;
  insiders?: boolean | null;
  creatorRug?: boolean | null;
}

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const numOrNull = (v: unknown): number | null => {
  const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && v.length <= 40 ? Number(v) : NaN;
  return Number.isFinite(x) ? x : null;
};
const strOrNull = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

/**
 * A detection row → DetectionInput, or null (invalid mint / time / key).
 * signal_outcomes: { mint, detected_at, entry_mc, entry_liq_eff, entry_zone, entry_dex_id, entry_roundtrip_pct,
 *   features: { change_1h, log_age_h, roundtrip_cost_pct, buy_sell_ratio_1h?, lp_locked_pct?, rug_insiders?,
 *   rug_creator_bad? }, narrative (tokens.narrative) }. Age = expm1(log_age_h). The four optional features feed the
 *   young-calm detection presets (absent → unknown).
 * preset_signals: { id, mint, detected_at, entry_mc, entry_liq_eff, entry_zone, entry_dex_id, entry_change_1h,
 *   entry_roundtrip_pct, pair_age_h, narrative (coalesce(preset_signals.narrative, tokens.narrative)) }.
 */
export function detectionFromRow(source: DetectionSource, row: unknown): DetectionInput | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  if (typeof r['mint'] !== 'string' || !MINT_RE.test(r['mint'])) return null;
  if (typeof r['detected_at'] !== 'string' || r['detected_at'].length > 40) return null;
  const detectedAtMs = Date.parse(r['detected_at']);
  if (!Number.isFinite(detectedAtMs)) return null;
  const base = {
    mint: r['mint'],
    detectedAtMs,
    entryMc: numOrNull(r['entry_mc']),
    entryLiqEff: numOrNull(r['entry_liq_eff']),
    entryZone: strOrNull(r['entry_zone'], 16),
    entryDexId: strOrNull(r['entry_dex_id'], 32),
    narrative: strOrNull(r['narrative'], 24),
  };
  if (source === 'preset_signals') {
    const id = numOrNull(r['id']);
    if (id === null || !Number.isSafeInteger(id) || id <= 0) return null;
    return {
      ...base,
      source,
      key: String(id),
      change1h: numOrNull(r['entry_change_1h']),
      roundtripPct: numOrNull(r['entry_roundtrip_pct']),
      pairAgeH: numOrNull(r['pair_age_h']),
      buySellRatio1h: null,
      lpLockedPct: null,
      insiders: null,
      creatorRug: null,
    };
  }
  if (source !== 'signal_outcomes') return null;
  const f = typeof r['features'] === 'object' && r['features'] !== null ? (r['features'] as Record<string, unknown>) : {};
  const logAge = numOrNull(f['log_age_h']);
  const ratio = numOrNull(f['buy_sell_ratio_1h']);
  const lp = numOrNull(f['lp_locked_pct']);
  const flag01 = (v: unknown): boolean | null => {
    const x = numOrNull(v);
    return x === 1 ? true : x === 0 ? false : null;
  };
  return {
    ...base,
    source,
    key: r['mint'],
    change1h: numOrNull(f['change_1h']),
    roundtripPct: numOrNull(r['entry_roundtrip_pct']) ?? numOrNull(f['roundtrip_cost_pct']),
    pairAgeH: logAge !== null && logAge >= 0 ? Math.expm1(logAge) : null,
    buySellRatio1h: ratio !== null && ratio >= 0 ? ratio : null,
    lpLockedPct: lp !== null && lp >= 0 && lp <= 100 ? lp : null,
    insiders: flag01(f['rug_insiders']),
    creatorRug: flag01(f['rug_creator_bad']),
  };
}

/**
 * preset_flags of a detection row (values AT DETECTION): DETECTION_ROW_BIT, plus young_calm / young_frenzy when the
 * detection is a « Jeune calme » / « Jeune frénésie » candidate. A row with no young bit is not stored (no preset
 * would read it).
 */
/** A traded detection is stored only when it carries a young bit (no other preset reads detection rows). */
export const isStoredDetection = (d: DetectionInput): boolean => presetFlags(d) !== DETECTION_ROW_BIT;

export function presetFlags(d: DetectionInput): number {
  let flags = DETECTION_ROW_BIT;
  const young = youngDetectionClass(d);
  if (young === 'calm') flags |= PRESET_BIT.young_calm;
  if (young === 'frenzy') flags |= PRESET_BIT.young_frenzy;
  return flags;
}

/**
 * Why a detection is not a young-calm candidate (all failures, in this order). [] = base rules pass.
 * - 'age': pair age at detection unknown or ≥ 24 h; 'dex': entry_dex_id ≠ pumpswap;
 * - 'liquidity': entry_liq_eff unknown or < 30 k$; 'roundtrip': entry round trip KNOWN and ≥ 5 % (the round trip is
 *   measured by enrich-tokens AFTER the first scan detection: unknown at detection for ~100 % of signal_outcomes rows,
 *   so unknown is accepted here, like the lab-v2 event rule, and 3 % is charged);
 * - 'momentum_unknown': change_1h or the 1 h ratio unknown at detection (preset_signals rows: always);
 * - 'rug': insiders or creator rug history = true in the features; 'lp': LP locked KNOWN and < 90 %.
 * NOT checked (not historised at detection): mint / freeze authority and top 10 — flagged in the notes.
 */
export type YoungDetectionFailure = 'age' | 'dex' | 'liquidity' | 'roundtrip' | 'momentum_unknown' | 'rug' | 'lp';

export function youngDetectionFailures(d: DetectionInput): YoungDetectionFailure[] {
  const out: YoungDetectionFailure[] = [];
  const r = YOUNG_BASE_RULES;
  const fin = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!(fin(d.pairAgeH) && d.pairAgeH >= 0 && d.pairAgeH < r.maxPairAgeH)) out.push('age');
  if (d.entryDexId !== r.dexId) out.push('dex');
  if (!(fin(d.entryLiqEff) && d.entryLiqEff >= r.minLiquidity)) out.push('liquidity');
  if (fin(d.roundtripPct) && !(d.roundtripPct >= 0 && d.roundtripPct < r.maxRoundtripPct)) out.push('roundtrip');
  if (!fin(d.change1h) || !fin(d.buySellRatio1h)) out.push('momentum_unknown');
  if (d.insiders === true || d.creatorRug === true) out.push('rug');
  if (!youngLpOk(d.lpLockedPct)) out.push('lp');
  return out;
}

/**
 * Momentum class of a detection that passes the base rules (youngMomentumClass of presets.ts on change_1h and the
 * ratio at detection), or null when a base rule fails.
 */
export function youngDetectionClass(d: DetectionInput): YoungMomentum | null {
  if (youngDetectionFailures(d).length > 0) return null;
  return youngMomentumClass(d.change1h, d.buySellRatio1h);
}

/** 'gta' when the narrative at detection is GTA, else 'other' (unknown included). */
export const narrativeGroup = (n: string | null | undefined): 'gta' | 'other' => (n === 'GTA' ? 'gta' : 'other');

// ---------------------------------------------------------------------------------------------------------------
// Events (event-mode presets, public.backtest_events)

export interface EventInput {
  /** backtest_events.id (as text: keyset key). */
  key: string;
  preset: YoungEventPreset;
  mint: string;
  eventAtMs: number;
  /** PERCENT known at the event, null = unknown (3 % charged). */
  roundtripPct: number | null;
  narrative: string | null;
}

/** Event-mode preset of a backtest_events row (the archived presets are skipped). */
const isEventModePreset = (v: unknown): v is YoungEventPreset =>
  typeof v === 'string' && (YOUNG_EVENT_PRESETS as readonly string[]).includes(v);

/**
 * A backtest_events row { id, preset, mint, event_at, roundtrip_pct?, conditions?, narrative } → EventInput, or null
 * (invalid id / preset / mint / time). The roundtrip is read from roundtrip_pct, else conditions.roundtrip_pct.
 */
export function eventFromRow(row: unknown): EventInput | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  const id = numOrNull(r['id']);
  if (id === null || !Number.isSafeInteger(id) || id <= 0) return null;
  if (!isEventModePreset(r['preset'])) return null;
  if (typeof r['mint'] !== 'string' || !MINT_RE.test(r['mint'])) return null;
  if (typeof r['event_at'] !== 'string' || r['event_at'].length > 40) return null;
  const eventAtMs = Date.parse(r['event_at']);
  if (!Number.isFinite(eventAtMs)) return null;
  const cond = typeof r['conditions'] === 'object' && r['conditions'] !== null ? (r['conditions'] as Record<string, unknown>) : {};
  const rt = numOrNull(r['roundtrip_pct']) ?? numOrNull(cond['roundtrip_pct']);
  return {
    key: String(id),
    preset: r['preset'],
    mint: r['mint'],
    eventAtMs,
    roundtripPct: rt !== null && rt >= 0 && rt <= 100 ? rt : null,
    narrative: strOrNull(r['narrative'], 24),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Chronological split (B4)

/**
 * Cutoff of the global split: detections sorted by time, the first round(trainFrac × n) are training, the rest test;
 * returns the detected_at (ms) of the first TEST detection (test = detectedAtMs ≥ cutoff). null when n < 2.
 * Ties at the cutoff all go to test.
 */
export function chronoCutoff(detectedAtMs: readonly number[], trainFrac = 0.7): number | null {
  const ts = arr(detectedAtMs).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (ts.length < 2 || !(trainFrac > 0 && trainFrac < 1)) return null;
  const nTrain = Math.min(ts.length - 1, Math.max(1, Math.round(trainFrac * ts.length)));
  return ts[nTrain]!;
}

export const splitOf = (detectedAtMs: number, cutoffMs: number): Split => (detectedAtMs >= cutoffMs ? 'test' : 'train');

export interface DataVersion {
  n_detections: number;
  /** Detections by finest timeframe of their path; 'none' = no candle. */
  resolutions: Record<CandleTf | 'none', number>;
  cutoff_at: string | null;
  max_detected_at: string | null;
  train: number;
  test: number;
}

/** backtest_runs.data_version from the detections of the run (time + finest timeframe). */
export function dataVersion(dets: ReadonlyArray<{ detectedAtMs: number; finest: CandleTf | null }>, trainFrac = 0.7): DataVersion {
  const valid = arr(dets).filter((d) => d && Number.isFinite(d.detectedAtMs));
  const cutoff = chronoCutoff(valid.map((d) => d.detectedAtMs), trainFrac);
  const resolutions: Record<CandleTf | 'none', number> = { '1m': 0, '5m': 0, '15m': 0, none: 0 };
  let max = Number.NEGATIVE_INFINITY;
  let test = 0;
  for (const d of valid) {
    resolutions[d.finest ?? 'none']++;
    if (d.detectedAtMs > max) max = d.detectedAtMs;
    if (cutoff !== null && d.detectedAtMs >= cutoff) test++;
  }
  return {
    n_detections: valid.length,
    resolutions,
    cutoff_at: cutoff === null ? null : new Date(cutoff).toISOString(),
    max_detected_at: valid.length > 0 ? new Date(max).toISOString() : null,
    train: cutoff === null ? valid.length : valid.length - test,
    test,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// backtest_trades rows

/** Origin of a backtest_trades row: a detection table, or an event (backtest_events). */
export type TradeSource = DetectionSource | 'backtest_events';

export interface TradeRecord {
  source: TradeSource;
  mint: string;
  detectedAtMs: number;
  split: Split;
  presetFlags: number;
  narrative: 'gta' | 'other';
  /** Net % per combo index (length N_COMBOS), NaN / null = no trade. */
  returns: ArrayLike<number | null>;
  /** open_at_end per combo index (length N_COMBOS), absent = none open. */
  openAtEnd?: ArrayLike<number>;
}

/** 384 flags → 96 hex chars (bit i of the bitset = combo i, little-endian nibbles). */
export function encodeFlags(flags: ArrayLike<number>): string {
  let out = '';
  for (let i = 0; i < N_COMBOS; i += 4) {
    let nib = 0;
    for (let b = 0; b < 4; b++) if (flags[i + b]) nib |= 1 << b;
    out += nib.toString(16);
  }
  return out;
}

/** Inverse of encodeFlags; invalid input → null. */
export function decodeFlags(hex: unknown): Uint8Array | null {
  if (typeof hex !== 'string' || hex.length !== N_COMBOS / 4 || !/^[0-9a-f]+$/.test(hex)) return null;
  const out = new Uint8Array(N_COMBOS);
  for (let i = 0; i < hex.length; i++) {
    const nib = parseInt(hex[i]!, 16);
    for (let b = 0; b < 4; b++) out[i * 4 + b] = (nib >> b) & 1;
  }
  return out;
}

/** Insert row of public.backtest_trades (run_id added by the caller). Returns rounded to 4 decimals, NaN → null. */
export function tradeRow(d: DetectionInput, sim: DetectionSim, split: Split) {
  return {
    source: d.source,
    mint: d.mint,
    detected_at: new Date(d.detectedAtMs).toISOString(),
    split,
    preset_flags: presetFlags(d),
    narrative: narrativeGroup(d.narrative),
    returns: Array.from(sim.returns, (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null)),
    open_at_end: encodeFlags(sim.openAtEnd),
  };
}
export type BacktestTradeRow = ReturnType<typeof tradeRow>;

/**
 * Insert row of public.backtest_trades for an EVENT (source 'backtest_events', detected_at = event_at, preset_flags =
 * the single bit of the event's preset). Two presets firing on the same snapshot give two rows: the primary key must
 * include preset_flags (run_id, source, mint, detected_at, preset_flags).
 */
export function eventTradeRow(e: EventInput, sim: DetectionSim, split: Split) {
  return {
    source: 'backtest_events' as const,
    mint: e.mint,
    detected_at: new Date(e.eventAtMs).toISOString(),
    split,
    preset_flags: PRESET_BIT[e.preset],
    narrative: narrativeGroup(e.narrative),
    returns: Array.from(sim.returns, (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null)),
    open_at_end: encodeFlags(sim.openAtEnd),
  };
}

/** Detection bits (rows of signal_outcomes / preset_signals, archived bits 2 / 4 / 8 / 16 of older runs included) and event bits. */
const DETECTION_BITS = PRESETS.filter((p) => PRESET_MODE[p] === 'detection').reduce((m, p) => m | PRESET_BIT[p], 0) |
  DETECTION_ROW_BIT | 2 | 4 | 8 | 16;
const EVENT_BITS: ReadonlySet<number> = new Set(PRESETS.filter((p) => PRESET_MODE[p] === 'event').map((p) => PRESET_BIT[p]));

/** Same rule as the backtest_trades preset_flags CHECK: odd detection bitset, or exactly one event bit. */
function validFlagsFor(source: TradeSource, flags: number): boolean {
  if (source === 'backtest_events') return EVENT_BITS.has(flags);
  return flags % 2 === 1 && (flags & ~DETECTION_BITS) === 0;
}

/**
 * A backtest_trades row read back → TradeRecord, or null when malformed. returns must hold the N_COMBOS values, or
 * a slice starting at combo `returnsOffset` (SQL returns[lo+1 : hi+1], then pass lo; aggregate with the same
 * returnsOffset); the open flags are sliced the same way.
 */
export function parseTradeRow(row: unknown, returnsOffset?: number): TradeRecord | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  if (r['source'] !== 'signal_outcomes' && r['source'] !== 'preset_signals' && r['source'] !== 'backtest_events') return null;
  if (typeof r['mint'] !== 'string' || !MINT_RE.test(r['mint'])) return null;
  const ms = typeof r['detected_at'] === 'string' && r['detected_at'].length <= 40 ? Date.parse(r['detected_at']) : NaN;
  if (!Number.isFinite(ms)) return null;
  if (r['split'] !== 'train' && r['split'] !== 'test') return null;
  const flags = numOrNull(r['preset_flags']);
  if (flags === null || !Number.isInteger(flags) || flags < 1 || flags > PRESET_FLAGS_MAX) return null;
  if (!validFlagsFor(r['source'], flags)) return null;
  const sliced = returnsOffset !== undefined;
  const offset = returnsOffset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset >= N_COMBOS) return null;
  const len = Array.isArray(r['returns']) ? r['returns'].length : 0;
  // Without an offset the 384 values are required; with one, any non-empty slice that fits.
  if (len === 0 || offset + len > N_COMBOS || (!sliced && len !== N_COMBOS)) return null;
  const src = r['returns'] as unknown[];
  const returns = new Float32Array(len);
  for (let i = 0; i < len; i++) returns[i] = numOrNull(src[i]) ?? Number.NaN;
  const full = r['open_at_end'] === null || r['open_at_end'] === undefined ? undefined : decodeFlags(r['open_at_end']);
  if (full === null) return null;
  const open = full?.subarray(offset, offset + len);
  return {
    source: r['source'],
    mint: r['mint'],
    detectedAtMs: ms,
    split: r['split'],
    presetFlags: flags,
    narrative: r['narrative'] === 'gta' ? 'gta' : 'other',
    returns,
    openAtEnd: open,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Metrics (B5) and validation (B4)

export interface Metrics {
  trades: number;
  win_rate: number | null;
  avg_win_pct: number | null;
  avg_loss_pct: number | null;
  avg_net_pct: number | null;
  avg_net_sol: number | null;
  /** Σ wins / |Σ losses| (net SOL); null when there is no losing trade (or no trade). */
  profit_factor: number | null;
  /** Peak-to-trough drop of the cumulative net SOL (0.1 SOL per trade, chronological, starting at 0), ≥ 0. */
  max_drawdown_sol: number;
  worst_losing_streak: number;
  open_at_end: number;
}

/** Metrics of a chronological series of net % (non-finite entries skipped). open flags optional. */
export function computeMetrics(netPcts: ArrayLike<number>, open?: ArrayLike<number>): Metrics {
  let n = 0;
  let wins = 0;
  let winSum = 0;
  let losses = 0;
  let lossSum = 0;
  let sum = 0;
  let cum = 0;
  let peak = 0;
  let dd = 0;
  let streak = 0;
  let worst = 0;
  let openN = 0;
  for (let i = 0; i < netPcts.length; i++) {
    const x = netPcts[i];
    if (typeof x !== 'number' || !Number.isFinite(x)) continue;
    n++;
    sum += x;
    if (x > 0) {
      wins++;
      winSum += x;
    }
    if (x < 0) {
      losses++;
      lossSum += x;
      streak++;
      if (streak > worst) worst = streak;
    } else {
      streak = 0;
    }
    cum += netSol(x);
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
    if (open && open[i]) openN++;
  }
  return {
    trades: n,
    win_rate: n > 0 ? wins / n : null,
    avg_win_pct: wins > 0 ? winSum / wins : null,
    avg_loss_pct: losses > 0 ? lossSum / losses : null,
    avg_net_pct: n > 0 ? sum / n : null,
    avg_net_sol: n > 0 ? netSol(sum / n) : null,
    profit_factor: losses > 0 ? winSum / -lossSum : null,
    max_drawdown_sol: dd,
    worst_losing_streak: worst,
    open_at_end: openN,
  };
}

/** mulberry32: small, fast, seeded PRNG in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Linear-interpolated quantile of a sorted array. */
function quantileSorted(sorted: Float64Array, p: number): number {
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export const BOOTSTRAP_ITERATIONS = 1000;
export const BOOTSTRAP_SEED = 20261119;

/**
 * Fills `out` with floor(mulberry32(seed)() × n), exactly the sequence of mulberry32, written with int32 arithmetic
 * (≈ 3× faster than calling the closure: no heap numbers in the loop).
 */
function fillDraws(out: Uint32Array, n: number, seed: number, state?: { a: number }): void {
  let a = state ? state.a : seed | 0;
  for (let k = 0; k < out.length; k++) {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) | 0;
    out[k] = Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  }
  if (state) state.a = a;
}

/** Largest iterations × n for which the resampling indices are cached (4 bytes each). */
const DRAW_CACHE_MAX = 4_000_000;

/**
 * Resampling indices for n values: iterations × n draws floor(rand() × n), b-major, from mulberry32(seed). Shared by
 * every cell of the same size (same seed → same draws, common random numbers), so they are drawn once.
 */
export class BootstrapDraws {
  private readonly cache = new Map<number, Uint32Array>();
  readonly iterations: number;
  readonly seed: number;
  constructor(iterations = BOOTSTRAP_ITERATIONS, seed = BOOTSTRAP_SEED) {
    this.iterations = Math.floor(iterations);
    this.seed = seed;
  }
  indices(n: number): Uint32Array | null {
    const total = Math.floor(this.iterations) * n;
    if (total > DRAW_CACHE_MAX) return null;
    let idx = this.cache.get(n);
    if (!idx) {
      idx = new Uint32Array(total);
      fillDraws(idx, n, this.seed);
      this.cache.set(n, idx);
    }
    return idx;
  }
}

/**
 * Percentile bootstrap 95 % CI of the mean (resampling with replacement, `iterations` resamples, mulberry32(seed)).
 * Non-finite values are ignored. null when fewer than 2 values. `draws` (optional) reuses cached indices: the result
 * is identical with or without it.
 */
export function bootstrapMeanCi(
  values: ArrayLike<number>,
  iterations = BOOTSTRAP_ITERATIONS,
  seed = BOOTSTRAP_SEED,
  draws?: BootstrapDraws,
): { low: number; high: number } | null {
  const v: number[] = [];
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) v.push(values[i]!);
  const n = v.length;
  const B = Math.floor(iterations);
  if (n < 2 || !(B >= 10)) return null;
  const means = new Float64Array(B);
  const vv = Float64Array.from(v);
  const idx = draws && draws.iterations === B && draws.seed === seed ? draws.indices(n) : null;
  if (idx) {
    let k = 0;
    for (let b = 0; b < B; b++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += vv[idx[k++]!]!;
      means[b] = s / n;
    }
  } else {
    // Same draws, generated one resample at a time (no cache).
    const row = new Uint32Array(n);
    const state = { a: seed | 0 };
    for (let b = 0; b < B; b++) {
      fillDraws(row, n, seed, state);
      let s = 0;
      for (let i = 0; i < n; i++) s += vv[row[i]!]!;
      means[b] = s / n;
    }
  }
  means.sort();
  return { low: quantileSorted(means, 0.025), high: quantileSorted(means, 0.975) };
}

export const MIN_TEST_TRADES = 30;

export interface BacktestResult extends Metrics {
  preset: BacktestPreset;
  exit: BacktestExit;
  sl_pct: number;
  breakeven: boolean;
  /** null = no time exit. */
  time_exit_h: number | null;
  delay_min: number;
  narrative: Narrative;
  split: Split;
  /** TEST rows only (null on train rows and when not computed). */
  ci_low: number | null;
  ci_high: number | null;
  ci_contains_zero: boolean | null;
  /** Same value on the train and test rows of a variant × narrative. */
  retained: boolean;
  robust: boolean;
}

export interface AggregateOptions {
  bootstrapIterations?: number;
  seed?: number;
  minTestTrades?: number;
  /** Bootstrap every test cell with ≥ 2 trades (slow; local script). Default: only retained candidates. */
  bootstrapAll?: boolean;
  /** Narratives to compute (default all three): lets the worker split a preset over several calls. */
  narratives?: readonly Narrative[];
  /** Reused resampling indices (pass the same instance across chunks of a run). */
  draws?: BootstrapDraws;
  /** Slice [from, to) of DISTINCT_COMBOS to compute (default all of them; only the grid combos produce rows). */
  comboRange?: readonly [number, number];
  /**
   * Combo index of returns[0] / openAtEnd[0] when the records hold a SLICE of the 384 values (the worker may read only
   * returns[lo+1 : hi+1] in SQL, see comboIndexSpan). Default 0 (full arrays).
   */
  returnsOffset?: number;
  /**
   * 'preset' (default, lab-v2): 70 / 30 chronological cutoff computed on the preset's OWN trades (one per mint, see
   * presetTrades), whatever the stored split column says. 'stored': the split column of each record (v1 global cutoff).
   */
  split?: 'preset' | 'stored';
}

/** Inclusive combo-index span [lo, hi] covered by a slice [from, to) of DISTINCT_COMBOS (null when empty). */
export function comboIndexSpan(range: readonly [number, number]): [number, number] | null {
  const from = Math.max(0, Math.floor(range[0]));
  const to = Math.min(DISTINCT_COMBOS.length, Math.floor(range[1]));
  if (!(to > from)) return null;
  return [DISTINCT_COMBOS[from]!.index, DISTINCT_COMBOS[to - 1]!.index];
}

/** A record with no entry at any delay (no candle after the detection) is not a trade and never takes a mint slot. */
const hasAnyTrade = (t: TradeRecord): boolean => {
  const r = t.returns;
  if (!r) return false;
  for (let i = 0; i < r.length; i++) {
    const x = r[i];
    if (typeof x === 'number' && Number.isFinite(x)) return true;
  }
  return false;
};

/**
 * Trades of a preset: those with the preset bit and at least one entry, ONE per mint (its earliest matching detection), chronological. A
 * mint detected by the scan and by a preset is counted once, at the first time it satisfied the filter.
 */
export function presetTrades(trades: readonly TradeRecord[], preset: BacktestPreset): TradeRecord[] {
  const bit = PRESET_BIT[preset];
  const sorted = arr(trades)
    .filter((t) => t && (t.presetFlags & bit) !== 0 && Number.isFinite(t.detectedAtMs) && hasAnyTrade(t))
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.detectedAtMs - b.t.detectedAtMs || a.i - b.i)
    .map((x) => x.t);
  const seen = new Set<string>();
  return sorted.filter((t) => {
    if (seen.has(t.mint)) return false;
    seen.add(t.mint);
    return true;
  });
}

/** Per-preset split of a run (data_version / summary): trades kept (one per mint), train / test counts, cutoff. */
export function presetSplit(trades: readonly TradeRecord[], preset: BacktestPreset, trainFrac = 0.7) {
  const list = presetTrades(trades, preset);
  const cutoff = chronoCutoff(list.map((t) => t.detectedAtMs), trainFrac);
  const test = cutoff === null ? 0 : list.filter((t) => t.detectedAtMs >= cutoff).length;
  return { trades: list.length, train: list.length - test, test, cutoff_at: cutoff === null ? null : new Date(cutoff).toISOString() };
}

/**
 * backtest_results rows of one preset: the 6 combos of YOUNG_GRID × narrative (all / gta / other) × split (train /
 * test) = 36 rows. Retained = avg net > 0 in train AND test with ≥ minTestTrades test trades; robust =
 * retained AND the bootstrap 95 % CI of the test mean excludes 0. The CI is computed for retained candidates only
 * (it cannot change anything else) unless bootstrapAll.
 */
export function aggregatePreset(trades: readonly TradeRecord[], preset: BacktestPreset, opts: AggregateOptions = {}): BacktestResult[] {
  const iterations = opts.bootstrapIterations ?? BOOTSTRAP_ITERATIONS;
  const seed = opts.seed ?? BOOTSTRAP_SEED;
  const minTest = opts.minTestTrades ?? MIN_TEST_TRADES;
  const list = presetTrades(trades, preset);
  const cutoff = opts.split === 'stored' ? null : chronoCutoff(list.map((t) => t.detectedAtMs));
  const splitFor = (t: TradeRecord): Split =>
    opts.split === 'stored' ? t.split : cutoff === null ? 'train' : splitOf(t.detectedAtMs, cutoff);
  const draws = opts.draws ?? new BootstrapDraws(iterations, seed);
  const wanted = NARRATIVES.filter((n) => !opts.narratives || opts.narratives.includes(n));
  const groups: Record<Narrative, Record<Split, TradeRecord[]>> = {
    all: { train: [], test: [] },
    gta: { train: [], test: [] },
    other: { train: [], test: [] },
  };
  for (const t of list) {
    const sp = splitFor(t);
    groups.all[sp].push(t);
    groups[t.narrative][sp].push(t);
  }
  const out: BacktestResult[] = [];
  const buf = new Float64Array(list.length);
  const obuf = new Uint8Array(list.length);
  const offset = opts.returnsOffset ?? 0;
  const series = (rows: TradeRecord[], comboIdx: number): { v: Float64Array; o: Uint8Array } => {
    const idx = comboIdx - offset;
    for (let i = 0; i < rows.length; i++) {
      const x = rows[i]!.returns[idx];
      buf[i] = typeof x === 'number' && Number.isFinite(x) ? x : Number.NaN;
      obuf[i] = rows[i]!.openAtEnd?.[idx] ? 1 : 0;
    }
    return { v: buf.subarray(0, rows.length), o: obuf.subarray(0, rows.length) };
  };
  const [from, to] = opts.comboRange ?? [0, DISTINCT_COMBOS.length];
  for (const combo of DISTINCT_COMBOS.slice(Math.max(0, from), Math.min(DISTINCT_COMBOS.length, to))) {
    if (!comboInPresetGrid(preset, combo)) continue; // the 6 combos of YOUNG_GRID only
    for (const narrative of wanted) {
      const g = groups[narrative];
      const tr = series(g.train, combo.index);
      const train = computeMetrics(tr.v, tr.o);
      const te = series(g.test, combo.index);
      const test = computeMetrics(te.v, te.o);
      const retained = train.avg_net_pct !== null && train.avg_net_pct > 0 && test.avg_net_pct !== null &&
        test.avg_net_pct > 0 && test.trades >= minTest;
      let ci: { low: number; high: number } | null = null;
      if (retained || (opts.bootstrapAll && test.trades >= 2)) ci = bootstrapMeanCi(te.v, iterations, seed, draws);
      const containsZero = ci === null ? null : ci.low <= 0 && ci.high >= 0;
      const robust = retained && containsZero === false;
      const base = {
        preset,
        exit: combo.exit,
        sl_pct: combo.slPct,
        breakeven: combo.breakeven,
        time_exit_h: combo.timeExitH,
        delay_min: combo.delayMin,
        narrative,
        retained,
        robust,
      };
      out.push({ ...base, ...train, split: 'train', ci_low: null, ci_high: null, ci_contains_zero: null });
      out.push({ ...base, ...test, split: 'test', ci_low: ci?.low ?? null, ci_high: ci?.high ?? null, ci_contains_zero: containsZero });
    }
  }
  return out;
}

/** Every preset (run it per preset chunk on the Edge worker: aggregatePreset). */
export function aggregateRun(trades: readonly TradeRecord[], opts: AggregateOptions = {}): BacktestResult[] {
  const draws = opts.draws ?? new BootstrapDraws(opts.bootstrapIterations ?? BOOTSTRAP_ITERATIONS, opts.seed ?? BOOTSTRAP_SEED);
  return PRESETS.flatMap((p) => aggregatePreset(trades, p, { ...opts, draws }));
}

// ---------------------------------------------------------------------------------------------------------------
// Report

/** backtest_runs.params: the grid as announced (B3). */
export function gridParams() {
  return {
    presets: [...PRESETS],
    modes: { ...PRESET_MODE },
    exits: [...YOUNG_GRID.exits],
    sl_pcts: [...YOUNG_GRID.slPcts],
    breakeven: [...YOUNG_GRID.breakevens],
    time_exits_h: [...YOUNG_GRID.timeExitsH],
    delays_min: [...YOUNG_GRID.delaysMin],
    n_variants: GRID_COUNTS.variants,
    n_distinct_variants: GRID_COUNTS.distinctVariants,
    train_fraction: 0.7,
    min_test_trades: MIN_TEST_TRADES,
    bootstrap: { iterations: BOOTSTRAP_ITERATIONS, seed: BOOTSTRAP_SEED, level: 0.95 },
    fees: { default_roundtrip_pct: DEFAULT_ROUNDTRIP_PCT, tx_fee_sol: TX_FEE_SOL, stake_sol: STAKE_SOL },
    notes: [
      `Jeune calme / Jeune frénésie, modes détection et événement : tout vendre à ×2 × stop −20 / −30 / −40 % × sans breakeven × sans sortie au temps × délai 0 / 2 min = ${YOUNG_COMBOS.length} variantes par preset, ${GRID_COUNTS.variants} au total.`,
      'Mode détection : âge, dex, liquidité effective, change_1h et ratio achats/ventes 1 h, LP et historique RugCheck lus dans les features à la détection ; coût d\'aller-retour vérifié seulement s\'il est connu (presque jamais à la 1re détection : 3 % facturés) ; autorités et top 10 non historisés → non vérifiés.',
      'Mode événement : premier snapshot où les conditions deviennent vraies, colonnes point-in-time du snapshot (ratio et liquidité effective inconnus → exclu), sécurité, top 10 et coût selon les règles lab-v2 (coût filtré seulement s\'il est connu) ; entrée sur bougies 1 min (sans bougie 1 min → événement en attente, non simulé).',
      'Coupure 70 / 30 chronologique par preset, sur ses propres trades ; un même token compte une seule fois par preset.',
      'Les anciens presets du Laboratoire (Tous, MC 300 k$ – 1 M$, Momentum, Jeune & fort, Post-migration, Leader de narratif, exploratoires) sont archivés.',
      'Backtest ≠ résultat futur.',
    ],
  };
}

export interface BacktestReport {
  params: ReturnType<typeof gridParams>;
  data_version: DataVersion;
  n_variants: number;
  n_distinct_variants: number;
  retained: number;
  robust: number;
  /** Retained variants (narrative 'all', test rows), best test average first, with their train metrics. */
  top: Array<{ variant: Omit<BacktestResult, keyof Metrics | 'split' | 'ci_low' | 'ci_high' | 'ci_contains_zero'>; train: Metrics; test: Metrics & { ci_low: number | null; ci_high: number | null } }>;
  warning: string;
}

/** « 24 variantes Jeune calme / frénésie ». */
const TESTED_TEXT = `${GRID_COUNTS.distinctVariants} variantes Jeune calme / frénésie`;

const variantKey = (r: BacktestResult) => `${r.preset}|${r.exit}|${r.sl_pct}|${r.breakeven}|${r.time_exit_h}|${r.delay_min}|${r.narrative}`;
const metricsOf = (r: BacktestResult): Metrics => ({
  trades: r.trades,
  win_rate: r.win_rate,
  avg_win_pct: r.avg_win_pct,
  avg_loss_pct: r.avg_loss_pct,
  avg_net_pct: r.avg_net_pct,
  avg_net_sol: r.avg_net_sol,
  profit_factor: r.profit_factor,
  max_drawdown_sol: r.max_drawdown_sol,
  worst_losing_streak: r.worst_losing_streak,
  open_at_end: r.open_at_end,
});

/** Summary of a run (scripts/backtest-local.ts output; the screen reads backtest_results directly). */
export function buildReport(results: readonly BacktestResult[], dv: DataVersion, topN = 30): BacktestReport {
  const train = new Map<string, BacktestResult>();
  for (const r of results) if (r.split === 'train') train.set(variantKey(r), r);
  const tests = results.filter((r) => r.split === 'test' && r.narrative === 'all' && r.retained);
  tests.sort((a, b) => (b.avg_net_pct ?? -Infinity) - (a.avg_net_pct ?? -Infinity));
  const robust = tests.filter((r) => r.robust).length;
  return {
    params: gridParams(),
    data_version: dv,
    n_variants: GRID_COUNTS.variants,
    n_distinct_variants: GRID_COUNTS.distinctVariants,
    retained: tests.length,
    robust,
    top: tests.slice(0, topN).map((r) => {
      const tr = train.get(variantKey(r));
      return {
        variant: {
          preset: r.preset,
          exit: r.exit,
          sl_pct: r.sl_pct,
          breakeven: r.breakeven,
          time_exit_h: r.time_exit_h,
          delay_min: r.delay_min,
          narrative: r.narrative,
          retained: r.retained,
          robust: r.robust,
        },
        train: tr ? metricsOf(tr) : computeMetrics([]),
        test: { ...metricsOf(r), ci_low: r.ci_low, ci_high: r.ci_high },
      };
    }),
    warning: robust === 0
      ? `Aucune variante robuste sur ${TESTED_TEXT}. Backtest ≠ résultat futur.`
      : `${robust} variante(s) robuste(s) sur ${TESTED_TEXT} : avec autant de comparaisons, quelques-unes sont attendues par hasard. Backtest ≠ résultat futur.`,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Nightly summary (lab-v2 §3): backtest_runs.summary

export interface RunSummaryCandidate {
  preset: BacktestPreset;
  exit: BacktestExit;
  sl_pct: number;
  breakeven: boolean;
  /** null = no time exit. */
  time_exit_h: number | null;
  delay_min: number;
  narrative: Narrative;
  test: { trades: number; avg_net_pct: number | null; ci_low: number | null; ci_high: number | null };
  train: { trades: number; avg_net_pct: number | null };
}

export interface RunSummary {
  verdict: 'none' | 'candidate';
  text: string;
  run_at: string;
  n_detections: number;
  n_events: number;
  candidate?: RunSummaryCandidate;
}

export interface RunSummaryMeta {
  /** ISO (or epoch ms) of the run. */
  run_at: string | number;
  /** Detections of the run (detection mode) and events simulated (event mode). */
  n_detections: number;
  n_events: number;
}

const EXIT_TEXT: Readonly<Record<BacktestExit, string>> = {
  all_x2: 'tout vendre à ×2',
  half_x2_rest_x3: 'moitié à ×2, reste à ×3',
  thirds_x2_x3_x4: 'tiers à ×2 / ×3 / ×4',
  all_x1_5: 'tout vendre à ×1,5',
};
const NARRATIVE_TEXT: Readonly<Record<Narrative, string>> = { all: 'tous narratifs', gta: 'GTA seulement', other: 'hors GTA' };

/** French integer with a space every 3 digits (2 016). */
const frInt = (n: number): string => String(Math.max(0, Math.round(Number.isFinite(n) ? n : 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
/** Signed French percent with one decimal (+8,1 %, −3,0 %); null → « n/d ». */
const frPct = (x: number | null): string => {
  if (x === null || !Number.isFinite(x)) return 'n/d';
  const v = Math.round(x * 10) / 10;
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${Math.abs(v).toFixed(1).replace('.', ',')} %`;
};
const frDate = (ms: number): string => {
  if (!Number.isFinite(ms)) return 'date inconnue';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
};
const comboOrder = (r: BacktestResult): number =>
  PRESETS.indexOf(r.preset) * N_COMBOS +
  comboIndex(EXITS.indexOf(r.exit), SL_PCTS.indexOf(r.sl_pct), r.breakeven ? 1 : 0, TIME_EXITS_H.indexOf(r.time_exit_h), DELAYS_MIN.indexOf(r.delay_min));

/** « Jeune calme (détection), tout vendre à ×2, stop −30 %, sans sortie au temps, délai 2 min (tous narratifs) ». */
export function describeVariant(v: Pick<BacktestResult, 'preset' | 'exit' | 'sl_pct' | 'breakeven' | 'time_exit_h' | 'delay_min' | 'narrative'>): string {
  const time = v.time_exit_h === null || v.time_exit_h === 0 ? 'sans sortie au temps' : `sortie au bout de ${v.time_exit_h} h`;
  const be = EXIT_LEGS[v.exit]?.sizes.length > 1 ? `, breakeven ${v.breakeven ? 'oui' : 'non'}` : '';
  return `${PRESET_LABELS[v.preset] ?? v.preset}, ${EXIT_TEXT[v.exit] ?? v.exit}, stop −${v.sl_pct} %${be}, ${time}, délai ${v.delay_min} min (${NARRATIVE_TEXT[v.narrative] ?? v.narrative})`;
}

/**
 * backtest_runs.summary from the results of a run (only the robust rows are needed, train AND test: robust is set on
 * both). Candidate = the robust variant with the best test average net, narrative 'all' first, else 'other' (ties: more
 * test trades, then grid order). A variant robust only in GTA is mentioned in the text, never a candidate. Archived
 * presets (not in PRESETS) are ignored.
 */
export function buildRunSummary(results: readonly BacktestResult[], meta: RunSummaryMeta): RunSummary {
  const runMs = typeof meta.run_at === 'number' ? meta.run_at : Date.parse(meta.run_at);
  const runAt = Number.isFinite(runMs) ? new Date(runMs).toISOString() : String(meta.run_at);
  const nDet = Number.isFinite(meta.n_detections) ? Math.max(0, Math.round(meta.n_detections)) : 0;
  const nEv = Number.isFinite(meta.n_events) ? Math.max(0, Math.round(meta.n_events)) : 0;
  const rows = arr(results).filter((r) => r && r.robust && isYoungCalmPreset(r.preset));
  const train = new Map<string, BacktestResult>();
  for (const r of rows) if (r.split === 'train') train.set(variantKey(r), r);
  const tests = rows.filter((r) => r.split === 'test');
  const best = (narr: Narrative): BacktestResult | null => {
    const list = tests.filter((r) => r.narrative === narr);
    list.sort((a, b) => (b.avg_net_pct ?? -Infinity) - (a.avg_net_pct ?? -Infinity) || b.trades - a.trades || comboOrder(a) - comboOrder(b));
    return list[0] ?? null;
  };
  const pick = best('all') ?? best('other');
  const gta = best('gta');
  const sample = `run du ${frDate(runMs)}, ${frInt(nDet)} détections et ${frInt(nEv)} événements, ${frInt(GRID_COUNTS.distinctVariants)} variantes testées (Jeune calme / frénésie)`;
  const gtaNote = gta && !pick
    ? ` Une variante robuste seulement sur le narratif GTA est signalée mais pas retenue (${describeVariant(gta)} : test ${gta.trades} trades, ${frPct(gta.avg_net_pct)}).`
    : '';
  const base = { run_at: runAt, n_detections: nDet, n_events: nEv };
  if (!pick) {
    return {
      verdict: 'none',
      text: `Aucune stratégie robuste — ${sample}.${gtaNote} Backtest ≠ résultat futur.`,
      ...base,
    };
  }
  const tr = train.get(variantKey(pick));
  const candidate: RunSummaryCandidate = {
    preset: pick.preset,
    exit: pick.exit,
    sl_pct: pick.sl_pct,
    breakeven: pick.breakeven,
    time_exit_h: pick.time_exit_h === 0 ? null : pick.time_exit_h,
    delay_min: pick.delay_min,
    narrative: pick.narrative,
    test: { trades: pick.trades, avg_net_pct: pick.avg_net_pct, ci_low: pick.ci_low, ci_high: pick.ci_high },
    train: { trades: tr?.trades ?? 0, avg_net_pct: tr?.avg_net_pct ?? null },
  };
  const text = `Stratégie candidate : ${describeVariant(pick)}. Test : ${pick.trades} trades, ${frPct(pick.avg_net_pct)} net moyen par trade ` +
    `(IC 95 % ${frPct(pick.ci_low)} à ${frPct(pick.ci_high)}) ; apprentissage : ${candidate.train.trades} trades, ${frPct(candidate.train.avg_net_pct)}. ` +
    `${sample.charAt(0).toUpperCase()}${sample.slice(1)} : un résultat robuste peut être dû au hasard, à confirmer en simulation papier. Backtest ≠ résultat futur.`;
  return { verdict: 'candidate', text, ...base, candidate };
}

/** A public.backtest_results row read back → BacktestResult (time_exit_h 0 → null), or null when malformed. */
export function resultFromRow(row: unknown): BacktestResult | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  if (!(PRESETS as readonly unknown[]).includes(r['preset']) || !(EXITS as readonly unknown[]).includes(r['exit'])) return null;
  if (!(NARRATIVES as readonly unknown[]).includes(r['narrative']) || (r['split'] !== 'train' && r['split'] !== 'test')) return null;
  const sl = numOrNull(r['sl_pct']);
  const te = numOrNull(r['time_exit_h']);
  const delay = numOrNull(r['delay_min']);
  const trades = numOrNull(r['trades']);
  if (sl === null || !SL_PCTS.includes(sl) || te === null || delay === null || !DELAYS_MIN.includes(delay) || trades === null) return null;
  const time = te === 0 ? null : te;
  if (!TIME_EXITS_H.includes(time)) return null;
  const b = (v: unknown) => v === true || v === 't' || v === 'true';
  return {
    preset: r['preset'] as BacktestPreset,
    exit: r['exit'] as BacktestExit,
    sl_pct: sl,
    breakeven: b(r['breakeven']),
    time_exit_h: time,
    delay_min: delay,
    narrative: r['narrative'] as Narrative,
    split: r['split'],
    trades,
    win_rate: numOrNull(r['win_rate']),
    avg_win_pct: numOrNull(r['avg_win_pct']),
    avg_loss_pct: numOrNull(r['avg_loss_pct']),
    avg_net_pct: numOrNull(r['avg_net_pct']),
    avg_net_sol: numOrNull(r['avg_net_sol']),
    profit_factor: numOrNull(r['profit_factor']),
    max_drawdown_sol: numOrNull(r['max_drawdown_sol']) ?? 0,
    worst_losing_streak: numOrNull(r['worst_losing_streak']) ?? 0,
    open_at_end: numOrNull(r['open_at_end']) ?? 0,
    ci_low: numOrNull(r['ci_low']),
    ci_high: numOrNull(r['ci_high']),
    ci_contains_zero: r['ci_contains_zero'] === null || r['ci_contains_zero'] === undefined ? null : b(r['ci_contains_zero']),
    retained: b(r['retained']),
    robust: b(r['robust']),
  };
}
