import { isSolanaAddress } from '../utils/solana-address';

// Mirrors public.tokens. Regenerate with:
// supabase gen types typescript --local > src/app/shared/models/database.types.ts
// Archived columns (slim-down, 2026-11-21: score, zone_*, tp1/tp2, invalidation, p_x3, p_dd50, rr, model_*) are no
// longer written by the backend and no longer read here.
export type DataConfidence = 'high' | 'medium' | 'low';

export interface TokenRow {
  mint: string;
  symbol: string;
  name: string;
  pair_address: string;
  dex_id: string;
  image_url: string | null;
  website_url: string | null;
  x_url: string | null;
  telegram_url: string | null;
  price_usd: number;
  market_cap: number;
  /** DexScreener liquidity (best pair). */
  liquidity_usd: number;
  /** Jupiter liquidity, null when unknown (archived column). Shown in the liquidity tooltip only, never in a calculation or label. */
  liquidity_jup_usd: number | null;
  volume_24h: number;
  change_1h: number;
  change_24h: number;
  buys_1h: number;
  sells_1h: number;
  pair_created_at: string | null;
  /** Warning flags written by the scan (may embed token text: interpolation only). Includes « Structure cassée ». */
  flags: string[];
  mint_authority_disabled: boolean | null;
  freeze_authority_disabled: boolean | null;
  top10_pct: number | null;
  holder_count: number | null;
  organic_score: number | null;
  first_seen_at: string;
  updated_at: string;

  // Cross-source enrichment (all nullable: unknown until the enrichment step has run).
  /** DexScreener liquidity (generated column, = liquidity_usd). */
  liquidity_dex_usd: number | null;
  liquidity_gecko_usd: number | null;
  /** Liquidity retained by the backend: median of the usable DexScreener / GeckoTerminal values (v5). */
  liquidity_effective_usd: number | null;
  /** Spread between sources as a FRACTION (0.5 = 50 %). */
  liquidity_divergence: number | null;
  /** Round-trip cost in PERCENT for a 0.1 SOL buy + sell (Jupiter quote). */
  roundtrip_cost_pct: number | null;
  /** Size-independent part of the round trip, in PERCENT (fees). */
  roundtrip_fee_pct: number | null;
  /** Buy price impact in PERCENT. */
  buy_impact_pct: number | null;
  /** Share of the LP locked, 0–100. */
  lp_locked_pct: number | null;
  rugcheck_score: number | null;
  /** RugCheck danger labels: HOSTILE text, sanitised and capped by parseTokenRow(). */
  rugcheck_dangers: string[];
  price_jup_usd: number | null;
  price_gecko_usd: number | null;
  data_confidence: DataConfidence | null;
  quote_at: string | null;
  rugcheck_at: string | null;
  enriched_at: string | null;

  /** Narrative group label (e.g. « GTA »): HOSTILE text, sanitised and capped by parseTokenRow(). */
  narrative: string | null;
  /** 1 = largest MC of its narrative group; null when no group. */
  narrative_rank: number | null;
  /** RugCheck reports insiders (null = unknown). */
  insiders_detected: boolean | null;
  /** RugCheck flags the creator's history (previous rugs). null = unknown. */
  creator_rug_history: boolean | null;
  /**
   * Price sparkline over the last 6 h: positive prices, oldest → newest, the last one being the current price.
   * At most MAX_SPARK_POINTS; null when unknown or when fewer than 2 usable points. Always set by parseTokenRow();
   * optional in the type so hand-built rows (older fixtures) stay valid.
   */
  spark_6h?: number[] | null;
}

/** Nullable numeric enrichment columns (null/absent = unknown). */
export const OPTIONAL_NUMBER_COLUMNS = [
  'liquidity_jup_usd',
  'liquidity_dex_usd',
  'liquidity_gecko_usd',
  'liquidity_effective_usd',
  'liquidity_divergence',
  'roundtrip_cost_pct',
  'roundtrip_fee_pct',
  'buy_impact_pct',
  'lp_locked_pct',
  'rugcheck_score',
  'price_jup_usd',
  'price_gecko_usd',
] as const satisfies readonly (keyof TokenRow)[];

const OPTIONAL_DATE_COLUMNS = ['quote_at', 'rugcheck_at', 'enriched_at'] as const satisfies readonly (keyof TokenRow)[];

export const DATA_CONFIDENCE_VALUES: readonly DataConfidence[] = ['high', 'medium', 'low'];
export const MAX_DANGERS = 5;
export const MAX_DANGER_LENGTH = 40;
export const MAX_NARRATIVE_LENGTH = 24;
/** Cap on the sparkline points kept on the front (the most recent ones). */
export const MAX_SPARK_POINTS = 48;

export const TOKEN_COLUMNS = [
  'mint', 'symbol', 'name', 'pair_address', 'dex_id', 'image_url', 'website_url', 'x_url', 'telegram_url',
  'price_usd', 'market_cap', 'liquidity_usd', 'liquidity_jup_usd', 'volume_24h', 'change_1h', 'change_24h', 'buys_1h', 'sells_1h',
  'pair_created_at', 'flags', 'mint_authority_disabled', 'freeze_authority_disabled', 'top10_pct', 'holder_count',
  'organic_score', 'first_seen_at', 'updated_at',
  'liquidity_dex_usd', 'liquidity_gecko_usd', 'liquidity_effective_usd', 'liquidity_divergence',
  'roundtrip_cost_pct', 'roundtrip_fee_pct', 'buy_impact_pct', 'lp_locked_pct', 'rugcheck_score', 'rugcheck_dangers',
  'price_jup_usd', 'price_gecko_usd', 'data_confidence', 'quote_at', 'rugcheck_at', 'enriched_at',
  'narrative', 'narrative_rank',
  'insiders_detected', 'creator_rug_history', 'spark_6h',
].join(',');

const NUMERIC_STRING = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?\s*$/i;
/**
 * C0/C1 controls, Arabic letter mark (U+061C), zero-width characters, line/paragraph separators, bidi
 * embeddings/overrides/isolates, BOM, interlinear annotation controls (U+FFF9–U+FFFB).
 */
function isUnsafeCodePoint(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x061c ||
    (cp >= 0xfff9 && cp <= 0xfffb) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2069) ||
    cp === 0xfeff
  );
}

/**
 * null/absent → null; finite number → itself; numeric string (PostgREST/Realtime may send
 * `numeric` as text) → Number(); anything else → undefined (invalid).
 */
export function toOptionalNumber(value: unknown): number | null | undefined {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && NUMERIC_STRING.test(value)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Hostile text: strip control/bidi/zero-width characters, collapse spaces, trim, cap at `max` characters. */
export function cleanText(value: string, max: number): string {
  // Controls (newline, tab…) become a space; invisible / bidi characters are removed.
  const kept = Array.from(value, (ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    return cp <= 0x1f ? ' ' : isUnsafeCodePoint(cp) ? '' : ch;
  }).join('');
  const chars = Array.from(kept.replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

/** Hostile third-party text: strip control/bidi/zero-width characters, trim, cap the length. */
export function cleanDanger(value: string): string {
  return cleanText(value, MAX_DANGER_LENGTH);
}

/** string → cleaned text (null when empty after cleaning); anything else → null. */
export function parseOptionalText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const c = cleanText(value, max);
  return c === '' ? null : c;
}

/** boolean → itself; 'true'/'false' text → boolean; number → n > 0 (counts); anything else → null. */
export function toOptionalBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 't') return true;
  if (value === 'false' || value === 'f') return false;
  if (typeof value === 'number' && Number.isFinite(value)) return value > 0;
  return null;
}

/** null/absent → []; array of strings → cleaned, non-empty, unique, at most MAX_DANGERS; else undefined. */
export function parseDangers(value: unknown): string[] | undefined {
  if (value == null) return [];
  if (!Array.isArray(value) || !value.every((d): d is string => typeof d === 'string')) return undefined;
  const out: string[] = [];
  for (const d of value) {
    const c = cleanDanger(d);
    if (c && !out.includes(c)) out.push(c);
    if (out.length === MAX_DANGERS) break;
  }
  return out;
}

/**
 * Sparkline points (display-only, never rejects the token): a JSON array or a Postgres array literal
 * (« {1.2,1.3} »), numbers or numeric strings. Non-finite / non-positive points are dropped, the most recent
 * MAX_SPARK_POINTS are kept; fewer than 2 usable points → null.
 */
/** Upper bounds checked BEFORE parsing (defence in depth: the DB CHECK already caps spark_6h at 48 values). */
const MAX_SPARK_INPUT_ITEMS = MAX_SPARK_POINTS * 4;
const MAX_SPARK_INPUT_CHARS = 2048;

export function parseSpark(value: unknown): number[] | null {
  let items: unknown[];
  if (Array.isArray(value)) {
    if (value.length > MAX_SPARK_INPUT_ITEMS) return null;
    items = value;
  } else if (typeof value === 'string' && value.length <= MAX_SPARK_INPUT_CHARS && /^\{.*\}$/s.test(value.trim())) {
    const inner = value.trim().slice(1, -1);
    items = inner === '' ? [] : inner.split(',');
  } else return null;
  const out: number[] = [];
  for (const item of items) {
    const n = toOptionalNumber(item);
    if (typeof n === 'number' && n > 0) out.push(n);
  }
  const kept = out.length > MAX_SPARK_POINTS ? out.slice(-MAX_SPARK_POINTS) : out;
  return kept.length >= 2 ? kept : null;
}

const isDataConfidence = (v: unknown): v is DataConfidence => DATA_CONFIDENCE_VALUES.includes(v as DataConfidence);

/**
 * Strict type guard on rows coming from the database / realtime. Enrichment columns must be
 * null/absent or finite numbers (use parseTokenRow() to also accept numeric strings).
 */
export function isTokenRow(value: unknown): value is TokenRow {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const numbersOk = OPTIONAL_NUMBER_COLUMNS.every((c) => v[c] == null || (typeof v[c] === 'number' && Number.isFinite(v[c])));
  const datesOk = OPTIONAL_DATE_COLUMNS.every((c) => v[c] == null || typeof v[c] === 'string');
  const dangers = v['rugcheck_dangers'];
  const dangersOk = dangers == null || (Array.isArray(dangers) && dangers.every((d) => typeof d === 'string'));
  const confidence = v['data_confidence'];
  const spark = v['spark_6h'];
  const sparkOk = spark == null || (Array.isArray(spark) && spark.every((p) => typeof p === 'number' && Number.isFinite(p)));
  return (
    isSolanaAddress(v['mint']) &&
    typeof v['symbol'] === 'string' &&
    Array.isArray(v['flags']) &&
    numbersOk &&
    datesOk &&
    dangersOk &&
    sparkOk &&
    (confidence == null || isDataConfidence(confidence))
  );
}

/**
 * Defensive parse + normalisation: numeric strings become numbers, absent enrichment columns
 * become null, RugCheck dangers are sanitised (hostile text) and capped. null = rejected row.
 */
export function parseTokenRow(value: unknown): TokenRow | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const out: Record<string, unknown> = { ...v };
  for (const c of OPTIONAL_NUMBER_COLUMNS) {
    const n = toOptionalNumber(v[c]);
    if (n === undefined) return null;
    out[c] = n;
  }
  for (const c of OPTIONAL_DATE_COLUMNS) {
    if (v[c] != null && typeof v[c] !== 'string') return null;
    out[c] = v[c] ?? null;
  }
  const dangers = parseDangers(v['rugcheck_dangers']);
  if (dangers === undefined) return null;
  out['rugcheck_dangers'] = dangers;
  const confidence = v['data_confidence'];
  if (confidence != null && !isDataConfidence(confidence)) return null;
  out['data_confidence'] = confidence ?? null;
  // Display-only columns: never reject the token for them; unusable values become null.
  out['narrative'] = parseOptionalText(v['narrative'], MAX_NARRATIVE_LENGTH);
  const rank = toOptionalNumber(v['narrative_rank']);
  out['narrative_rank'] = rank != null && Number.isInteger(rank) && rank >= 1 ? rank : null;
  out['insiders_detected'] = toOptionalBoolean(v['insiders_detected']);
  out['creator_rug_history'] = toOptionalBoolean(v['creator_rug_history']);
  out['spark_6h'] = parseSpark(v['spark_6h']);
  return isTokenRow(out) ? out : null;
}
