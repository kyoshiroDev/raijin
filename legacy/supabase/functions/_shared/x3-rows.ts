// Pure row builders of the detections (signal_outcomes features, snapshot history, narrative) for scan-tokens and
// label-outcomes (feat/x3-model). No I/O, no Date.now(): every function takes `nowMs`. Values are bounded to the table
// CHECKs of 20261117060000_x3_model.sql (an out-of-range value becomes null rather than failing the write).
// Feature maths live in features.ts, labelling in outcomes.ts. chore/slim-down: the ×3 model (model.ts, p_x3 / p_dd50,
// model_weights) and the Fibonacci rr / zone were removed; features.score and the zone one-hots are null for new rows
// (the feature vector keeps its keys: signal_outcomes.features is read by the backtest).
import {
  buildFeatureVector,
  type DexPoint,
  type FeatureInput,
  holderGrowth,
  holderGrowthFromJup,
  type HolderPoint,
  migratedAtDetection,
  type NarrativeRank,
} from './features.ts';
import type { MarketContext } from './market-context.ts';
import type { ScanItem } from './normalize.ts';
import { sanitizeText } from './sanitize.ts';
import { isSolanaAddress } from './solana.ts';
import type { ZoneStatus } from './types.ts';
import type { FeatureVector, OutcomeLabel } from './x3-types.ts';

const HOUR_MS = 3_600_000;
/** Feature history read by scan-tokens (x3_snapshot_history): 24 h is enough for holder growth 1 h/6 h and migration. */
export const HISTORY_WINDOW_MS = 24 * HOUR_MS;
export const MAX_SAMPLES_PER_MINT = 200;
const ZONES: ReadonlySet<string> = new Set<ZoneStatus>(['in', 'wait', 'deep', 'broken', 'none']);

// ---------------------------------------------------------------------------------------------------------------
// Cells (PostgREST may return numeric as string)

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && v.length <= 64) {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  }
  return null;
}
const inRange = (v: number | null | undefined, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
const round = (v: number | null, digits: number): number | null => {
  if (v === null) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
function timeMs(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
/** DexScreener dex id within the signal_outcomes.entry_dex_id CHECK, else null. */
const dexId = (v: unknown): string | null => (typeof v === 'string' && /^[a-z0-9_-]{1,32}$/.test(v) ? v : null);
const zone = (v: unknown): ZoneStatus | null => (typeof v === 'string' && ZONES.has(v) ? (v as ZoneStatus) : null);

// ---------------------------------------------------------------------------------------------------------------
// Snapshot history (x3_snapshot_history rpc)

export interface HistorySample {
  /** epoch ms */
  t: number;
  price: number | null;
  holders: number | null;
  volume1h: number | null;
  txns1h: number | null;
  dex: string | null;
}

/** rpc rows [{ mint, samples: [{ t, price, holders, volume_1h, txns_1h, dex }] }] → map, validated item by item. */
export function parseHistoryRows(data: unknown): Map<string, HistorySample[]> {
  const out = new Map<string, HistorySample[]>();
  if (!Array.isArray(data)) return out;
  for (const row of data) {
    if (typeof row !== 'object' || row === null) continue;
    const { mint, samples } = row as { mint?: unknown; samples?: unknown };
    if (!isSolanaAddress(mint) || !Array.isArray(samples) || out.has(mint)) continue;
    const list: HistorySample[] = [];
    for (const s of samples.slice(-MAX_SAMPLES_PER_MINT)) {
      if (typeof s !== 'object' || s === null) continue;
      const o = s as Record<string, unknown>;
      const t = num(o.t);
      if (t === null || t <= 0) continue;
      const holders = num(o.holders);
      list.push({
        t,
        price: inRange(num(o.price), 0, 1e12),
        holders: holders !== null && holders >= 0 ? holders : null,
        volume1h: inRange(num(o.volume_1h), 0, 1e15),
        txns1h: inRange(num(o.txns_1h), 0, 1e9),
        dex: typeof o.dex === 'string' && o.dex.length > 0 ? o.dex.slice(0, 32) : null,
      });
    }
    out.set(mint, list.sort((a, b) => a.t - b.t));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Scan features

/** The part of a Jupiter audit the features read (structural: no zod import here). */
export interface AuditLike {
  holderCount?: number;
  organicScore?: number;
  /** Jupiter holder change over 1 h / 6 h, PERCENT (schemas.ts JupiterTokenSchema). */
  stats1h?: { holderChange?: number } | null;
  stats6h?: { holderChange?: number } | null;
}

/** RugCheck flags persisted by enrich-tokens (tokens.insiders_detected / creator_rug_history). */
export interface RugFlags {
  insiders: boolean | null;
  creatorBad: boolean | null;
}

export interface ScanFeatureContext {
  nowMs: number;
  history: ReadonlyMap<string, readonly HistorySample[]>;
  /** narrativeRanks() over the kept tokens of this scan (absent = no narrative group). */
  narratives: ReadonlyMap<string, NarrativeRank>;
  market: MarketContext;
  rug: ReadonlyMap<string, RugFlags>;
}

/**
 * Raw feature inputs of one flagged scan item (merged enrichment). No score / zone any more (null features).
 * feat/calm-sl-test (features empty at every first detection, because the mint had no snapshot history and no
 * enrichment yet): holder growth falls back to the Jupiter audit's holderChange (point in time), migrated_recently is
 * inferred from dex + mint + pair age (migratedAtDetection), and the round trip / LP lock come from the item itself,
 * which carries the detection probe of the scan for first detections (index.ts merges it before flagging).
 */
export function scanFeatureInput(item: ScanItem, audit: AuditLike | undefined, ctx: ScanFeatureContext): FeatureInput {
  const { t } = item;
  const history = ctx.history.get(t.mint) ?? [];
  const holdersNow = inRange(audit?.holderCount, 0, 1e12);
  const now: HolderPoint = { holders: holdersNow, at: ctx.nowMs };
  const holderHistory: HolderPoint[] = history.map((s) => ({ holders: s.holders, at: s.t }));
  const dexHistory: DexPoint[] = history.filter((s) => s.dex !== null).map((s) => ({ dexId: s.dex as string, at: s.t }));
  const rug = ctx.rug.get(t.mint);
  const organic = inRange(audit?.organicScore, 0, 100);
  return {
    score: null,
    marketCap: t.marketCap,
    liquidityEffUsd: item.liquidity,
    roundtripCostPct: t.roundtripCostPct,
    zoneStatus: null,
    zoneSource: null,
    change1h: t.change1h,
    change6h: t.change6h,
    change24h: t.change24h,
    buys1h: t.buys1h,
    sells1h: t.sells1h,
    ageHours: t.ageHours,
    holderGrowth1h: holderGrowth(now, holderHistory, 1) ?? holderGrowthFromJup(audit?.stats1h?.holderChange),
    holderGrowth6h: holderGrowth(now, holderHistory, 6) ?? holderGrowthFromJup(audit?.stats6h?.holderChange),
    vol1h: t.volume1h ?? null,
    vol24h: t.volume24h,
    txns1h: t.buys1h + t.sells1h,
    migratedRecently: migratedAtDetection({
      dexHistory,
      currentDexId: t.dexId,
      mint: t.mint,
      pairAgeHours: t.ageHours,
      nowMs: ctx.nowMs,
    }),
    narrative: ctx.narratives.get(t.mint) ?? null,
    organicScore: organic,
    rugInsiders: rug?.insiders ?? null,
    rugCreatorBad: rug?.creatorBad ?? null,
    lpLockedPct: t.lpLockedPct,
    solChange24h: ctx.market.solChange24h,
    scanVolume24h: ctx.market.scanVolume24h,
  };
}

export function scanFeatures(item: ScanItem, audit: AuditLike | undefined, ctx: ScanFeatureContext): FeatureVector {
  return buildFeatureVector(scanFeatureInput(item, audit, ctx));
}

// ---------------------------------------------------------------------------------------------------------------
// tokens / token_snapshots columns written by scan-tokens

/** Narrative + features columns merged into the scan-tokens upsert row (owned by scan-tokens). */
export function x3TokenColumns(features: FeatureVector, narrative: NarrativeRank | undefined) {
  const name = narrative ? sanitizeText(narrative.narrative, 24) : '';
  return {
    narrative: name || null,
    narrative_rank: name && narrative ? inRange(Math.round(narrative.rank), 0, 10_000) : null,
    features,
  };
}
export type X3TokenColumns = ReturnType<typeof x3TokenColumns>;

/** Base snapshot columns (score / zone_status archived: not written since chore/slim-down). */
export interface BaseSnapshot {
  mint: string;
  price_usd: number;
  market_cap: number;
  liquidity_usd: number;
  volume_24h: number;
}

/** Feature-history columns added to each snapshot (holders from the Jupiter audit when there was one). */
export function snapshotExtras(item: ScanItem, audit: AuditLike | undefined) {
  const { t } = item;
  const holders = inRange(audit?.holderCount, 0, 2_147_483_647);
  const txns = t.buys1h + t.sells1h;
  return {
    holder_count: holders === null ? null : Math.round(holders),
    volume_1h: inRange(t.volume1h ?? null, 0, 1e15 - 1),
    txns_1h: Number.isInteger(txns) ? inRange(txns, 0, 2_147_483_647) : null,
    dex_id: t.dexId ? t.dexId.slice(0, 32) : null,
    organic_score: inRange(audit?.organicScore, 0, 100),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// signal_outcomes rows

export interface OutcomeInsert {
  mint: string;
  pair_address: string;
  source: 'scan' | 'backfill';
  detected_at: string;
  entry_price: number;
  entry_mc: number | null;
  entry_liq_eff: number | null;
  entry_roundtrip_pct: number | null;
  /** Archived: null for scan rows since chore/slim-down (backfill rows keep the old snapshot value). */
  entry_score: number | null;
  /** Archived: null for scan rows since chore/slim-down (backfill rows keep the old snapshot value). */
  entry_zone: ZoneStatus | null;
  /** DEX of the pair at detection (Performance by DEX; column of 20261119010000). null = unknown. */
  entry_dex_id: string | null;
  features: FeatureVector;
}

/** First detection by scan-tokens: entry = current DexScreener price, features of this scan. null if unusable. */
export function outcomeRowFromScan(item: ScanItem, features: FeatureVector, nowMs: number): OutcomeInsert | null {
  const { t } = item;
  const price = inRange(t.priceUsd, Number.MIN_VALUE, 1e12 - 1);
  if (!isSolanaAddress(t.mint) || !isSolanaAddress(t.pairAddress) || price === null || !Number.isFinite(nowMs)) return null;
  return {
    mint: t.mint,
    pair_address: t.pairAddress,
    source: 'scan',
    detected_at: new Date(nowMs).toISOString(),
    entry_price: price,
    entry_mc: inRange(t.marketCap, 0, 1e15 - 1),
    entry_liq_eff: inRange(item.liquidity, 0, 1e13 - 1),
    entry_roundtrip_pct: inRange(t.roundtripCostPct, -100, 100),
    entry_score: null,
    entry_zone: null,
    entry_dex_id: dexId(t.dexId),
    features,
  };
}

/** One row of the x3_backfill_candidates rpc (token + its FIRST snapshot). */
export interface BackfillCandidate {
  mint: unknown;
  pair_address: unknown;
  pair_created_at?: unknown;
  insiders_detected?: unknown;
  creator_rug_history?: unknown;
  captured_at: unknown;
  price_usd: unknown;
  market_cap?: unknown;
  liquidity_usd?: unknown;
  volume_24h?: unknown;
  score?: unknown;
  zone_status?: unknown;
  holder_count?: unknown;
  volume_1h?: unknown;
  txns_1h?: unknown;
  organic_score?: unknown;
}

/**
 * Backfill (« rattrapage ») of a token detected before signal_outcomes existed: entry = price of its FIRST snapshot,
 * detected_at = its captured_at. Features: only what the snapshot / token row can tell (score, MC, liquidity, zone,
 * age at detection, 24 h volume, holders / 1 h volume / organic score when the snapshot has them, RugCheck flags);
 * everything else null (imputed by the model). The DexScreener liquidity of the snapshot stands in for the effective
 * liquidity (they are equal whenever GeckoTerminal is unknown, which is the case for most tokens). No prediction.
 */
export function backfillRow(c: BackfillCandidate, nowMs: number): OutcomeInsert | null {
  const detectedAt = timeMs(c.captured_at);
  const price = inRange(num(c.price_usd), Number.MIN_VALUE, 1e12 - 1);
  if (!isSolanaAddress(c.mint) || !isSolanaAddress(c.pair_address) || detectedAt === null || price === null) return null;
  if (!Number.isFinite(nowMs) || detectedAt > nowMs + 60_000) return null;
  const mc = inRange(num(c.market_cap), 0, 1e15 - 1);
  const liq = inRange(num(c.liquidity_usd), 0, 1e13 - 1);
  const scoreRaw = inRange(num(c.score), 0, 100);
  const createdAt = timeMs(c.pair_created_at);
  const ageHours = createdAt !== null && createdAt <= detectedAt ? (detectedAt - createdAt) / HOUR_MS : null;
  const z = zone(c.zone_status);
  const features = buildFeatureVector({
    score: scoreRaw,
    marketCap: mc,
    liquidityEffUsd: liq,
    zoneStatus: z,
    ageHours,
    vol1h: num(c.volume_1h),
    vol24h: num(c.volume_24h),
    txns1h: num(c.txns_1h),
    organicScore: inRange(num(c.organic_score), 0, 100),
    rugInsiders: bool(c.insiders_detected),
    rugCreatorBad: bool(c.creator_rug_history),
  });
  return {
    mint: c.mint,
    pair_address: c.pair_address,
    source: 'backfill',
    detected_at: new Date(detectedAt).toISOString(),
    entry_price: price,
    entry_mc: mc,
    entry_liq_eff: liq,
    entry_roundtrip_pct: null,
    entry_score: scoreRaw === null ? null : Math.round(scoreRaw),
    entry_zone: z,
    // Not in the rpc rows: performance_breakdown falls back to tokens.dex_id.
    entry_dex_id: null,
    features,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Labelling (label-outcomes)

export interface QueueItem {
  mint: string;
  pairAddress: string;
  detectedAtMs: number;
  entryPrice: number;
  attempts: number;
}

/** A pending signal_outcomes row read by label-outcomes → validated item, or null. */
export function parseQueueRow(row: unknown): QueueItem | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  const detectedAtMs = timeMs(r.detected_at);
  const entryPrice = num(r.entry_price);
  if (!isSolanaAddress(r.mint) || !isSolanaAddress(r.pair_address) || detectedAtMs === null) return null;
  if (entryPrice === null || !(entryPrice > 0)) return null;
  const attempts = num(r.label_attempts);
  return {
    mint: r.mint,
    pairAddress: r.pair_address,
    detectedAtMs,
    entryPrice,
    attempts: attempts !== null && attempts >= 0 ? Math.floor(attempts) : 0,
  };
}

const nextAttempts = (attempts: number): number => Math.min(10_000, Math.max(0, Math.floor(attempts)) + 1);

/** UPDATE payload after labelOutcome. Always carries every label (the « final » CHECK needs them all). */
export function labelUpdate(label: OutcomeLabel, attempts: number, nowMs: number) {
  const multiple = inRange(label.max_multiple_7d, 0, 1e9 - 1);
  const observed = inRange(label.observed_hours, 0, 744);
  const final = label.status === 'final' && multiple !== null && observed !== null;
  return {
    status: final ? ('final' as const) : ('pending' as const),
    hit_x2: label.hit_x2 === true,
    hit_x3: label.hit_x3 === true,
    hit_x5: label.hit_x5 === true,
    dd50_first: label.dd50_first === true,
    max_multiple_7d: round(multiple ?? 0, 6),
    hours_to_x3: round(inRange(label.hours_to_x3, 0, 744), 3),
    hit_sl30: label.hit_sl30 === true,
    x2_before_sl30: label.x2_before_sl30 === true,
    sl30_before_x2: label.sl30_before_x2 === true && label.x2_before_sl30 !== true,
    min_multiple_7d: round(inRange(label.min_multiple_7d, 0, 1e9 - 1) ?? 0, 6),
    hours_to_x2: round(inRange(label.hours_to_x2, 0, 744), 3),
    observed_hours: round(observed ?? 0, 3),
    labelled_at: new Date(nowMs).toISOString(),
    // max_multiple_7d = 0 ⇔ no usable candle after the detection yet (outcomes.ts).
    label_error: multiple === 0 || multiple === null ? 'no candle after detection yet' : null,
    label_attempts: nextAttempts(attempts),
  };
}
export type LabelUpdate = ReturnType<typeof labelUpdate>;

/** UPDATE payload when the candles could not be fetched: the row stays pending and goes to the back of the queue. */
export function labelFailureUpdate(error: string, attempts: number, nowMs: number) {
  return {
    labelled_at: new Date(nowMs).toISOString(),
    label_error: sanitizeText(error, 200) || 'label failed',
    label_attempts: nextAttempts(attempts),
  };
}
