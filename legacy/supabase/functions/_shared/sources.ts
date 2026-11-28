// Pure helpers for multi-source candidate collection — no Deno or network APIs.
// The scan collects candidate mints from several upstream lists (DexScreener,
// GeckoTerminal, Jupiter, pump.fun migrations), merges them here, and keeps
// per-source counters so we can measure which source actually brings signals.

import { isSolanaAddress } from './solana.ts';

/**
 * Active source identifiers (chore/slim-down). Order is canonical (used for display and storage). The removed sources
 * ('gecko_trending', 'gecko_volume', 'jup_trending_1h' / '_6h', 'jup_organic_1h' / '_6h', 'jup_traded_1h' / '_6h')
 * stay allowlisted by the tokens_sources_check CHECK for the stored history, but are never produced any more.
 */
export const SOURCE_NAMES = [
  'dex_profiles',
  'dex_boosts_latest',
  'dex_boosts_top',
  'dex_cto',
  'dex_search',
  'gecko_trending_1h',
  'gecko_pumpswap',
  'gecko_new_pools',
  'jup_recent',
  'migration',
  'young_watch',
] as const;

export type SourceName = (typeof SOURCE_NAMES)[number];

/** Default maximum number of distinct mints accepted from a single source. */
export const DEFAULT_CAP_PER_SOURCE = 100;

/** Maximum number of entries written to tokens.sources. */
export const MAX_SOURCES_COLUMN = 10;

/** Sources that get priority when the enrichment budget is exceeded. */
const PRIORITY_SOURCES: ReadonlySet<SourceName> = new Set<SourceName>([
  'migration',
  // Young-token sources (pairs < 24 h) are not cut by the budget before the DexScreener lists.
  'gecko_trending_1h',
  'gecko_pumpswap',
  'gecko_new_pools',
  'jup_recent',
  'young_watch',
]);

/**
 * Active source names accepted by the tokens.sources CHECK before migration 20261121020000_slim_down.sql. scan-tokens
 * retries its upsert with only these names if the database rejects the new ones (function deployed first).
 */
export const LEGACY_SOURCE_NAMES: ReadonlySet<SourceName> = new Set<SourceName>([
  'dex_profiles',
  'dex_boosts_latest',
  'dex_boosts_top',
  'dex_cto',
  'dex_search',
  'gecko_trending_1h',
  'gecko_pumpswap',
  'migration',
  'young_watch',
]);

const SOURCE_SET: ReadonlySet<string> = new Set<string>(SOURCE_NAMES);
const SOURCE_ORDER: ReadonlyMap<string, number> = new Map(SOURCE_NAMES.map((s, i) => [s, i]));

export function isSourceName(x: unknown): x is SourceName {
  return typeof x === 'string' && SOURCE_SET.has(x);
}

/** Dedups, drops non-allowlisted entries and sorts in SOURCE_NAMES order. */
function canonicalSources(sources: readonly unknown[]): SourceName[] {
  const set = new Set<SourceName>();
  for (const s of sources) if (isSourceName(s)) set.add(s);
  return [...set].sort((a, b) => (SOURCE_ORDER.get(a) ?? 0) - (SOURCE_ORDER.get(b) ?? 0));
}

function normalizeCap(cap: number | undefined): number {
  if (cap === undefined || Number.isNaN(cap)) return DEFAULT_CAP_PER_SOURCE;
  if (cap === Infinity) return Infinity;
  return Math.max(0, Math.floor(cap));
}

/**
 * Merges candidate lists into mint -> sources.
 * - Only valid Solana mints are kept (hostile/invalid strings are dropped).
 * - Lists with a non-allowlisted source are ignored.
 * - Dedup within and across lists; each mint's sources are in SOURCE_NAMES order.
 * - Map insertion order = first time a mint is seen (stable, deterministic).
 * - capPerSource (default 100) limits the distinct valid mints attributed to a
 *   source name, even if that source appears in several lists. The first mints
 *   of each list win.
 */
export function mergeSources(
  lists: readonly { source: SourceName; mints: readonly string[] }[],
  opts?: { capPerSource?: number },
): Map<string, SourceName[]> {
  const cap = normalizeCap(opts?.capPerSource);
  const merged = new Map<string, SourceName[]>();
  const perSource = new Map<SourceName, Set<string>>();

  for (const list of lists) {
    if (!list || !isSourceName(list.source) || !Array.isArray(list.mints)) continue;
    const source = list.source;
    let taken = perSource.get(source);
    if (!taken) {
      taken = new Set<string>();
      perSource.set(source, taken);
    }
    for (const mint of list.mints) {
      if (taken.size >= cap) break;
      if (!isSolanaAddress(mint) || taken.has(mint)) continue;
      taken.add(mint);
      const existing = merged.get(mint);
      if (existing) {
        if (!existing.includes(source)) {
          existing.push(source);
          existing.sort((a, b) => (SOURCE_ORDER.get(a) ?? 0) - (SOURCE_ORDER.get(b) ?? 0));
        }
      } else {
        merged.set(mint, [source]);
      }
    }
  }
  return merged;
}

/**
 * Mints that graduated from pump.fun since the previous scan: previous dexId is
 * exactly 'pumpfun' and current dexId is 'pumpswap' or contains 'raydium'
 * (current side compared case-insensitively). Invalid mints are ignored.
 * Returns a sorted, deduplicated list.
 */
export function detectMigrations(
  prev: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): string[] {
  const out: string[] = [];
  for (const [mint, curDex] of current) {
    if (!isSolanaAddress(mint) || typeof curDex !== 'string') continue;
    if (prev.get(mint) !== 'pumpfun') continue;
    const cur = curDex.toLowerCase();
    if (cur === 'pumpswap' || cur.includes('raydium')) out.push(mint);
  }
  return out.sort();
}

export interface SourceCount {
  /** Mints listing this source. */
  seen: number;
  /** Of those, mints present in keptMints. */
  kept: number;
  /** Mints brought ONLY by this source. */
  unique: number;
  /** Of the unique ones, mints present in keptMints. */
  uniqueKept: number;
  /** fix/young-sources (only when youngMints is given): mints of this source with a pair < 24 h (best pair). */
  young?: number;
  /** Of those, mints present in keptMints. */
  youngKept?: number;
}

/** Per-source counters; every SOURCE_NAMES key is present (zeros by default). young / youngKept only with youngMints. */
export function countBySource(
  merged: ReadonlyMap<string, readonly SourceName[]>,
  keptMints: ReadonlySet<string>,
  youngMints?: ReadonlySet<string>,
): Record<SourceName, SourceCount> {
  const out = {} as Record<SourceName, SourceCount>;
  for (const s of SOURCE_NAMES) {
    out[s] = youngMints
      ? { seen: 0, kept: 0, unique: 0, uniqueKept: 0, young: 0, youngKept: 0 }
      : { seen: 0, kept: 0, unique: 0, uniqueKept: 0 };
  }
  for (const [mint, rawSources] of merged) {
    const sources = canonicalSources(rawSources);
    const kept = keptMints.has(mint);
    const unique = sources.length === 1;
    const young = youngMints?.has(mint) ?? false;
    for (const s of sources) {
      const c = out[s];
      c.seen++;
      if (kept) c.kept++;
      if (unique) {
        c.unique++;
        if (kept) c.uniqueKept++;
      }
      if (young && c.young !== undefined && c.youngKept !== undefined) {
        c.young++;
        if (kept) c.youngKept++;
      }
    }
  }
  return out;
}

/**
 * Applies the enrichment budget.
 * - Within budget: all mints, in insertion order.
 * - Over budget: sorted by (distinct allowlisted source count desc, has
 *   'migration' or a young-token source desc, insertion order asc), then truncated.
 *   The returned order is the priority order.
 * - maxMints <= 0 or NaN -> [].
 */
export function prioritizeMints(
  merged: ReadonlyMap<string, readonly SourceName[]>,
  maxMints: number,
): string[] {
  const mints = [...merged.keys()];
  if (Number.isNaN(maxMints) || maxMints <= 0) return [];
  const budget = maxMints === Infinity ? Infinity : Math.floor(maxMints);
  if (budget <= 0) return [];
  if (mints.length <= budget) return mints;

  const ranked = mints.map((mint, index) => {
    const sources = canonicalSources(merged.get(mint) ?? []);
    return {
      mint,
      index,
      count: sources.length,
      priority: sources.some((s) => PRIORITY_SOURCES.has(s)) ? 1 : 0,
    };
  });
  ranked.sort((a, b) => b.count - a.count || b.priority - a.priority || a.index - b.index);
  return ranked.slice(0, budget).map((r) => r.mint);
}

// ---------------------------------------------------------------------------------------------------------
// Age quota of the kept set (fix/young-sources)
// ---------------------------------------------------------------------------------------------------------
// Goal: ≥ 40 % of the tokens kept by a scan have a pair younger than 24 h. Measured 21/11 (3 dry runs): the toplists
// (removed by chore/slim-down) brought ~155 tokens per scan that passed the filters, ~83 % of them older than 7 days,
// and only ~15–22 young tokens pass MIN_LIQUIDITY / MIN_MARKET_CAP at any time. The share therefore comes from capping
// the OLD tokens. Young tokens are never dropped by the quota; old tokens (≥ 24 h or unknown age) keep the best-ranked
// slots (1 h volume, then liquidity: final-score.ts rankByActivity), and tracked mints (open alert positions, paper
// positions) are always kept. OLD_KEPT_MIN = 25 (the established tokens are not starved).

/** Target share of young tokens among the kept ones. */
export const YOUNG_SHARE_TARGET = 0.4;
/** Old tokens always allowed (alerts / presets on established tokens keep a stable top). */
export const OLD_KEPT_MIN = 25;
/** Old tokens never exceed this, whatever the young count. */
export const OLD_KEPT_MAX = 90;
/** Age limit of « young » (hours). */
export const YOUNG_MAX_AGE_HOURS = 24;

export function isYoungAge(ageHours: number | null | undefined): boolean {
  return typeof ageHours === 'number' && Number.isFinite(ageHours) && ageHours >= 0 && ageHours < YOUNG_MAX_AGE_HOURS;
}

/**
 * Old-token slots for a scan with `young` young tokens: enough to keep young / (young + old) ≥ target, clamped to
 * [OLD_KEPT_MIN, OLD_KEPT_MAX]. With few young tokens the floor wins (the share target is then missed on purpose:
 * the established tokens are not starved).
 */
export function oldKeptCap(
  young: number,
  opts: { target?: number; min?: number; max?: number } = {},
): number {
  const target = opts.target ?? YOUNG_SHARE_TARGET;
  const min = Math.max(0, Math.floor(opts.min ?? OLD_KEPT_MIN));
  const max = Math.max(min, Math.floor(opts.max ?? OLD_KEPT_MAX));
  const y = Number.isFinite(young) && young > 0 ? Math.floor(young) : 0;
  if (!(target > 0 && target < 1)) return max;
  const wanted = Math.floor((y * (1 - target)) / target + 1e-9);
  return Math.min(max, Math.max(min, wanted));
}

/**
 * Applies the age quota to `ranked` (best first: rankByActivity order). Kept, in the input order:
 * every young token, every forced mint, then old tokens while the old count (forced old included) is below `oldCap`.
 * Deterministic; the input is not mutated.
 */
export function applyAgeQuota<T extends { mint: string; ageHours: number | null }>(
  ranked: readonly T[],
  forced: ReadonlySet<string>,
  oldCap: number,
): { kept: T[]; dropped: T[] } {
  const cap = Number.isFinite(oldCap) ? Math.max(0, Math.floor(oldCap)) : oldCap === Infinity ? Infinity : 0;
  let old = 0;
  for (const t of ranked) if (!isYoungAge(t.ageHours) && forced.has(t.mint)) old++;
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const t of ranked) {
    if (isYoungAge(t.ageHours) || forced.has(t.mint)) kept.push(t);
    else if (old < cap) {
      old++;
      kept.push(t);
    } else dropped.push(t);
  }
  return { kept, dropped };
}

/** Value for tokens.sources: allowlisted, deduplicated, canonical order, at most 10 entries. */
export function sourcesColumn(sources: readonly SourceName[]): string[] {
  return canonicalSources(sources).slice(0, MAX_SOURCES_COLUMN);
}

/** tokens.sources limited to LEGACY_SOURCE_NAMES (upsert fallback while the slim_down migration is missing). */
export function legacySourcesColumn(sources: readonly string[]): string[] {
  return canonicalSources(sources).filter((s) => LEGACY_SOURCE_NAMES.has(s)).slice(0, MAX_SOURCES_COLUMN);
}
