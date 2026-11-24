// Feature computation for the « ×3 minimum » model (feat/x3-model).
// Pure, deterministic functions: no I/O, no Date.now(), no randomness. Documented in docs/MODEL.md.
import type { ZoneSource, ZoneStatus } from './types';
import { FEATURE_NAMES, type FeatureName, type FeatureVector } from './x3-types';

const HOUR_MS = 3_600_000;

/** Tolerance around `now − windowH` when picking the reference holder snapshot (fraction of the window). */
export const HOLDER_WINDOW_TOLERANCE = 0.3;

/** A timestamp as epoch milliseconds or an ISO string (as read from Postgres). */
export type Instant = number | string;

function toMs(at: Instant): number | null {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

function finiteOrNull(x: number | null | undefined): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

function clamp(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, x));
}

// ---------------------------------------------------------------------------------------------------------------
// Holder growth

export interface HolderPoint {
  holders: number | null;
  at: Instant;
}

/**
 * Relative holder growth over `windowH` hours: now.holders / ref.holders − 1 (0.1 = +10 %).
 * ref = the history snapshot (strictly before now) closest to now − windowH, accepted only within
 * ±30 % of the window (e.g. 1 h → between 42 and 78 min ago). Ties: the older snapshot wins.
 * null when no snapshot qualifies, or when either holder count is unknown, not finite or ≤ 0.
 */
export function holderGrowth(now: HolderPoint, history: readonly HolderPoint[], windowH: number): number | null {
  const nowMs = toMs(now.at);
  const nowHolders = finiteOrNull(now.holders);
  if (nowMs === null || nowHolders === null || nowHolders <= 0) return null;
  if (!Number.isFinite(windowH) || windowH <= 0) return null;
  const target = nowMs - windowH * HOUR_MS;
  const tolerance = windowH * HOLDER_WINDOW_TOLERANCE * HOUR_MS;
  let best: { holders: number | null; dist: number; ms: number } | null = null;
  for (const p of history) {
    const ms = toMs(p.at);
    if (ms === null || ms >= nowMs) continue;
    const dist = Math.abs(ms - target);
    if (dist > tolerance) continue;
    if (best === null || dist < best.dist || (dist === best.dist && ms < best.ms)) {
      best = { holders: finiteOrNull(p.holders), dist, ms };
    }
  }
  if (best === null || best.holders === null || best.holders <= 0) return null;
  return nowHolders / best.holders - 1;
}

/**
 * Holder growth from a Jupiter `statsXh.holderChange` (PERCENT, point in time: known at the scan) → fraction
 * (50 → 0.5). null when missing, non-finite or ≤ −100 % (a count cannot drop below zero). Fallback of holderGrowth()
 * at a first detection, when the scan has no holder history of the mint yet (feat/calm-sl-test).
 */
export function holderGrowthFromJup(holderChangePct: number | null | undefined): number | null {
  const v = finiteOrNull(holderChangePct);
  if (v === null || v <= -100) return null;
  return v / 100;
}

// ---------------------------------------------------------------------------------------------------------------
// Volume / trades

/** vol1h / (vol24h / 24): 1 = the last hour traded at the 24 h average pace. null if an input is invalid or vol24h ≤ 0. */
export function volumeAccel(vol1h: number | null, vol24h: number | null): number | null {
  const v1 = finiteOrNull(vol1h);
  const v24 = finiteOrNull(vol24h);
  if (v1 === null || v24 === null || v24 <= 0 || v1 < 0) return null;
  return v1 / (v24 / 24);
}

/** Average trade size over the last hour, USD. null if txns1h ≤ 0 or an input is invalid. */
export function avgTradeSizeUsd(vol1h: number | null, txns1h: number | null): number | null {
  const v = finiteOrNull(vol1h);
  const n = finiteOrNull(txns1h);
  if (v === null || n === null || n <= 0 || v < 0) return null;
  return v / n;
}

// ---------------------------------------------------------------------------------------------------------------
// Migration pump.fun → PumpSwap / Raydium

export interface DexPoint {
  dexId: string;
  at: Instant;
}

/**
 * true when the token was seen on the pump.fun bonding curve (`dexId === 'pumpfun'`) during the last 24 h
 * (at in [now − 24 h, now]) and its current best pair is on PumpSwap (`'pumpswap'`) or Raydium (dexId contains
 * `'raydium'`). Comparisons are case-insensitive.
 */
export function migratedRecently(dexHistory: readonly DexPoint[], currentDexId: string, nowMs: number): boolean {
  const current = String(currentDexId).toLowerCase();
  if (current !== 'pumpswap' && !current.includes('raydium')) return false;
  if (!Number.isFinite(nowMs)) return false;
  const since = nowMs - 24 * HOUR_MS;
  return dexHistory.some((p) => {
    const ms = toMs(p.at);
    return ms !== null && ms >= since && ms <= nowMs && String(p.dexId).toLowerCase() === 'pumpfun';
  });
}

/** pump.fun mints end with this suffix (vanity addresses ground by the launchpad). */
export const PUMP_FUN_MINT_SUFFIX = 'pump';

export interface MigrationInput {
  dexHistory: readonly DexPoint[];
  /** Dex of the current best pair (DexScreener dexId). Unknown → null result. */
  currentDexId: string | null | undefined;
  mint: string;
  /** Age of the current best pair at `nowMs`, hours (null = unknown). */
  pairAgeHours: number | null | undefined;
  nowMs: number;
}

/**
 * migrated_recently known at the scan (feat/calm-sl-test), without needing the mint's own history:
 * - current dex unknown → null; not PumpSwap and not Raydium → false (definition: the current pair must be one of them);
 * - pumpfun seen in the scan history over the last 24 h → true (migratedRecently, the original rule);
 * - PumpSwap: a pump.fun mint (…pump) → its PumpSwap pool IS the migration pool, so pair age < 24 h ⇔ migrated in the
 *   last 24 h (unknown age → null); any other mint never was on the bonding curve → false;
 * - Raydium: not a pump.fun mint → false; a pump.fun mint without history → null (the Raydium pool may be a later
 *   pool, not the migration), with history but no pumpfun in it → false.
 * Inputs are point-in-time (dex, mint, pair creation date): no look-ahead.
 */
export function migratedAtDetection(input: MigrationInput): boolean | null {
  const current = typeof input.currentDexId === 'string' ? input.currentDexId.toLowerCase() : '';
  if (current === '') return null;
  const isPumpswap = current === 'pumpswap';
  if (!isPumpswap && !current.includes('raydium')) return false;
  const history = Array.isArray(input.dexHistory) ? input.dexHistory : [];
  if (history.length > 0 && migratedRecently(history, current, input.nowMs)) return true;
  const pumpMint = typeof input.mint === 'string' && input.mint.endsWith(PUMP_FUN_MINT_SUFFIX);
  if (!pumpMint) return false;
  if (isPumpswap) {
    const age = finiteOrNull(input.pairAgeHours);
    return age === null || age < 0 ? null : age < 24;
  }
  return history.length > 0 ? false : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Narratives

export interface NarrativeRule {
  narrative: string;
  /** Whole-word keywords (token of the normalised text must be exactly equal). Used for short / ambiguous words. */
  words: readonly string[];
  /** Substring keywords, searched in the concatenation of all normalised words (≥ 4 letters, unambiguous). */
  substrings: readonly string[];
}

/**
 * Keyword table, in priority order: the FIRST matching narrative wins
 * (GTA > AI > POLITICS > DOG > CAT > FROG, e.g. « Trump Pepe » → POLITICS).
 */
export const NARRATIVE_RULES: readonly NarrativeRule[] = [
  {
    narrative: 'GTA',
    words: ['gta', 'vi', 'vice', 'jason', 'lucia', 'wasted'],
    substrings: ['leonida', 'bawsaq', 'rockstar', 'grandtheft'],
  },
  {
    narrative: 'AI',
    words: ['ai', 'agi', 'gpt', 'llm', 'agent', 'agents'],
    substrings: ['deepseek', 'neural', 'chatgpt', 'openai'],
  },
  {
    narrative: 'POLITICS',
    words: ['trump', 'maga', 'elon', 'musk', 'biden', 'kamala', 'melania', 'barron'],
    substrings: ['trump', 'donald'],
  },
  {
    narrative: 'DOG',
    words: ['dog', 'dogs', 'inu', 'doge', 'shib', 'wif', 'puppy'],
    substrings: ['doge', 'shiba', 'bonk'],
  },
  {
    narrative: 'CAT',
    words: ['cat', 'cats', 'mew', 'kitty', 'meow'],
    substrings: ['kitty', 'kitten', 'meow', 'popcat'],
  },
  {
    narrative: 'FROG',
    words: ['frog', 'pepe'],
    substrings: ['pepe', 'frog'],
  },
];

/** Max code units read from each of name and symbol (hostile input). */
export const NARRATIVE_MAX_INPUT = 64;

/**
 * Normalises hostile text into lowercase ASCII words: length cap, NFKD (fullwidth → ASCII, accents split),
 * combining marks removed, camelCase and letter/digit boundaries split, everything non [a-z0-9] is a separator.
 * Only fixed regexes are used: the input is never interpreted as a pattern.
 */
export function narrativeWords(text: string): string[] {
  const capped = String(text).slice(0, NARRATIVE_MAX_INPUT);
  const ascii = capped.normalize('NFKD').replace(/\p{M}+/gu, '');
  const split = ascii
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .toLowerCase();
  return split.split(/[^a-z0-9]+/).filter((w) => w.length > 0);
}

/** Narrative group of a token from its name and symbol, or null. See NARRATIVE_RULES. */
export function narrativeOf(name: string, symbol: string): string | null {
  const words = [...narrativeWords(name ?? ''), ...narrativeWords(symbol ?? '')];
  if (words.length === 0) return null;
  const wordSet = new Set(words);
  const joined = words.join('');
  for (const rule of NARRATIVE_RULES) {
    if (rule.words.some((w) => wordSet.has(w))) return rule.narrative;
    if (rule.substrings.some((s) => joined.includes(s))) return rule.narrative;
  }
  return null;
}

export interface NarrativeToken {
  mint: string;
  name: string;
  symbol: string;
  marketCap: number | null;
}

export interface NarrativeRank {
  narrative: string;
  /** 1 = largest market cap in the group. */
  rank: number;
  size: number;
}

/**
 * Rank of each token inside its narrative group by market cap (descending; unknown / invalid MC ranks last;
 * ties broken by mint for determinism). Tokens without a narrative are absent from the map. Duplicate mints:
 * the first occurrence is kept.
 */
export function narrativeRanks(tokens: readonly NarrativeToken[]): Map<string, NarrativeRank> {
  const groups = new Map<string, { mint: string; mc: number }[]>();
  const seen = new Set<string>();
  for (const t of tokens) {
    if (seen.has(t.mint)) continue;
    seen.add(t.mint);
    const narrative = narrativeOf(t.name, t.symbol);
    if (narrative === null) continue;
    const mc = finiteOrNull(t.marketCap);
    const list = groups.get(narrative) ?? [];
    list.push({ mint: t.mint, mc: mc !== null && mc > 0 ? mc : -1 });
    groups.set(narrative, list);
  }
  const out = new Map<string, NarrativeRank>();
  for (const [narrative, list] of groups) {
    list.sort((a, b) => b.mc - a.mc || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
    list.forEach((t, i) => out.set(t.mint, { narrative, rank: i + 1, size: list.length }));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Feature vector

/** Raw inputs for one token at detection time. null / undefined = unknown. */
export interface FeatureInput {
  score?: number | null;
  marketCap?: number | null;
  liquidityEffUsd?: number | null;
  roundtripCostPct?: number | null;
  zoneStatus?: ZoneStatus | null;
  zoneSource?: ZoneSource | null;
  change1h?: number | null;
  change6h?: number | null;
  change24h?: number | null;
  buys1h?: number | null;
  sells1h?: number | null;
  ageHours?: number | null;
  /** From holderGrowth(…, 1) / holderGrowth(…, 6). */
  holderGrowth1h?: number | null;
  holderGrowth6h?: number | null;
  vol1h?: number | null;
  vol24h?: number | null;
  txns1h?: number | null;
  migratedRecently?: boolean | null;
  /** From narrativeRanks(): object = in a group; null = computed, no group (→ 0 / 0); undefined = unknown. */
  narrative?: { rank: number; size: number } | null;
  organicScore?: number | null;
  rugInsiders?: boolean | null;
  rugCreatorBad?: boolean | null;
  lpLockedPct?: number | null;
  solChange24h?: number | null;
  /** Total 24 h volume of the scanned tokens, USD. */
  scanVolume24h?: number | null;
}

/** Clamp bounds applied to each feature (after the log transform where there is one). Documented in docs/MODEL.md. */
export const FEATURE_CLAMPS: Readonly<Record<FeatureName, readonly [number, number]>> = {
  score: [0, 100],
  log_mc: [0, 30],
  log_liq_eff: [0, 30],
  liq_mc_ratio: [0, 5],
  roundtrip_cost_pct: [0, 100],
  zone_in: [0, 1],
  zone_wait: [0, 1],
  zone_deep: [0, 1],
  zone_broken: [0, 1],
  zone_from_candles: [0, 1],
  change_1h: [-100, 1000],
  change_6h: [-100, 1000],
  change_24h: [-100, 1000],
  buy_sell_ratio_1h: [0, 20],
  log_age_h: [0, 12],
  holder_growth_1h: [-1, 10],
  holder_growth_6h: [-1, 10],
  volume_accel: [0, 50],
  migrated_recently: [0, 1],
  narrative_rank: [0, 1000],
  narrative_size: [0, 1000],
  organic_score: [0, 100],
  log_avg_trade_usd: [0, 20],
  rug_insiders: [0, 1],
  rug_creator_bad: [0, 1],
  lp_locked_pct: [0, 100],
  sol_change_24h: [-100, 1000],
  log_scan_volume_24h: [0, 40],
};

/** ln(1 + x) for x ≥ 0, else null. */
function log1pNonNeg(x: number | null): number | null {
  return x !== null && x >= 0 ? Math.log1p(x) : null;
}

function bool01(b: boolean | null | undefined): number | null {
  return typeof b === 'boolean' ? (b ? 1 : 0) : null;
}

/**
 * Builds the model input. Unknown → null (imputed by the model with the training mean). Non-finite → null.
 * Every non-null value is clamped to FEATURE_CLAMPS. Log features use ln(1 + x) (x < 0 → null).
 */
export function buildFeatureVector(input: FeatureInput): FeatureVector {
  const f = (x: number | null | undefined) => finiteOrNull(x);
  const mc = f(input.marketCap);
  const liq = f(input.liquidityEffUsd);
  const buys = f(input.buys1h);
  const sells = f(input.sells1h);
  const zone = input.zoneStatus ?? null;
  const zoneOneHot = (s: ZoneStatus) => (zone === null ? null : zone === s ? 1 : 0);
  const narrative = input.narrative;

  const raw: FeatureVector = {
    score: f(input.score),
    log_mc: log1pNonNeg(mc),
    log_liq_eff: log1pNonNeg(liq),
    liq_mc_ratio: liq !== null && mc !== null && mc > 0 && liq >= 0 ? liq / mc : null,
    roundtrip_cost_pct: f(input.roundtripCostPct),
    zone_in: zoneOneHot('in'),
    zone_wait: zoneOneHot('wait'),
    zone_deep: zoneOneHot('deep'),
    zone_broken: zoneOneHot('broken'),
    zone_from_candles: input.zoneSource ? (input.zoneSource === 'candles' ? 1 : 0) : null,
    change_1h: f(input.change1h),
    change_6h: f(input.change6h),
    change_24h: f(input.change24h),
    buy_sell_ratio_1h: buys !== null && sells !== null && buys >= 0 && sells >= 0 ? (buys + 1) / (sells + 1) : null,
    log_age_h: log1pNonNeg(f(input.ageHours)),
    holder_growth_1h: f(input.holderGrowth1h),
    holder_growth_6h: f(input.holderGrowth6h),
    volume_accel: volumeAccel(f(input.vol1h), f(input.vol24h)),
    migrated_recently: bool01(input.migratedRecently),
    narrative_rank: narrative === undefined ? null : narrative === null ? 0 : f(narrative.rank),
    narrative_size: narrative === undefined ? null : narrative === null ? 0 : f(narrative.size),
    organic_score: f(input.organicScore),
    log_avg_trade_usd: log1pNonNeg(avgTradeSizeUsd(f(input.vol1h), f(input.txns1h))),
    rug_insiders: bool01(input.rugInsiders),
    rug_creator_bad: bool01(input.rugCreatorBad),
    lp_locked_pct: f(input.lpLockedPct),
    sol_change_24h: f(input.solChange24h),
    log_scan_volume_24h: log1pNonNeg(f(input.scanVolume24h)),
  };

  const out = {} as FeatureVector;
  for (const name of FEATURE_NAMES) {
    const v = raw[name];
    const [lo, hi] = FEATURE_CLAMPS[name];
    out[name] = v === null || !Number.isFinite(v) ? null : clamp(v, lo, hi);
  }
  return out;
}
