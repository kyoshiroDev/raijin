// Turns a validated DexScreener pair into sanitised TokenMetrics.
import type { DexPair, JupiterToken } from './schemas.ts';
import type { DataConfidence, TokenMetrics } from './types.ts';
import { IMAGE_HOSTS, safeHttpsUrl, sanitizeText, TELEGRAM_HOSTS, X_HOSTS } from './sanitize.ts';
import { isSolanaAddress } from './solana.ts';

const n = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function toMetrics(p: DexPair, now: number): TokenMetrics | null {
  if (p.chainId !== 'solana') return null;
  if (!isSolanaAddress(p.baseToken.address) || !isSolanaAddress(p.pairAddress)) return null;

  const symbol = sanitizeText(p.baseToken.symbol, 32);
  if (!symbol) return null;

  const socials = p.info?.socials ?? [];
  const findSocial = (types: string[], hosts: readonly string[]): string | null => {
    for (const s of socials) {
      if (s.type && types.includes(s.type.toLowerCase())) {
        const url = safeHttpsUrl(s.url, hosts);
        if (url) return url;
      }
    }
    return null;
  };
  const website = (p.info?.websites ?? []).map((w) => safeHttpsUrl(w.url)).find((u): u is string => u !== null) ?? null;

  const price = n(p.priceUsd);
  const createdAt = typeof p.pairCreatedAt === 'number' && p.pairCreatedAt > 0 ? p.pairCreatedAt : null;

  return {
    mint: p.baseToken.address,
    symbol,
    name: sanitizeText(p.baseToken.name, 64),
    pairAddress: p.pairAddress,
    dexId: sanitizeText(p.dexId, 32),
    imageUrl: safeHttpsUrl(p.info?.imageUrl, IMAGE_HOSTS),
    websiteUrl: website,
    xUrl: findSocial(['twitter', 'x'], X_HOSTS),
    telegramUrl: findSocial(['telegram'], TELEGRAM_HOSTS),
    priceUsd: price > 0 ? price : 0,
    marketCap: Math.max(0, n(p.marketCap) || n(p.fdv)),
    liquidityUsd: Math.max(0, n(p.liquidity?.usd)),
    // Enrichment (enrich-tokens), merged later from public.tokens.
    liquidityGeckoUsd: null,
    priceJupUsd: null,
    priceGeckoUsd: null,
    roundtripCostPct: null,
    roundtripFeePct: null,
    buyImpactPct: null,
    lpLockedPct: null,
    rugcheckScore: null,
    rugcheckDangers: [],
    volume24h: Math.max(0, n(p.volume?.h24)),
    volume1h: Math.max(0, n(p.volume?.h1)),
    change5m: n(p.priceChange?.m5),
    change1h: n(p.priceChange?.h1),
    change6h: n(p.priceChange?.h6),
    change24h: n(p.priceChange?.h24),
    buys1h: n(p.txns?.h1?.buys),
    sells1h: n(p.txns?.h1?.sells),
    buys24h: n(p.txns?.h24?.buys),
    sells24h: n(p.txns?.h24?.sells),
    pairCreatedAt: createdAt,
    ageHours: createdAt ? (now - createdAt) / 3_600_000 : null,
  };
}

/** Keeps the most liquid pair per token. */
export function bestPairPerToken(pairs: readonly DexPair[]): DexPair[] {
  const best = new Map<string, DexPair>();
  for (const p of pairs) {
    if (p.chainId !== 'solana') continue;
    const cur = best.get(p.baseToken.address);
    if (!cur || n(p.liquidity?.usd) > n(cur.liquidity?.usd)) best.set(p.baseToken.address, p);
  }
  return [...best.values()];
}

// ---------------------------------------------------------------------------------------------------------
// public.tokens rows <-> TokenMetrics (scan-tokens / enrich-tokens)
// ---------------------------------------------------------------------------------------------------------
// Column ownership (each Edge Function only writes its own columns; PostgREST upsert/update only sets the
// keys it is given):
// - scan-tokens: DexScreener + Jupiter audit columns (toTokenRow), incl. price_jup_usd and volume_1h.
// - enrich-tokens: ENRICHMENT_OWNED_COLUMNS (GeckoTerminal, RugCheck, Jupiter round trip, timestamps).
// - both: flags, liquidity_effective_usd, liquidity_divergence, data_confidence (re-flagged by each).
// - nobody: liquidity_dex_usd (generated from liquidity_usd); the archived columns (chore/slim-down, docs/ARCHIVE.md:
//   score, zone_*, swing_*, tp1, tp2, invalidation, rr, zone_candles_at, liquidity_jup_usd, p_x3, p_dd50, model_*).

/** Written only by enrich-tokens; never part of the scan-tokens upsert. */
export const ENRICHMENT_OWNED_COLUMNS = [
  'liquidity_gecko_usd',
  'price_gecko_usd',
  'roundtrip_cost_pct',
  'roundtrip_fee_pct',
  'buy_impact_pct',
  'lp_locked_pct',
  'rugcheck_score',
  'rugcheck_dangers',
  'insiders_detected', // RugCheck full report graphInsidersDetected > 0 (x3 model feature)
  'creator_rug_history', // RugCheck risk « Creator history of rugged tokens » (x3 model feature)
  'quote_at',
  'rugcheck_at',
  'enriched_at',
] as const;

/** Derived from finalFlags (final-score.ts); written by both functions. */
export const FLAG_COLUMNS = ['flags', 'liquidity_effective_usd', 'liquidity_divergence', 'data_confidence'] as const;

/** Every column an enrich-tokens UPDATE may contain. */
export const ENRICH_UPDATE_COLUMNS: ReadonlySet<string> = new Set([...ENRICHMENT_OWNED_COLUMNS, ...FLAG_COLUMNS]);

/** Generated columns: must never appear in a write payload. */
export const GENERATED_COLUMNS = ['liquidity_dex_usd'] as const;

/** select() list for the enrichment columns merged by scan-tokens. */
export const ENRICHMENT_SELECT = ['mint', ...ENRICHMENT_OWNED_COLUMNS].join(',');

/** select() list for a full re-flag by enrich-tokens. */
export const TOKEN_ROW_SELECT = [
  'mint', 'symbol', 'name', 'pair_address', 'dex_id', 'image_url', 'website_url', 'x_url', 'telegram_url',
  'price_usd', 'market_cap', 'liquidity_usd', 'price_jup_usd', 'volume_24h', 'volume_1h',
  'change_5m', 'change_1h', 'change_6h', 'change_24h', 'buys_1h', 'sells_1h', 'buys_24h', 'sells_24h',
  'pair_created_at', 'updated_at', ...ENRICHMENT_OWNED_COLUMNS,
].join(',');

/** Max age of persisted enrichment before it is ignored (treated as unknown) by the flags. */
export const ENRICHMENT_MAX_AGE_MS = {
  gecko: 10 * 60_000, // as of enriched_at: liquidity/price must be close to the DexScreener snapshot
  quote: 20 * 60_000, // round trip moves with the pool
  rugcheck: 6 * 60 * 60_000, // dangers/LP lock change slowly; refreshed every 30 min while in the top 30
} as const;

type Cell = unknown;
export type EnrichmentRow = { mint: Cell } & { [K in (typeof ENRICHMENT_OWNED_COLUMNS)[number]]?: Cell };
export type TokenRow = EnrichmentRow & Record<string, Cell>;

/** PostgREST numeric → finite number or null (numeric may come back as a string). */
function cellNumber(v: Cell): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  }
  return null;
}
const cellPositive = (v: Cell): number | null => {
  const x = cellNumber(v);
  return x !== null && x > 0 ? x : null;
};
const cellText = (v: Cell, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const cellUrl = (v: Cell): string | null => (typeof v === 'string' && v.startsWith('https://') ? v.slice(0, 500) : null);
function cellTime(v: Cell): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
const fresh = (at: number | null, now: number, maxAge: number): boolean => at !== null && at <= now + 60_000 && now - at <= maxAge;

export type EnrichmentMetrics = Pick<
  TokenMetrics,
  | 'liquidityGeckoUsd'
  | 'priceGeckoUsd'
  | 'roundtripCostPct'
  | 'roundtripFeePct'
  | 'buyImpactPct'
  | 'lpLockedPct'
  | 'rugcheckScore'
  | 'rugcheckDangers'
>;

/**
 * Persisted enrichment → TokenMetrics fields, ignoring values older than ENRICHMENT_MAX_AGE_MS
 * (stale = unknown). Dangers are re-sanitised (defence in depth: the column is ours but stays hostile data).
 */
export function enrichmentFromRow(row: EnrichmentRow, now: number): EnrichmentMetrics {
  const geckoOk = fresh(cellTime(row.enriched_at), now, ENRICHMENT_MAX_AGE_MS.gecko);
  const quoteOk = fresh(cellTime(row.quote_at), now, ENRICHMENT_MAX_AGE_MS.quote);
  const rugOk = fresh(cellTime(row.rugcheck_at), now, ENRICHMENT_MAX_AGE_MS.rugcheck);
  const dangers = rugOk && Array.isArray(row.rugcheck_dangers)
    ? row.rugcheck_dangers.map((d) => sanitizeText(d, 40)).filter((d) => d.length > 0).slice(0, 5)
    : [];
  return {
    liquidityGeckoUsd: geckoOk ? cellPositive(row.liquidity_gecko_usd) : null,
    priceGeckoUsd: geckoOk ? cellPositive(row.price_gecko_usd) : null,
    roundtripCostPct: quoteOk ? cellNumber(row.roundtrip_cost_pct) : null,
    roundtripFeePct: quoteOk ? cellNumber(row.roundtrip_fee_pct) : null,
    buyImpactPct: quoteOk ? cellNumber(row.buy_impact_pct) : null,
    lpLockedPct: rugOk ? cellNumber(row.lp_locked_pct) : null,
    rugcheckScore: rugOk ? cellNumber(row.rugcheck_score) : null,
    rugcheckDangers: dangers,
  };
}

/** A public.tokens row (TOKEN_ROW_SELECT) → TokenMetrics, for a re-flag by enrich-tokens. null if unusable. */
export function rowToMetrics(row: TokenRow, now: number): TokenMetrics | null {
  if (!isSolanaAddress(row.mint) || !isSolanaAddress(row.pair_address)) return null;
  const symbol = cellText(row.symbol, 32);
  if (!symbol) return null;
  const createdAt = cellTime(row.pair_created_at);
  const int = (v: Cell): number => Math.max(0, Math.round(cellNumber(v) ?? 0));
  return {
    mint: row.mint,
    symbol,
    name: cellText(row.name, 64),
    pairAddress: row.pair_address,
    dexId: cellText(row.dex_id, 32),
    imageUrl: cellUrl(row.image_url),
    websiteUrl: cellUrl(row.website_url),
    xUrl: cellUrl(row.x_url),
    telegramUrl: cellUrl(row.telegram_url),
    priceUsd: Math.max(0, cellNumber(row.price_usd) ?? 0),
    marketCap: Math.max(0, cellNumber(row.market_cap) ?? 0),
    liquidityUsd: Math.max(0, cellNumber(row.liquidity_usd) ?? 0),
    priceJupUsd: cellPositive(row.price_jup_usd),
    volume24h: Math.max(0, cellNumber(row.volume_24h) ?? 0),
    ...(cellNumber(row.volume_1h) !== null ? { volume1h: Math.max(0, cellNumber(row.volume_1h) ?? 0) } : {}),
    change5m: cellNumber(row.change_5m) ?? 0,
    change1h: cellNumber(row.change_1h) ?? 0,
    change6h: cellNumber(row.change_6h) ?? 0,
    change24h: cellNumber(row.change_24h) ?? 0,
    buys1h: int(row.buys_1h),
    sells1h: int(row.sells_1h),
    buys24h: int(row.buys_24h),
    sells24h: int(row.sells_24h),
    pairCreatedAt: createdAt,
    ageHours: createdAt ? (now - createdAt) / 3_600_000 : null,
    ...enrichmentFromRow(row, now),
  };
}

/** The flag columns persisted on public.tokens: exactly what finalFlags (final-score.ts) returns. */
export interface FlagOutput {
  flags: string[];
  liquidity: number;
  divergence: number | null;
  dataConfidence: DataConfidence | null;
}

const CONFIDENCE: ReadonlySet<string> = new Set(['high', 'medium', 'low']);

/** Flag columns, bounded to the table CHECKs (bad values become null rather than failing the write). */
export function flagColumns(s: FlagOutput) {
  const finite = (v: number | null): v is number => typeof v === 'number' && Number.isFinite(v);
  return {
    flags: s.flags.slice(0, 12),
    liquidity_effective_usd: finite(s.liquidity) && s.liquidity >= 0 && s.liquidity < 1e13 ? s.liquidity : null,
    liquidity_divergence: finite(s.divergence) && s.divergence >= 0 && s.divergence < 1e9 ? s.divergence : null,
    data_confidence: s.dataConfidence && CONFIDENCE.has(s.dataConfidence) ? s.dataConfidence : null,
  };
}

export interface EnrichResults {
  /** GeckoTerminal values for this pool; null = asked but unknown (written as null). */
  gecko: { liquidityUsd: number | null; priceUsd: number | null } | null;
  /** undefined = not fetched this run (cache fresh / deadline) or failed: RugCheck columns untouched. */
  rug?: {
    lpLockedPct: number | null;
    score: number | null;
    dangers: string[];
    /** null/undefined = unknown this run: column left untouched (slow-changing, keeps the last known value). */
    insidersDetected?: boolean | null;
    /** null/undefined = unknown this run: column left untouched. */
    creatorRugHistory?: boolean | null;
  } | null;
  /** undefined = not quoted this run: columns untouched. null = quoted but failed: written as null (unknown). */
  quote?: { roundtripCostPct: number; roundtripFeePct: number; buyImpactPct: number } | null;
}

const inRange = (v: number | null | undefined, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;

/** UPDATE payload of enrich-tokens: only ENRICH_UPDATE_COLUMNS, values bounded to the table CHECKs. */
export function buildEnrichmentUpdate(r: EnrichResults, s: FlagOutput, now: number): Record<string, unknown> {
  const at = new Date(now).toISOString();
  const out: Record<string, unknown> = {
    liquidity_gecko_usd: inRange(r.gecko?.liquidityUsd, 0, 1e13 - 1),
    price_gecko_usd: inRange(r.gecko?.priceUsd, 0, 1e12 - 1),
    ...flagColumns(s),
    enriched_at: at,
  };
  if (r.rug) {
    out.lp_locked_pct = inRange(r.rug.lpLockedPct, 0, 100);
    out.rugcheck_score = inRange(r.rug.score, 0, 1e9 - 1);
    out.rugcheck_dangers = r.rug.dangers.map((d) => sanitizeText(d, 40)).filter((d) => d.length > 0).slice(0, 5);
    if (typeof r.rug.insidersDetected === 'boolean') out.insiders_detected = r.rug.insidersDetected;
    if (typeof r.rug.creatorRugHistory === 'boolean') out.creator_rug_history = r.rug.creatorRugHistory;
    out.rugcheck_at = at;
  }
  if (r.quote !== undefined) {
    const q = r.quote;
    const cost = inRange(q?.roundtripCostPct, -100, 100);
    const fee = inRange(q?.roundtripFeePct, 0, 100);
    const impact = inRange(q?.buyImpactPct, -100, 100);
    const ok = cost !== null && fee !== null && impact !== null;
    out.roundtrip_cost_pct = ok ? cost : null;
    out.roundtrip_fee_pct = ok ? fee : null;
    out.buy_impact_pct = ok ? impact : null;
    out.quote_at = ok ? at : null;
  }
  return out;
}

/** A flagged scan item, ready to be persisted by scan-tokens. */
export interface ScanItem extends FlagOutput {
  t: TokenMetrics;
}

const pct100 = (v: number | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null;

/**
 * scan-tokens upsert row. Never contains ENRICHMENT_OWNED_COLUMNS (owned by enrich-tokens, preserved by the
 * upsert because PostgREST only sets the provided columns) nor GENERATED_COLUMNS.
 */
export function toTokenRow(s: ScanItem, audit: JupiterToken | undefined, now: number) {
  const { t } = s;
  return {
    mint: t.mint,
    symbol: t.symbol,
    name: t.name,
    pair_address: t.pairAddress,
    dex_id: t.dexId,
    image_url: t.imageUrl,
    website_url: t.websiteUrl,
    x_url: t.xUrl,
    telegram_url: t.telegramUrl,
    price_usd: t.priceUsd,
    market_cap: t.marketCap,
    liquidity_usd: t.liquidityUsd,
    price_jup_usd: inRange(t.priceJupUsd, 0, 1e12 - 1),
    volume_24h: t.volume24h,
    volume_1h: inRange(t.volume1h ?? null, 0, 1e15 - 1),
    change_5m: t.change5m,
    change_1h: t.change1h,
    change_6h: t.change6h,
    change_24h: t.change24h,
    buys_1h: t.buys1h,
    sells_1h: t.sells1h,
    buys_24h: t.buys24h,
    sells_24h: t.sells24h,
    pair_created_at: t.pairCreatedAt ? new Date(t.pairCreatedAt).toISOString() : null,
    ...flagColumns(s),
    mint_authority_disabled: audit?.audit?.mintAuthorityDisabled ?? null,
    freeze_authority_disabled: audit?.audit?.freezeAuthorityDisabled ?? null,
    top10_pct: pct100(audit?.audit?.topHoldersPercentage),
    holder_count: typeof audit?.holderCount === 'number' ? Math.round(audit.holderCount) : null,
    organic_score: pct100(audit?.organicScore),
    updated_at: new Date(now).toISOString(),
  };
}
export type TokenUpsertRow = ReturnType<typeof toTokenRow>;
