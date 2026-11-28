// feat/wallet-study — OFFLINE study of « smart wallets » among the early buyers (rank 1–50) of labelled detections.
// Study only: no alert, no trading, nothing written. Pure: no I/O, no Date.now(), no Math.random() (seeded PRNG), no zod.
// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test`.
//
// Pre-registered protocol (criteria fixed BEFORE seeing data — do not tune them on the results):
// - Tokens: signal_outcomes rows final OR observed ≥ 12 h (decided before data, see scripts/wallet-study-lib.ts) with
//   hit_x3, x2_before_sl30 and sl30_before_x2 known, AND at least one
//   early_buyers row (a token without collected buyers cannot be told apart from « no smart wallet »: excluded, counted).
// - Chronological split by detected_at (tie-break mint): A = floor(60 % × n) oldest, B = the rest.
// - Everything wallet-related is derived from A ONLY (no B information leaks into the selection):
//   * broad wallets (present in > 30 % of A tokens: launch bots / systematic snipers) are excluded;
//   * smart wallet = rank ≤ 50 on ≥ 3 A tokens that hit ×3 AND its ×3 rate on its A tokens ≥ 2 × the A base ×3 rate;
//   * control = for each smart wallet, one non-smart, non-broad wallet drawn (seeded) with the SAME number of A tokens
//     (nearest count when no exact match is left; fallbacks counted).
// - B groups: ≥ 1 smart wallet early / ≥ 2 / none / control (≥ 1 control wallet). Same on young tokens (pair < 24 h at
//   detection, age = expm1(features.log_age_h)).
// - Trade per token (entry at detection): ×2 before −30 % → +100 − 3 = +97 %; −30 % before ×2 → −30 − 3 = −33 %;
//   neither within the labelling window → 0 − 3 = −3 % (NOT marked to max: conservative, stated in the report).
// - Bootstrap: 2 000 resamples, seeded, percentile 95 % CI. Difference vs control: independent two-sample bootstrap
//   (a token can belong to both groups; the overlap is ignored → the CI is conservative-ish, stated).
// - Verdict on B « all » (young = informative only): see walletStudyVerdict.
import { decodeOhlcvRow } from './candles';
import { isSolanaAddress } from './solana';

// ---------------------------------------------------------------------------------------------------------------
// Protocol constants

export const STUDY_SEED = 20261121;
export const SPLIT_A_FRACTION = 0.6;
export const BROAD_WALLET_MAX_SHARE = 0.3;
export const EARLY_MAX_RANK = 50;
export const SMART_MIN_X3_TOKENS = 3;
export const SMART_MIN_LIFT = 2;
export const BOOTSTRAP_RESAMPLES = 2000;
export const VERDICT_MIN_TOKENS = 30;
export const YOUNG_MAX_AGE_H = 24;
export const FEES_PCT = 3;
export const GAIN_X2_PCT = 100 - FEES_PCT;
export const GAIN_SL_PCT = -30 - FEES_PCT;
export const GAIN_NEITHER_PCT = 0 - FEES_PCT;
/** Number of extra control draws of the robustness check (informative, not part of the verdict). */
export const CONTROL_ROBUSTNESS_DRAWS = 100;

// ---------------------------------------------------------------------------------------------------------------
// Types

export interface StudyToken {
  mint: string;
  detectedMs: number;
  hitX3: boolean;
  x2First: boolean;
  slFirst: boolean;
  maxMultiple: number | null;
  /** Hours from detection to the first ×2 / ×3 (null = not reached / unknown). */
  hoursToX2: number | null;
  hoursToX3: number | null;
  /** Pair age at detection (h), from features.log_age_h; null = unknown. */
  ageH: number | null;
}

export interface EarlyBuy {
  mint: string;
  wallet: string;
  /** Buy time (ms); null when the collector could not date it (membership still counts, delays skip it). */
  tsMs: number | null;
  solAmount: number | null;
  rank: number;
}

export type Rng = () => number;

export interface GroupMetrics {
  n: number;
  pct_x2_first: number | null;
  pct_sl_first: number | null;
  pct_neither: number | null;
  mean_gain_pct: number | null;
  ci95: [number, number] | null;
}

export interface SmartWallet {
  wallet: string;
  a_tokens: number;
  a_x3_tokens: number;
  x3_rate: number;
}

export type VerdictLabel = 'piste confirmée' | 'piste incertaine' | 'piste réfutée';

export interface Verdict {
  label: VerdictLabel;
  reason: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Row parsing (CLI rows: numbers / booleans may arrive as strings)

const num = (v: unknown): number | null => {
  const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && v.length <= 40 ? Number(v) : NaN;
  return Number.isFinite(x) ? x : null;
};
const bool = (v: unknown): boolean | null =>
  v === true || v === 't' || v === 'true' ? true : v === false || v === 'f' || v === 'false' ? false : null;
const timeMs = (v: unknown): number | null => {
  if (typeof v !== 'string' || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function features(v: unknown): Record<string, unknown> | null {
  if (typeof v === 'string' && v.length <= 16_384) {
    try {
      return record(JSON.parse(v));
    } catch {
      return null;
    }
  }
  return record(v);
}

/** Pair age (h) from features.log_age_h = log1p(age_h); null when unknown / invalid. */
export function ageFromLogAge(logAge: unknown): number | null {
  const x = num(logAge);
  if (x === null || x < 0 || x > 20) return null;
  return Math.expm1(x);
}

/** signal_outcomes CLI row → StudyToken, or null when not usable (invalid mint, missing labels). */
export function parseOutcomeRow(row: unknown): StudyToken | null {
  const r = record(row);
  if (!r || typeof r['mint'] !== 'string' || !isSolanaAddress(r['mint'])) return null;
  const detectedMs = timeMs(r['detected_at']);
  const hitX3 = bool(r['hit_x3']);
  const x2First = bool(r['x2_before_sl30']);
  const slFirst = bool(r['sl30_before_x2']);
  if (detectedMs === null || hitX3 === null || x2First === null || slFirst === null) return null;
  if (x2First && slFirst) return null;
  const f = features(r['features']);
  return {
    mint: r['mint'],
    detectedMs,
    hitX3,
    x2First,
    slFirst,
    maxMultiple: num(r['max_multiple_7d']),
    hoursToX2: num(r['hours_to_x2']),
    hoursToX3: num(r['hours_to_x3']),
    ageH: f ? ageFromLogAge(f['log_age_h']) : null,
  };
}

/** early_buyers CLI row → EarlyBuy, or null (invalid addresses, rank outside 1–50). A null / bad ts is kept as null. */
export function parseBuyerRow(row: unknown): EarlyBuy | null {
  const r = record(row);
  if (!r || typeof r['mint'] !== 'string' || typeof r['wallet'] !== 'string') return null;
  if (!isSolanaAddress(r['mint']) || !isSolanaAddress(r['wallet'])) return null;
  const tsMs = timeMs(r['ts']);
  const rank = num(r['rank']);
  if (rank === null || !Number.isInteger(rank) || rank < 1 || rank > EARLY_MAX_RANK) return null;
  return { mint: r['mint'], wallet: r['wallet'], tsMs, solAmount: num(r['sol_amount']), rank };
}

/** preset_signals (preset = young_calm) CLI row → { mint, detectedMs }, or null. */
export function parseYoungCalmRow(row: unknown): { mint: string; detectedMs: number } | null {
  const r = record(row);
  if (!r || typeof r['mint'] !== 'string' || !isSolanaAddress(r['mint'])) return null;
  const detectedMs = timeMs(r['detected_at']);
  return detectedMs === null ? null : { mint: r['mint'], detectedMs };
}

/**
 * Time (ms) of the highest high among the ohlcv_candles rows of ONE mint (open time of the candle; first one wins on
 * ties), or null when no valid candle. The stored window is detection → +72 h (5 m) / +6 h (1 m): this is the peak
 * INSIDE that window, not the 7-day peak behind max_multiple_7d.
 */
export function candlePeakMs(rows: readonly unknown[]): number | null {
  let best = -Infinity;
  let at: number | null = null;
  for (const row of rows) {
    const s = decodeOhlcvRow(row);
    if (!s) continue;
    for (const c of s.candles) {
      if (c[2] > best || (c[2] === best && at !== null && c[0] * 1000 < at)) {
        best = c[2];
        at = c[0] * 1000;
      }
    }
  }
  return at;
}

// ---------------------------------------------------------------------------------------------------------------
// Seeded randomness

/** mulberry32: small deterministic PRNG in [0, 1). */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Split, wallets

/** Chronological split: A = floor(fraction × n) oldest tokens (detected_at, then mint), B = the rest. */
export function chronologicalSplit(
  tokens: readonly StudyToken[],
  fraction = SPLIT_A_FRACTION,
): { a: StudyToken[]; b: StudyToken[] } {
  const sorted = [...tokens].sort((x, y) => x.detectedMs - y.detectedMs || (x.mint < y.mint ? -1 : x.mint > y.mint ? 1 : 0));
  const nA = Math.floor(sorted.length * fraction);
  return { a: sorted.slice(0, nA), b: sorted.slice(nA) };
}

/** wallet → set of mints (restricted to `mints`, rank ≤ maxRank, wallets in `excluded` dropped). */
export function walletTokens(
  buys: readonly EarlyBuy[],
  mints: ReadonlySet<string>,
  excluded: ReadonlySet<string> = new Set(),
  maxRank = EARLY_MAX_RANK,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const b of buys) {
    if (b.rank > maxRank || !mints.has(b.mint) || excluded.has(b.wallet)) continue;
    let s = out.get(b.wallet);
    if (!s) out.set(b.wallet, (s = new Set()));
    s.add(b.mint);
  }
  return out;
}

/** Wallets present in strictly more than maxShare of the given tokens (launch bots / systematic snipers). */
export function broadWallets(
  buys: readonly EarlyBuy[],
  mints: ReadonlySet<string>,
  maxShare = BROAD_WALLET_MAX_SHARE,
): Set<string> {
  const out = new Set<string>();
  if (mints.size === 0) return out;
  for (const [w, s] of walletTokens(buys, mints)) if (s.size / mints.size > maxShare) out.add(w);
  return out;
}

/** Smart wallets on A (rank ≤ 50 on ≥ minX3 ×3 tokens AND ×3 rate ≥ lift × base rate), sorted by wallet. */
export function selectSmartWallets(
  tokensA: readonly StudyToken[],
  walletsA: ReadonlyMap<string, ReadonlySet<string>>,
  minX3 = SMART_MIN_X3_TOKENS,
  minLift = SMART_MIN_LIFT,
): { baseRate: number | null; smart: SmartWallet[] } {
  if (tokensA.length === 0) return { baseRate: null, smart: [] };
  const x3 = new Set(tokensA.filter((t) => t.hitX3).map((t) => t.mint));
  const baseRate = x3.size / tokensA.length;
  const smart: SmartWallet[] = [];
  for (const [wallet, mints] of walletsA) {
    let hits = 0;
    for (const m of mints) if (x3.has(m)) hits++;
    const rate = mints.size > 0 ? hits / mints.size : 0;
    if (hits >= minX3 && rate >= minLift * baseRate) {
      smart.push({ wallet, a_tokens: mints.size, a_x3_tokens: hits, x3_rate: rate });
    }
  }
  smart.sort((x, y) => (x.wallet < y.wallet ? -1 : x.wallet > y.wallet ? 1 : 0));
  return { baseRate, smart };
}

/**
 * Activity-matched control: for each smart wallet (wallet order), one wallet drawn without replacement among the
 * non-smart wallets of `walletsA` with the same number of A tokens; when none is left, among those with the nearest
 * count (counted as a fallback). Deterministic for a given rng.
 */
export function sampleControlWallets(
  walletsA: ReadonlyMap<string, ReadonlySet<string>>,
  smart: readonly SmartWallet[],
  rng: Rng,
): { wallets: string[]; exact: number; fallback: number; unmatched: number } {
  const smartSet = new Set(smart.map((s) => s.wallet));
  const pool = new Map<number, string[]>();
  for (const [w, s] of walletsA) {
    if (smartSet.has(w)) continue;
    const list = pool.get(s.size) ?? [];
    list.push(w);
    pool.set(s.size, list);
  }
  for (const list of pool.values()) list.sort();
  const wallets: string[] = [];
  let exact = 0;
  let fallback = 0;
  let unmatched = 0;
  for (const s of smart) {
    let key: number | null = (pool.get(s.a_tokens)?.length ?? 0) > 0 ? s.a_tokens : null;
    if (key !== null) exact++;
    else {
      let bestDist = Infinity;
      for (const [k, list] of [...pool.entries()].sort((x, y) => x[0] - y[0])) {
        if (list.length > 0 && Math.abs(k - s.a_tokens) < bestDist) {
          bestDist = Math.abs(k - s.a_tokens);
          key = k;
        }
      }
      if (key === null) {
        unmatched++;
        continue;
      }
      fallback++;
    }
    const list = pool.get(key) as string[];
    const i = Math.min(list.length - 1, Math.floor(rng() * list.length));
    wallets.push(list[i]!);
    list.splice(i, 1);
  }
  return { wallets, exact, fallback, unmatched };
}

/** Number of distinct wallets of `set` among the early buyers (rank ≤ 50) of each mint. */
export function walletHitsPerMint(
  buys: readonly EarlyBuy[],
  set: ReadonlySet<string>,
  maxRank = EARLY_MAX_RANK,
): Map<string, number> {
  const seen = new Map<string, Set<string>>();
  for (const b of buys) {
    if (b.rank > maxRank || !set.has(b.wallet)) continue;
    let s = seen.get(b.mint);
    if (!s) seen.set(b.mint, (s = new Set()));
    s.add(b.wallet);
  }
  return new Map([...seen].map(([m, s]) => [m, s.size]));
}

// ---------------------------------------------------------------------------------------------------------------
// Metrics, bootstrap

/** Gain (%) of the fixed trade: ×2 first +97, stop first −33, neither −3 (not marked to max). */
export function tradeGainPct(t: Pick<StudyToken, 'x2First' | 'slFirst'>): number {
  return t.x2First ? GAIN_X2_PCT : t.slFirst ? GAIN_SL_PCT : GAIN_NEITHER_PCT;
}

const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
const round = (x: number, d = 2): number => Math.round(x * 10 ** d) / 10 ** d;

function percentile(sorted: readonly number[], p: number): number {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

function resampleMean(xs: readonly number[], rng: Rng): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[Math.min(xs.length - 1, Math.floor(rng() * xs.length))]!;
  return s / xs.length;
}

/** Percentile bootstrap 95 % CI of the mean; null when empty. */
export function bootstrapMeanCI(xs: readonly number[], rng: Rng, resamples = BOOTSTRAP_RESAMPLES): [number, number] | null {
  if (xs.length === 0) return null;
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) means.push(resampleMean(xs, rng));
  means.sort((x, y) => x - y);
  return [percentile(means, 0.025), percentile(means, 0.975)];
}

/** Independent two-sample percentile bootstrap 95 % CI of mean(a) − mean(b); null when either is empty. */
export function bootstrapDiffCI(
  a: readonly number[],
  b: readonly number[],
  rng: Rng,
  resamples = BOOTSTRAP_RESAMPLES,
): [number, number] | null {
  if (a.length === 0 || b.length === 0) return null;
  const diffs: number[] = [];
  for (let r = 0; r < resamples; r++) diffs.push(resampleMean(a, rng) - resampleMean(b, rng));
  diffs.sort((x, y) => x - y);
  return [percentile(diffs, 0.025), percentile(diffs, 0.975)];
}

/** Outcome shares (%), mean gain (%) and its bootstrap CI of a group of tokens. */
export function groupMetrics(tokens: readonly StudyToken[], rng: Rng, resamples = BOOTSTRAP_RESAMPLES): GroupMetrics {
  const n = tokens.length;
  if (n === 0) return { n, pct_x2_first: null, pct_sl_first: null, pct_neither: null, mean_gain_pct: null, ci95: null };
  const x2 = tokens.filter((t) => t.x2First).length;
  const sl = tokens.filter((t) => t.slFirst).length;
  const gains = tokens.map(tradeGainPct);
  const ci = bootstrapMeanCI(gains, rng, resamples);
  return {
    n,
    pct_x2_first: round((100 * x2) / n, 1),
    pct_sl_first: round((100 * sl) / n, 1),
    pct_neither: round((100 * (n - x2 - sl)) / n, 1),
    mean_gain_pct: round(mean(gains)),
    ci95: ci ? [round(ci[0]), round(ci[1])] : null,
  };
}

/**
 * Verdict fixed in advance (on B « all »):
 * - « piste confirmée »: ≥ 30 tokens with ≥ 1 smart wallet, mean gain > 0 with its CI excluding 0 (low > 0), AND
 *   « clearly better » than the control = CI of (smart − control) excluding 0 (low > 0);
 * - « piste incertaine »: smart mean > control mean but one of the above fails (CI contains 0, < 30 tokens…);
 * - « piste réfutée »: smart mean ≤ control mean, or no B token with a smart wallet.
 * With an empty control group nothing can be « better than control »: at best incertaine (smart mean > 0), else réfutée.
 */
export function walletStudyVerdict(
  smart: GroupMetrics,
  control: GroupMetrics,
  diffCi: [number, number] | null,
  minTokens = VERDICT_MIN_TOKENS,
): Verdict {
  if (smart.n === 0 || smart.mean_gain_pct === null) {
    return { label: 'piste réfutée', reason: 'aucun token de B avec un smart wallet early' };
  }
  if (control.n === 0 || control.mean_gain_pct === null) {
    return smart.mean_gain_pct > 0
      ? { label: 'piste incertaine', reason: 'groupe contrôle vide : comparaison impossible' }
      : { label: 'piste réfutée', reason: 'groupe contrôle vide et gain moyen ≤ 0' };
  }
  if (smart.mean_gain_pct <= control.mean_gain_pct) {
    return { label: 'piste réfutée', reason: 'gain moyen des tokens avec smart wallet ≤ contrôle' };
  }
  const issues: string[] = [];
  if (smart.n < minTokens) issues.push(`${smart.n} tokens < ${minTokens}`);
  if (!(smart.mean_gain_pct > 0 && smart.ci95 !== null && smart.ci95[0] > 0)) issues.push('IC 95 % du gain contient 0 (ou gain ≤ 0)');
  if (!(diffCi !== null && diffCi[0] > 0)) issues.push("IC 95 % de l'écart vs contrôle contient 0");
  return issues.length === 0
    ? { label: 'piste confirmée', reason: 'gain > 0 (IC excluant 0) et écart vs contrôle significatif, ≥ 30 tokens' }
    : { label: 'piste incertaine', reason: `meilleur que le contrôle mais : ${issues.join(' ; ')}` };
}

// ---------------------------------------------------------------------------------------------------------------
// Delays

export interface DelayStat {
  n: number;
  median_h: number | null;
}

function delayStat(xs: readonly number[]): DelayStat {
  if (xs.length === 0) return { n: 0, median_h: null };
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, median_h: round(percentile(s, 0.5)) };
}

export interface DelayReport {
  /** Tokens with at least one DATED smart-wallet buy. */
  tokens: number;
  /** detected_at − first smart buy (h); > 0 = the smart wallet bought BEFORE our detection. */
  buy_to_detection: DelayStat;
  pct_bought_before_detection: number | null;
  /** First smart buy → first ×2 / ×3 after detection (detected_at + hours_to_x2 / hours_to_x3). */
  buy_to_x2: DelayStat;
  buy_to_x3: DelayStat;
  /** First smart buy → highest high of the stored candles (detection → +72 h window, not the 7-day peak). */
  buy_to_candle_peak: DelayStat;
  /** First smart buy → « Jeune calme » preset_signals detected_at (tokens that had one). */
  buy_to_young_calm: DelayStat;
  pct_with_young_calm: number | null;
  pct_bought_before_young_calm: number | null;
}

/** Delays measured from the FIRST smart-wallet buy of each token (one value per token). */
export function smartDelays(
  tokens: readonly StudyToken[],
  buys: readonly EarlyBuy[],
  smartSet: ReadonlySet<string>,
  peakMs: ReadonlyMap<string, number>,
  youngCalmMs: ReadonlyMap<string, number>,
  maxRank = EARLY_MAX_RANK,
): DelayReport {
  const first = new Map<string, number>();
  for (const b of buys) {
    if (b.rank > maxRank || !smartSet.has(b.wallet) || b.tsMs === null) continue;
    const cur = first.get(b.mint);
    if (cur === undefined || b.tsMs < cur) first.set(b.mint, b.tsMs);
  }
  const H = 3_600_000;
  const det: number[] = [];
  const x2: number[] = [];
  const x3: number[] = [];
  const peak: number[] = [];
  const yc: number[] = [];
  let n = 0;
  for (const t of tokens) {
    const buy = first.get(t.mint);
    if (buy === undefined) continue;
    n++;
    det.push((t.detectedMs - buy) / H);
    if (t.hoursToX2 !== null) x2.push((t.detectedMs + t.hoursToX2 * H - buy) / H);
    if (t.hoursToX3 !== null) x3.push((t.detectedMs + t.hoursToX3 * H - buy) / H);
    const p = peakMs.get(t.mint);
    if (p !== undefined) peak.push((p - buy) / H);
    const y = youngCalmMs.get(t.mint);
    if (y !== undefined) yc.push((y - buy) / H);
  }
  const pct = (k: number, d: number): number | null => (d > 0 ? round((100 * k) / d, 1) : null);
  return {
    tokens: n,
    buy_to_detection: delayStat(det),
    pct_bought_before_detection: pct(det.filter((d) => d >= 0).length, n),
    buy_to_x2: delayStat(x2),
    buy_to_x3: delayStat(x3),
    buy_to_candle_peak: delayStat(peak),
    buy_to_young_calm: delayStat(yc),
    pct_with_young_calm: pct(yc.length, n),
    pct_bought_before_young_calm: pct(yc.filter((d) => d >= 0).length, yc.length),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Full study

export interface WalletStudyInput {
  tokens: readonly StudyToken[];
  buys: readonly EarlyBuy[];
  /** mint → time (ms) of the candle peak (candlePeakMs). */
  peakMs?: ReadonlyMap<string, number>;
  /** mint → « Jeune calme » detection time (ms). */
  youngCalmMs?: ReadonlyMap<string, number>;
}

export interface WalletStudyOptions {
  seed?: number;
  resamples?: number;
  robustnessDraws?: number;
}

export interface BTable {
  smart_ge1: GroupMetrics;
  smart_ge2: GroupMetrics;
  none: GroupMetrics;
  control: GroupMetrics;
  /** Informative: ≥ 1 smart wallet whose buy precedes detected_at (the only case usable live at detection). */
  smart_ge1_bought_before_detection: GroupMetrics;
  diff_vs_control: { mean_gain_pct: number | null; ci95: [number, number] | null };
}

const iso = (ms: number | undefined): string | null => (ms === undefined ? null : new Date(ms).toISOString());

/** Runs the whole pre-registered protocol. Deterministic for a given input and seed. */
export function runWalletStudy(input: WalletStudyInput, opts: WalletStudyOptions = {}) {
  const seed = opts.seed ?? STUDY_SEED;
  const resamples = opts.resamples ?? BOOTSTRAP_RESAMPLES;
  const draws = opts.robustnessDraws ?? CONTROL_ROBUSTNESS_DRAWS;
  const peakMs = input.peakMs ?? new Map<string, number>();
  const youngCalmMs = input.youngCalmMs ?? new Map<string, number>();

  // Tokens with at least one valid early buyer row.
  const buyMints = new Set(input.buys.filter((b) => b.rank <= EARLY_MAX_RANK).map((b) => b.mint));
  const uniq = new Map<string, StudyToken>();
  for (const t of input.tokens) if (!uniq.has(t.mint)) uniq.set(t.mint, t);
  const withBuyers = [...uniq.values()].filter((t) => buyMints.has(t.mint));
  const { a, b } = chronologicalSplit(withBuyers);

  // Wallets — A only.
  const aMints = new Set(a.map((t) => t.mint));
  const broad = broadWallets(input.buys, aMints);
  const walletsA = walletTokens(input.buys, aMints, broad);
  const { baseRate, smart } = selectSmartWallets(a, walletsA);
  const smartSet = new Set(smart.map((s) => s.wallet));
  const control = sampleControlWallets(walletsA, smart, seededRng(seed));
  const controlSet = new Set(control.wallets);

  // B groups.
  const bMints = new Set(b.map((t) => t.mint));
  const bBuys = input.buys.filter((x) => bMints.has(x.mint));
  const smartHits = walletHitsPerMint(bBuys, smartSet);
  const controlHits = walletHitsPerMint(bBuys, controlSet);
  const firstSmartBuy = new Map<string, number>();
  for (const x of bBuys) {
    if (x.rank > EARLY_MAX_RANK || !smartSet.has(x.wallet) || x.tsMs === null) continue;
    const cur = firstSmartBuy.get(x.mint);
    if (cur === undefined || x.tsMs < cur) firstSmartBuy.set(x.mint, x.tsMs);
  }

  const table = (tokens: readonly StudyToken[], k: number): BTable => {
    // One independent rng stream per (sub-table, group): results do not depend on evaluation order.
    const r = (j: number) => seededRng(seed + 1000 * k + j);
    const ge1 = tokens.filter((t) => (smartHits.get(t.mint) ?? 0) >= 1);
    const ge2 = tokens.filter((t) => (smartHits.get(t.mint) ?? 0) >= 2);
    const none = tokens.filter((t) => (smartHits.get(t.mint) ?? 0) === 0);
    const ctl = tokens.filter((t) => (controlHits.get(t.mint) ?? 0) >= 1);
    const before = ge1.filter((t) => (firstSmartBuy.get(t.mint) ?? Infinity) <= t.detectedMs);
    const g1 = groupMetrics(ge1, r(1), resamples);
    const gc = groupMetrics(ctl, r(4), resamples);
    const diffCi = bootstrapDiffCI(ge1.map(tradeGainPct), ctl.map(tradeGainPct), r(6), resamples);
    return {
      smart_ge1: g1,
      smart_ge2: groupMetrics(ge2, r(2), resamples),
      none: groupMetrics(none, r(3), resamples),
      control: gc,
      smart_ge1_bought_before_detection: groupMetrics(before, r(5), resamples),
      diff_vs_control: {
        mean_gain_pct: g1.mean_gain_pct !== null && gc.mean_gain_pct !== null ? round(g1.mean_gain_pct - gc.mean_gain_pct) : null,
        ci95: diffCi ? [round(diffCi[0]), round(diffCi[1])] : null,
      },
    };
  };

  const bYoung = b.filter((t) => t.ageH !== null && t.ageH < YOUNG_MAX_AGE_H);
  const tAll = table(b, 1);
  const tYoung = table(bYoung, 2);

  // Robustness (informative): the control draw repeated with other seeds.
  const smartGains = b.filter((t) => (smartHits.get(t.mint) ?? 0) >= 1).map(tradeGainPct);
  const ctlMeans: number[] = [];
  let smartBetter = 0;
  for (let d = 1; d <= draws && smartGains.length > 0; d++) {
    const cs = new Set(sampleControlWallets(walletsA, smart, seededRng(seed + 100_000 + d)).wallets);
    const hits = walletHitsPerMint(bBuys, cs);
    const g = b.filter((t) => (hits.get(t.mint) ?? 0) >= 1).map(tradeGainPct);
    if (g.length === 0) continue;
    const m = mean(g);
    ctlMeans.push(m);
    if (mean(smartGains) > m) smartBetter++;
  }
  ctlMeans.sort((x, y) => x - y);

  return {
    protocol: {
      seed,
      split_a_fraction: SPLIT_A_FRACTION,
      broad_wallet_max_share_on_a: BROAD_WALLET_MAX_SHARE,
      early_max_rank: EARLY_MAX_RANK,
      smart_min_x3_tokens_on_a: SMART_MIN_X3_TOKENS,
      smart_min_lift_vs_base_x3_rate: SMART_MIN_LIFT,
      bootstrap_resamples: resamples,
      verdict_min_tokens: VERDICT_MIN_TOKENS,
      young_max_age_h: YOUNG_MAX_AGE_H,
      gain_rule:
        `entrée à la détection ; ×2 avant −30 % → ${GAIN_X2_PCT} % ; −30 % avant ×2 → ${GAIN_SL_PCT} % ; ` +
        `ni l'un ni l'autre → ${GAIN_NEITHER_PCT} % (frais ${FEES_PCT} %, pas de mark-to-max)`,
      notes: [
        'Tokens sans ligne early_buyers exclus (indiscernables de « aucun smart wallet »).',
        'Wallets « larges » (> 30 % des tokens), smart wallets et contrôle calculés sur A uniquement.',
        "Écart vs contrôle : bootstrap indépendant des deux groupes (un token peut appartenir aux deux).",
        'Verdict sur B « tous » ; le tableau « jeunes » est informatif.',
        "« acheté avant détection » est informatif : seul ce cas est exploitable en direct au moment de la détection " +
          '(achats sans horodatage exclus de ce sous-groupe et des délais).',
      ],
    },
    n_tokens: {
      labelled: uniq.size,
      with_early_buyers: withBuyers.length,
      excluded_no_early_buyers: uniq.size - withBuyers.length,
      a: a.length,
      b: b.length,
      b_young: bYoung.length,
      b_age_unknown: b.filter((t) => t.ageH === null).length,
    },
    split: {
      a_from: iso(a[0]?.detectedMs),
      a_to: iso(a[a.length - 1]?.detectedMs),
      b_from: iso(b[0]?.detectedMs),
      b_to: iso(b[b.length - 1]?.detectedMs),
    },
    wallets: {
      a_wallets_after_exclusion: walletsA.size,
      broad_excluded: broad.size,
      base_x3_rate_a: baseRate === null ? null : round(baseRate, 4),
      n_smart: smart.length,
      smart: smart.map((s) => ({ ...s, x3_rate: round(s.x3_rate, 3) })),
      control: { n: control.wallets.length, exact_activity_match: control.exact, nearest_activity_fallback: control.fallback, unmatched: control.unmatched },
    },
    b_table: { all: tAll, young: tYoung },
    control_robustness: {
      draws: ctlMeans.length,
      control_mean_gain_pct_median: ctlMeans.length > 0 ? round(percentile(ctlMeans, 0.5)) : null,
      control_mean_gain_pct_p05_p95: ctlMeans.length > 0 ? [round(percentile(ctlMeans, 0.05)), round(percentile(ctlMeans, 0.95))] : null,
      pct_draws_smart_better: ctlMeans.length > 0 ? round((100 * smartBetter) / ctlMeans.length, 1) : null,
    },
    delays: {
      b: smartDelays(b, bBuys, smartSet, peakMs, youngCalmMs),
      a_in_sample: smartDelays(a, input.buys.filter((x) => aMints.has(x.mint)), smartSet, peakMs, youngCalmMs),
      measurable:
        'achat → détection, → 1er ×2 / ×3 (hours_to_x2 / hours_to_x3), → plus haut des bougies stockées (fenêtre ' +
        'détection → +72 h, pas le pic 7 j), → détection « Jeune calme » (preset_signals). Le pic 7 j exact ' +
        "(max_multiple_7d) n'est pas horodaté.",
    },
    verdict: walletStudyVerdict(tAll.smart_ge1, tAll.control, tAll.diff_vs_control.ci95),
    verdict_young_informative: walletStudyVerdict(tYoung.smart_ge1, tYoung.control, tYoung.diff_vs_control.ci95),
  };
}

export type WalletStudyReport = ReturnType<typeof runWalletStudy>;
