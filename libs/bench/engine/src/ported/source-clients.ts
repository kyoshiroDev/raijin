// Candidate sources of scan-tokens: DexScreener lists + keyword search, young GeckoTerminal pools (trending 1 h,
// PumpSwap, new pools), Jupiter Tokens API v2 « recent », pump.fun → PumpSwap/Raydium migrations, young watch.
// chore/slim-down: the Jupiter toplists (toptrending / toporganicscore / toptraded 1 h and 6 h) and GeckoTerminal
// trending (all ages) were removed; 'gecko_new_pools' and 'jup_recent' were added (yield measured per source in
// scan_runs.source_counts: seen / kept / young / youngKept).
// Rules (docs/SECURITY.md): fixed https hosts (SOURCE_HOSTS, via enrich-clients' getJson: redirect 'error',
// timeout <= 8 s, body cap, never throws), zod on every item (invalid items are dropped, not the list), mints
// validated with isSolanaAddress, one failing source never fails the others (collectSources isolates each one).
// Pure parsers + an orchestrator with injected fetch/pacers so everything is unit tested without network.
//
// Real endpoints (see test-support/source-fixtures.ts for trimmed responses):
// - GeckoTerminal pool lists (trending_pools?duration=1h, dexes/pumpswap/pools, new_pools) → { data: [20 pools] },
//   pool = { id: "solana_<pool>", type: "pool", attributes: { pool_created_at, reserve_in_usd, … },
//     relationships: { base_token: { data: { id: "solana_<mint>" } }, quote_token: {…}, dex: { data: { id } } } }.
// - Jupiter GET /tokens/v2/recent (checked 2026-11-21) → array of 30 tokens, newest first pool first, same record as
//   /tokens/v2/search ({ id, symbol, mcap, liquidity, usdPrice, organicScore, audit, holderCount, tags,
//   firstPool: { id, createdAt } }). Observed: pools 0–2 min old (pump.fun launches), tags ["unknown", "token-2022"].
//   The non-memecoin tag exclusion (JUP_EXCLUDED_TAGS) is kept on it, but such tags were only carried by the removed
//   toplists: in practice it no longer excludes anything (docs/ARCHITECTURE.md §Sources).
//   lite-api rate limit observed: 5 requests per 10 s window (429 on the 6th), shared by every lite-api endpoint →
//   all Jupiter calls of the scan go through one pacer (JUP_GAP_MS).
import { z } from 'zod/v3';
import { type FetchFn as ClientFetch, GECKO_BASE, getJson, resolveJupBase, SOL_MINT } from './enrich-clients';
import { type DexPair, DexPairSchema, DexTokenRefSchema, type JupiterToken, JupiterTokenSchema, parseEach } from './schemas';
import { isSolanaAddress } from './solana';
import {
  DEFAULT_CAP_PER_SOURCE,
  detectMigrations,
  mergeSources,
  prioritizeMints,
  type SourceName,
  sourcesColumn,
} from './sources';

export const DEX_BASE = 'https://api.dexscreener.com';
/** The only hosts the candidate sources may call. */
export const SOURCE_HOSTS: ReadonlySet<string> = new Set([
  'api.dexscreener.com',
  'api.geckoterminal.com',
  'lite-api.jup.ag',
  'api.jup.ag',
]);
export const SOURCE_TIMEOUT_MS = 8_000;

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
/** Quote-side assets: never candidates, whatever the source. */
export const QUOTE_MINTS: ReadonlySet<string> = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);

/** Jupiter tags of non-memecoin assets (stablecoins, LSTs, tokenised stocks/RWA, majors, DeFi blue chips). */
export const JUP_EXCLUDED_TAGS: ReadonlySet<string> = new Set([
  'stable',
  'lst',
  'original-lst',
  'stocks',
  'xstocks',
  'equities',
  'prestocks',
  'pre-ipo',
  'rwa',
  'major',
  'defi',
]);

/** GeckoTerminal: one call every 2.2 s (~30 req/min shared with enrich-tokens and label-outcomes). */
export const GECKO_GAP_MS = 2_200;

/**
 * Young GeckoTerminal pools (only pools created < 24 h ago are kept, parseGeckoYoungPools), run at EVERY scan since
 * chore/slim-down (the trending source and the zone candles no longer use the GeckoTerminal quota): ≤ 4 calls per scan.
 *   trending_pools?duration=1h : ≤ 2 pages (fix/young-sources, 21/11: 9 kept on 3 pages, 4 / 3 / 2 per page);
 *   PumpSwap by 24 h tx count   : 1 page (7 kept on 5 pages, 3 on the first);
 *   new_pools                   : 1 page (chore/slim-down: the newest pools, mostly < 10 min old; on 21/11 1 kept out of
 *                                 12 young with reserve over 10 pages — the page is kept to MEASURE its yield).
 * Pagination: next page only after a full page that still had young pools (hasNextYoungPage).
 */
export const GECKO_TRENDING_1H_PATH = '/networks/solana/trending_pools?duration=1h';
export const GECKO_TRENDING_1H_PAGES = 2;
export const GECKO_PUMPSWAP_PATH = '/networks/solana/dexes/pumpswap/pools?sort=h24_tx_count_desc';
export const GECKO_PUMPSWAP_PAGES = 1;
export const GECKO_NEW_POOLS_PATH = '/networks/solana/new_pools';
export const GECKO_NEW_POOLS_PAGES = 1;
/** Upper bound of GeckoTerminal source calls per scan (the sum of the pages above). */
export const GECKO_SOURCE_CALLS_MAX = GECKO_TRENDING_1H_PAGES + GECKO_PUMPSWAP_PAGES + GECKO_NEW_POOLS_PAGES;

/** Jupiter lite-api: 5 requests / 10 s → at most one every 2.1 s (≤ 5 in any 10 s window). */
export const JUP_GAP_MS = 2_100;
/** Jupiter « recent » endpoint (Tokens API v2): the newest tokens with their first pool. */
export const JUP_RECENT_PATH = '/tokens/v2/recent';
/** Distinct mints sent to DexScreener /tokens/v1 (30 per call): 15 calls max. */
export const MAX_PAIR_MINTS = 450;
/** pump.fun tokens re-fetched to detect their migration (persisted tokens.dex_id = 'pumpfun'). */
export const MIGRATION_WATCH_MAX = 60;
export const MIGRATION_WATCH_WINDOW_MS = 24 * 3_600_000;
/** A PumpSwap/Raydium pair younger than this on a pump.fun token = fresh migration. */
export const FRESH_MIGRATION_WINDOW_MS = 2 * 3_600_000;
const MAX_KEYWORDS = 10;
/**
 * Keyword search: up to 10 keywords × ≤ 30 pairs = 300 mints, all used before feat/more-sources → 300 for
 * 'dex_search' (no regression); every other source stays at DEFAULT_CAP_PER_SOURCE (100), applied in withoutExcluded.
 */
export const DEX_SEARCH_CAP = 300;

/** mergeSources with the per-source caps of the scan (other lists are pre-capped to 100 by withoutExcluded). */
export function mergeAll(lists: readonly SourceList[]): Map<string, SourceName[]> {
  return mergeSources(lists, { capPerSource: DEX_SEARCH_CAP });
}

/** Thrown by sourceFetcher on HTTP 429: collectSources stops the rest of that source group. */
export class RateLimitedError extends Error {
  constructor() {
    super('rate limited');
    this.name = 'RateLimitedError';
  }
}

// ---------------------------------------------------------------------------------------------------------
// Parsers (untrusted payloads → valid mints)
// ---------------------------------------------------------------------------------------------------------

/** DexScreener token-profiles / token-boosts / community-takeovers → Solana mints (stable order, deduped). */
export function parseDexRefMints(input: unknown): string[] {
  const out = new Set<string>();
  for (const r of parseEach(DexTokenRefSchema, input)) {
    if (r.chainId === 'solana' && isSolanaAddress(r.tokenAddress) && !QUOTE_MINTS.has(r.tokenAddress)) out.add(r.tokenAddress);
  }
  return [...out];
}

const GeckoRelSchema = z.object({ data: z.object({ id: z.string().max(80) }) });
const GeckoPoolRefSchema = z.object({
  relationships: z.object({ base_token: GeckoRelSchema, quote_token: GeckoRelSchema.optional() }),
});

/** "solana_<mint>" → mint, or null. */
function geckoMint(id: string): string | null {
  if (!id.startsWith('solana_')) return null;
  const mint = id.slice('solana_'.length);
  return isSolanaAddress(mint) ? mint : null;
}

// ---------------------------------------------------------------------------------------------------------
// Young pools (fix/young-sources, chore/slim-down): GeckoTerminal pool lists, paginated
// ---------------------------------------------------------------------------------------------------------

/** GeckoTerminal pool lists return 20 pools per page; a shorter page is the last one. */
export const GECKO_POOL_PAGE_SIZE = 20;
/** « Young » = pair created less than 24 h ago (goal: ≥ 40 % of the kept tokens). */
export const YOUNG_PAIR_MAX_AGE_MS = 24 * 3_600_000;

const GeckoYoungPoolSchema = z.object({
  attributes: z.object({
    pool_created_at: z.string().max(40).optional().catch(undefined),
    reserve_in_usd: z.union([z.string().max(40), z.number()]).optional().catch(undefined),
  }),
  relationships: z.object({ base_token: GeckoRelSchema, quote_token: GeckoRelSchema.optional() }),
});

export interface YoungPoolPage {
  /** Base mints of the young pools of the page (quote assets skipped), page order, deduped. */
  mints: string[];
  /** Pools in the payload (valid or not, ≤ 100): a page shorter than GECKO_POOL_PAGE_SIZE is the last one. */
  items: number;
  /** Valid pools younger than maxAgeMs on this page (before the reserve filter). */
  young: number;
}

export interface YoungPoolOptions {
  /** Default YOUNG_PAIR_MAX_AGE_MS. */
  maxAgeMs?: number;
  /**
   * Minimum GeckoTerminal reserve (USD). 0 (default) = no reserve filter: GeckoTerminal reports reserve_in_usd = 0
   * for most PumpSwap pools (measured 21/11), the DexScreener liquidity filter of the scan decides.
   */
  minReserveUsd?: number;
}

/**
 * GeckoTerminal pools payload → base mints of the pools created less than `maxAgeMs` ago (pool_created_at; missing,
 * unparseable or > 5 min in the future = not young), with an optional reserve floor. Untrusted input: zod per item,
 * mints validated, ≤ 100 items read, never throws.
 */
export function parseGeckoYoungPools(input: unknown, nowMs: number, opts: YoungPoolOptions = {}): YoungPoolPage {
  const data = input && typeof input === 'object' && 'data' in input ? (input as { data: unknown }).data : null;
  if (!Array.isArray(data) || !Number.isFinite(nowMs)) return { mints: [], items: 0, young: 0 };
  const maxAge = opts.maxAgeMs ?? YOUNG_PAIR_MAX_AGE_MS;
  const minReserve = opts.minReserveUsd ?? 0;
  const out = new Set<string>();
  let young = 0;
  const items = data.slice(0, 100);
  for (const item of items) {
    const r = GeckoYoungPoolSchema.safeParse(item);
    if (!r.success) continue;
    const created = typeof r.data.attributes.pool_created_at === 'string' ? Date.parse(r.data.attributes.pool_created_at) : NaN;
    if (!Number.isFinite(created) || created > nowMs + 5 * 60_000 || nowMs - created > maxAge) continue;
    young++;
    if (minReserve > 0) {
      const reserve = Number(r.data.attributes.reserve_in_usd);
      if (!(Number.isFinite(reserve) && reserve >= minReserve)) continue;
    }
    const mint = geckoMint(r.data.relationships.base_token.data.id);
    if (mint && !QUOTE_MINTS.has(mint)) out.add(mint);
  }
  return { mints: [...out], items: items.length, young };
}

/**
 * Pagination rule of the young-pool lists: fetch the next page only when this one was full (GECKO_POOL_PAGE_SIZE
 * pools) AND still had young pools (the list is sorted by volume, not age: a page without any young pool means the
 * young part of the ranking is exhausted, further pages would cost GeckoTerminal quota for nothing).
 */
export function hasNextYoungPage(page: YoungPoolPage, pageSize: number = GECKO_POOL_PAGE_SIZE): boolean {
  return page.items >= pageSize && page.young > 0;
}

/**
 * Young watch: tokens persisted with a pair younger than 24 h and kept by a scan in the last YOUNG_WATCH_FRESH_MS
 * are re-fetched (DexScreener only) at every scan, so a young token found by a source that does not run every scan
 * (GeckoTerminal) or that left its list stays evaluated until it ages out or fails the filters (2-scan alert
 * persistence, young presets, paper books).
 */
export const YOUNG_WATCH_MAX = 100;
export const YOUNG_WATCH_FRESH_MS = 10 * 60_000;

/**
 * public.tokens rows (mint, pair_created_at) of the young watch → mints whose pair is still younger than 24 h at
 * `nowMs` (the read is a few seconds old; future dates > 5 min rejected), valid, deduped, ≤ YOUNG_WATCH_MAX, row order.
 */
export function parseYoungWatchRows(rows: unknown, nowMs: number, max: number = YOUNG_WATCH_MAX): string[] {
  if (!Array.isArray(rows) || !Number.isFinite(nowMs)) return [];
  const out = new Set<string>();
  for (const row of rows) {
    if (out.size >= max) break;
    if (!row || typeof row !== 'object') continue;
    const r = row as { mint?: unknown; pair_created_at?: unknown };
    if (!isSolanaAddress(r.mint) || QUOTE_MINTS.has(r.mint)) continue;
    const created = typeof r.pair_created_at === 'string' && r.pair_created_at.length <= 40 ? Date.parse(r.pair_created_at) : NaN;
    if (!Number.isFinite(created) || created > nowMs + 5 * 60_000 || nowMs - created >= YOUNG_PAIR_MAX_AGE_MS) continue;
    out.add(r.mint);
  }
  return [...out];
}

/** URLs of pages 1..pages of a GeckoTerminal list (`path` without the page parameter; pages clamped to 0..10). */
export function geckoPageUrls(path: string, pages: number): string[] {
  const n = Number.isFinite(pages) ? Math.min(10, Math.max(0, Math.floor(pages))) : 0;
  const sep = path.includes('?') ? '&' : '?';
  return Array.from({ length: n }, (_, i) => `${GECKO_BASE}${path}${sep}page=${i + 1}`);
}

const JupListItemSchema = z.object({
  id: z.string().max(64),
  tags: z.array(z.string().max(40)).max(50).optional().catch(undefined),
  firstPool: z.object({ createdAt: z.string().max(40).optional().catch(undefined) }).optional().catch(undefined),
});

/**
 * Jupiter « recent » list → candidate mints, mints excluded by tag (stablecoins, LSTs, stocks…) or quote assets, and
 * the candidates' token records (same Tokens API v2 shape as /tokens/v2/search, validated by JupiterTokenSchema) so
 * the scan can reuse them as audits instead of re-asking Jupiter in the same scan. A token whose first pool is KNOWN
 * to be ≥ maxAgeMs old (or > 5 min in the future) is dropped; an unknown creation time is kept (the DexScreener pair
 * age decides later). Untrusted input: ≤ 200 items, zod per item, mints validated, never throws.
 */
export function parseJupRecent(
  input: unknown,
  nowMs: number,
  maxAgeMs: number = YOUNG_PAIR_MAX_AGE_MS,
): { mints: string[]; excluded: string[]; tokens: JupiterToken[] } {
  if (!Array.isArray(input) || !Number.isFinite(nowMs)) return { mints: [], excluded: [], tokens: [] };
  const mints = new Set<string>();
  const excluded = new Set<string>();
  const tokens: JupiterToken[] = [];
  for (const item of input.slice(0, 200)) {
    const r = JupListItemSchema.safeParse(item);
    if (!r.success || !isSolanaAddress(r.data.id)) continue;
    const bad = QUOTE_MINTS.has(r.data.id) || (r.data.tags ?? []).some((t) => JUP_EXCLUDED_TAGS.has(t));
    if (bad) {
      excluded.add(r.data.id);
      continue;
    }
    const createdRaw = r.data.firstPool?.createdAt;
    const created = typeof createdRaw === 'string' ? Date.parse(createdRaw) : NaN;
    if (Number.isFinite(created) && (created > nowMs + 5 * 60_000 || nowMs - created >= maxAgeMs)) continue;
    if (mints.has(r.data.id)) continue;
    mints.add(r.data.id);
    const token = JupiterTokenSchema.safeParse(item);
    if (token.success) tokens.push(token.data);
  }
  return { mints: [...mints], excluded: [...excluded], tokens };
}

/** DexScreener search payload → Solana pairs (validated). */
export function parseDexSearchPairs(input: unknown): DexPair[] {
  const pairs = input && typeof input === 'object' && 'pairs' in input ? (input as { pairs: unknown }).pairs : null;
  return parseEach(DexPairSchema, pairs).filter((p) => p.chainId === 'solana');
}

/** SCAN_KEYWORDS env → at most 10 trimmed keywords of 1–40 chars. */
export function parseKeywords(env: string | undefined | null): string[] {
  return (env ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0 && k.length <= 40)
    .slice(0, MAX_KEYWORDS);
}

// ---------------------------------------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------------------------------------

export interface PacerClock {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Returns `pace()`: each call resolves at least `gapMs` after the previous one was released (FIFO slots). */
export function createPacer(gapMs: number, clock: PacerClock = {}): () => Promise<void> {
  const now = clock.now ?? Date.now;
  const sleep = clock.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let next = -Infinity;
  return async () => {
    const t = now();
    const slot = Math.max(t, next);
    next = slot + gapMs;
    if (slot > t) await sleep(slot - t);
  };
}

// ---------------------------------------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------------------------------------

export type FetchJson = (url: string) => Promise<unknown | null>;

export interface SourceList {
  source: SourceName;
  mints: string[];
}

export interface CollectDeps {
  fetchJson: FetchJson;
  /** Shared Jupiter pacer (also used by the scan's market call and audits). */
  jupPace: () => Promise<void>;
  /** GeckoTerminal pacer. */
  geckoPace: () => Promise<void>;
  jupBase?: string | null;
  keywords?: string[];
  log?: (message: string) => void;
  /** No new request at or after this time (ms, ScanBudget.at('collectStopMs')). Default: none. */
  deadline?: number;
  /** false = skip the GeckoTerminal sources this scan (e.g. GeckoTerminal answered 429 recently). Default: true. */
  includeGecko?: boolean;
  now?: () => number;
}

export interface CollectResult {
  lists: SourceList[];
  /** Pairs returned by the keyword search (used as-is, as before). */
  searchPairs: DexPair[];
  /** Mints flagged as non-memecoin by Jupiter tags or quote assets: removed from every non-DexScreener source. */
  excluded: Set<string>;
  /** Sources whose request failed or returned an unusable payload. */
  failed: SourceName[];
  /** Jupiter token records of the « recent » candidates (fresh, this scan): reusable as audits. */
  jupTokens: Map<string, JupiterToken>;
  /** Sources with at least one request not started because of the deadline or a 429 in their group. */
  skipped: SourceName[];
  /** Groups stopped by an HTTP 429. */
  rateLimited: ('dex' | 'gecko' | 'jup')[];
}

interface Job {
  source: SourceName;
  group: 'dex' | 'gecko' | 'jup';
  urls: string[];
  /** `more: false` = stop the pagination of this source (remaining URLs are not requested, not « skipped »). */
  parse: (payload: unknown) => {
    mints: string[];
    excluded?: string[];
    pairs?: DexPair[];
    tokens?: JupiterToken[];
    more?: boolean;
  };
}

/** Every request of the collection step (fixed hosts and paths; keywords are URL-encoded). */
export function sourceJobs(
  jupBaseEnv?: string | null,
  keywords: readonly string[] = [],
  now: () => number = Date.now,
): Job[] {
  const jup = resolveJupBase(jupBaseEnv ?? undefined);
  const dexList = (source: SourceName, path: string): Job => ({
    source,
    group: 'dex',
    urls: [`${DEX_BASE}${path}`],
    parse: (p) => ({ mints: parseDexRefMints(p) }),
  });
  const youngPoolsParse = (p: unknown) => {
    const page = parseGeckoYoungPools(p, now());
    return { mints: page.mints, more: hasNextYoungPage(page) };
  };
  const searchPairsParse = (p: unknown) => {
    const pairs = parseDexSearchPairs(p);
    return { mints: pairs.map((x) => x.baseToken.address), pairs };
  };
  return [
    dexList('dex_profiles', '/token-profiles/latest/v1'),
    dexList('dex_boosts_latest', '/token-boosts/latest/v1'),
    dexList('dex_boosts_top', '/token-boosts/top/v1'),
    dexList('dex_cto', '/community-takeovers/latest/v1'),
    ...(keywords.length > 0
      ? [{
        source: 'dex_search' as const,
        group: 'dex' as const,
        urls: keywords.map((k) => `${DEX_BASE}/latest/dex/search?q=${encodeURIComponent(k)}`),
        parse: searchPairsParse,
      }]
      : []),
    // 'gecko_trending' (all ages, chore/slim-down) and 'gecko_volume' (fix/young-sources) were removed; their names
    // stay allowlisted by tokens_sources_check for the stored history.
    {
      source: 'gecko_trending_1h',
      group: 'gecko',
      urls: geckoPageUrls(GECKO_TRENDING_1H_PATH, GECKO_TRENDING_1H_PAGES),
      parse: youngPoolsParse,
    },
    {
      source: 'gecko_pumpswap',
      group: 'gecko',
      urls: geckoPageUrls(GECKO_PUMPSWAP_PATH, GECKO_PUMPSWAP_PAGES),
      parse: youngPoolsParse,
    },
    {
      source: 'gecko_new_pools',
      group: 'gecko',
      urls: geckoPageUrls(GECKO_NEW_POOLS_PATH, GECKO_NEW_POOLS_PAGES),
      parse: youngPoolsParse,
    },
    {
      source: 'jup_recent',
      group: 'jup',
      urls: [`${jup}${JUP_RECENT_PATH}`],
      parse: (p) => parseJupRecent(p, now()),
    },
  ];
}

/**
 * Runs every source. DexScreener lists in parallel, GeckoTerminal and Jupiter requests through their pacers
 * (the three groups run concurrently). A source is `failed` when none of its requests gave a usable payload;
 * an exception in one source (fetch or parser) never reaches the others.
 */
export async function collectSources(deps: CollectDeps): Promise<CollectResult> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const now = deps.now ?? Date.now;
  const jobs = sourceJobs(deps.jupBase, deps.keywords ?? [], now).filter((j) => deps.includeGecko !== false || j.group !== 'gecko');
  const lists: SourceList[] = [];
  const searchPairs: DexPair[] = [];
  const excluded = new Set<string>();
  const failed: SourceName[] = [];
  const jupTokens = new Map<string, JupiterToken>();
  const skipped = new Set<SourceName>();
  const stopped = new Set<Job['group']>();
  const late = () => deps.deadline !== undefined && now() >= deps.deadline;

  const runJob = async (job: Job): Promise<void> => {
    const mints: string[] = [];
    let ok = 0;
    for (const url of job.urls) {
      if (stopped.has(job.group) || late()) {
        skipped.add(job.source);
        break;
      }
      try {
        if (job.group === 'jup') await deps.jupPace();
        else if (job.group === 'gecko') await deps.geckoPace();
        // The pacer may have waited past the deadline or a 429 may have arrived meanwhile.
        if (stopped.has(job.group) || late()) {
          skipped.add(job.source);
          break;
        }
        const payload = await deps.fetchJson(url);
        if (payload === null || payload === undefined) continue;
        const parsed = job.parse(payload);
        ok++;
        mints.push(...parsed.mints);
        for (const m of parsed.excluded ?? []) excluded.add(m);
        if (parsed.pairs) searchPairs.push(...parsed.pairs);
        for (const t of parsed.tokens ?? []) if (!jupTokens.has(t.id)) jupTokens.set(t.id, t);
        if (parsed.more === false) break;
      } catch (e) {
        if (e instanceof RateLimitedError) {
          stopped.add(job.group);
          log(`source ${job.source} rate limited`);
        } else log(`source ${job.source} failed: ${e instanceof Error ? e.name : 'error'}`);
      }
    }
    if (ok === 0) failed.push(job.source);
    lists.push({ source: job.source, mints });
  };

  // Sequential inside a group that shares a pacer would serialise anyway; dex jobs are fully parallel.
  const runGroup = async (group: Job['group']) => {
    const groupJobs = jobs.filter((j) => j.group === group);
    if (group === 'dex') await Promise.all(groupJobs.map(runJob));
    else for (const j of groupJobs) await runJob(j);
  };
  await Promise.all([runGroup('dex'), runGroup('gecko'), runGroup('jup')]);

  // Canonical list order (job order) so mergeSources' insertion order does not depend on network timing.
  const order = new Map(jobs.map((j, i) => [j.source, i]));
  lists.sort((a, b) => (order.get(a.source) ?? 0) - (order.get(b.source) ?? 0));
  failed.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  for (const m of excluded) jupTokens.delete(m);
  const bySource = (a: SourceName, b: SourceName) => (order.get(a) ?? 0) - (order.get(b) ?? 0);
  return {
    lists,
    searchPairs,
    excluded,
    failed,
    jupTokens,
    skipped: [...skipped].sort(bySource),
    rateLimited: (['dex', 'gecko', 'jup'] as const).filter((g) => stopped.has(g)),
  };
}

/**
 * Production fetcher: SOURCE_HOSTS only, no redirect, 8 s timeout, body cap, cancelled by `signal`; null on any
 * failure, RateLimitedError on HTTP 429. Headers (e.g. Jupiter x-api-key) are chosen per URL by `headersFor`.
 */
export function sourceFetcher(
  headersFor: (url: string) => Record<string, string> = () => ({}),
  signal?: AbortSignal,
  fetchFn?: ClientFetch,
): FetchJson {
  return async (url) => {
    let status = 0;
    const data = await getJson(url, {
      hosts: SOURCE_HOSTS,
      timeoutMs: SOURCE_TIMEOUT_MS,
      headers: headersFor(url),
      signal,
      fetchFn,
      onStatus: (st) => {
        status = st;
      },
    });
    if (status === 429) throw new RateLimitedError();
    return data;
  };
}

// ---------------------------------------------------------------------------------------------------------
// Candidates and migrations
// ---------------------------------------------------------------------------------------------------------

/**
 * Lists without quote assets, and the non-DexScreener sources (GeckoTerminal, Jupiter, young watch) without the mints
 * Jupiter tags as non-memecoins. DexScreener lists keep their pre-existing behaviour (only quote assets removed).
 */
export function withoutExcluded(lists: readonly SourceList[], excluded: ReadonlySet<string>): SourceList[] {
  return lists.map((l) => {
    const legacy = l.source.startsWith('dex_');
    const kept = [...new Set(l.mints.filter((m) => !QUOTE_MINTS.has(m) && (legacy || !excluded.has(m))))];
    return { source: l.source, mints: kept.slice(0, l.source === 'dex_search' ? DEX_SEARCH_CAP : DEFAULT_CAP_PER_SOURCE) };
  });
}

export interface CandidatePlan {
  merged: Map<string, SourceName[]>;
  /** Mints to load from DexScreener /tokens/v1 (budgeted), then the migration watch list. */
  fetchMints: string[];
}

/**
 * Merged sources (scanner-quant's mergeSources) and the DexScreener fetch list: every mint except the ones
 * brought ONLY by the keyword search (their pairs are already there), within MAX_PAIR_MINTS (prioritizeMints:
 * mints seen by more sources first), plus the pump.fun watch list (migration detection).
 */
export function planCandidates(
  lists: readonly SourceList[],
  watch: ReadonlyMap<string, string>,
  maxMints = MAX_PAIR_MINTS,
): CandidatePlan {
  const merged = mergeAll(lists);
  const fetchable = new Map<string, SourceName[]>();
  for (const [mint, sources] of merged) {
    if (!(sources.length === 1 && sources[0] === 'dex_search')) fetchable.set(mint, sources);
  }
  const fetchMints = prioritizeMints(fetchable, maxMints);
  const seen = new Set(fetchMints);
  let added = 0;
  for (const mint of watch.keys()) {
    if (added >= MIGRATION_WATCH_MAX) break;
    if (!seen.has(mint) && isSolanaAddress(mint)) {
      fetchMints.push(mint);
      seen.add(mint);
      added++;
    }
  }
  return { merged, fetchMints };
}

const isMigratedDex = (dexId: string): boolean => {
  const d = dexId.toLowerCase();
  return d === 'pumpswap' || d.includes('raydium');
};

/**
 * Fresh migrations visible in the pairs already fetched: a PumpSwap/Raydium pair created less than `windowMs`
 * ago for a pump.fun token (the same response also lists its 'pumpfun' bonding-curve pair, or the mint has the
 * pump.fun vanity suffix "pump"). Sorted, deduped.
 */
export function recentMigrationsFromPairs(
  pairs: readonly DexPair[],
  nowMs: number,
  windowMs = FRESH_MIGRATION_WINDOW_MS,
): string[] {
  const hasCurve = new Set<string>();
  const freshAmm = new Set<string>();
  for (const p of pairs) {
    if (p.chainId !== 'solana') continue;
    const mint = p.baseToken.address;
    if (!isSolanaAddress(mint)) continue;
    const dex = (p.dexId ?? '').toLowerCase();
    if (dex === 'pumpfun') hasCurve.add(mint);
    else if (
      isMigratedDex(dex) && typeof p.pairCreatedAt === 'number' && p.pairCreatedAt <= nowMs + 60_000 &&
      nowMs - p.pairCreatedAt <= windowMs
    ) freshAmm.add(mint);
  }
  return [...freshAmm].filter((m) => hasCurve.has(m) || m.endsWith('pump')).sort();
}

/**
 * Adds 'migration' to the merged sources: tokens persisted as 'pumpfun' whose best pair is now PumpSwap/Raydium
 * (scanner-quant's detectMigrations), plus fresh migrations seen in the fetched pairs (only for mints that are
 * candidates or watched). Returns the new map (merged is not mutated) and the migrated mints.
 */
export function addMigrations(
  lists: readonly SourceList[],
  watch: ReadonlyMap<string, string>,
  bestPairs: readonly DexPair[],
  allPairs: readonly DexPair[],
  nowMs: number,
): { merged: Map<string, SourceName[]>; migrated: string[] } {
  const current = new Map<string, string>();
  for (const p of bestPairs) current.set(p.baseToken.address, p.dexId ?? '');
  const base = mergeAll(lists);
  const between = detectMigrations(watch, current);
  const fresh = recentMigrationsFromPairs(allPairs, nowMs).filter((m) => base.has(m) || watch.has(m));
  const migrated = [...new Set([...between, ...fresh])].sort();
  const merged = migrated.length > 0 ? mergeAll([...lists, { source: 'migration', mints: migrated }]) : base;
  return { merged, migrated };
}

/** Adds tokens.sources (allowlisted, canonical order, ≤ 10) to each upsert row. */
export function withSources<R extends { mint: string }>(
  rows: readonly R[],
  merged: ReadonlyMap<string, readonly SourceName[]>,
): (R & { sources: string[] })[] {
  return rows.map((r) => ({ ...r, sources: sourcesColumn([...(merged.get(r.mint) ?? [])]) }));
}
