// Market context features of the « ×3 minimum » model, computed once per scan (feat/x3-model).
// - SOL 24 h change: Jupiter tokens v2 search for the SOL mint (same host family as the scan's audits), through
//   enrich-clients' getJson: fixed https Jupiter hosts only, redirect: 'error', timeout, body cap, never throws.
//   Real response (checked 2026-11-17, lite-api.jup.ag/tokens/v2/search?query=So111…112): an array with one item
//   { id: "So11111111111111111111111111111111111111112", symbol: "SOL", usdPrice: 72.98…,
//     stats24h: { priceChange: 1.726…, liquidityChange, volumeChange, buyVolume, … }, stats1h: {…}, … }.
//   `stats24h.priceChange` is in PERCENT (1.73 % here; DexScreener's SOL/USDC pair said +1.85 % at the same time).
//   feat/more-sources: the SAME request also asks for EURC (query=<SOL>,<EURC>, still one call) and returns the SOL
//   `usdPrice` and the EUR/USD rate (EURC `usdPrice`, checked 2026-11-17: EURC id
//   HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr, symbol "EURC", usdPrice 1.1003…), stored in scan_runs.sol_usd / eur_usd.
// - Total 24 h volume of the scanned tokens: pure sum.
import { z } from 'zod/v3';
import { type ClientOptions, getJson, resolveJupBase, SOL_MINT } from './enrich-clients';

/** Plausible bounds for a 24 h change of SOL, PERCENT. Anything outside is treated as unknown. */
export const SOL_CHANGE_BOUNDS = [-95, 1000] as const;
export const MARKET_TIMEOUT_MS = 5_000;

/** Circle EURC on Solana (verified on lite-api.jup.ag/tokens/v2/search, 2026-11-17). */
export const EURC_MINT = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr';
/** Plausible SOL price bounds (USD), exclusive. Same bounds as the scan_runs.sol_usd CHECK. */
export const SOL_USD_BOUNDS = [0, 100_000] as const;
/** Plausible EUR/USD bounds, exclusive. Same bounds as the scan_runs.eur_usd CHECK. */
export const EUR_USD_BOUNDS = [0.5, 2] as const;

const SolItemSchema = z.object({
  id: z.string().max(64),
  usdPrice: z.number().finite().optional().catch(undefined),
  stats24h: z.object({ priceChange: z.number().finite().optional().catch(undefined) }).partial().optional().catch(undefined),
});

/** Untrusted Jupiter search payload → SOL 24 h change in PERCENT, or null. Items are validated one by one. */
export function parseSolChange24h(input: unknown): number | null {
  if (!Array.isArray(input)) return null;
  for (const item of input.slice(0, 20)) {
    const r = SolItemSchema.safeParse(item);
    if (!r.success || r.data.id !== SOL_MINT) continue;
    const v = r.data.stats24h?.priceChange;
    if (typeof v !== 'number' || v < SOL_CHANGE_BOUNDS[0] || v > SOL_CHANGE_BOUNDS[1]) return null;
    return Math.round(v * 10_000) / 10_000;
  }
  return null;
}

export interface MarketOptions extends ClientOptions {
  /** JUP_API_BASE (validated by resolveJupBase: Jupiter hosts only). */
  jupBase?: string | null;
}

/** usdPrice of `mint` in an untrusted Jupiter search payload, kept only inside (lo, hi) exclusive; else null. */
function priceOf(input: unknown, mint: string, [lo, hi]: readonly [number, number]): number | null {
  if (!Array.isArray(input)) return null;
  for (const item of input.slice(0, 20)) {
    const r = SolItemSchema.safeParse(item);
    if (!r.success || r.data.id !== mint) continue;
    const v = r.data.usdPrice;
    return typeof v === 'number' && v > lo && v < hi ? v : null;
  }
  return null;
}

export interface MarketQuotes {
  /** SOL 24 h change, PERCENT. */
  solChange24h: number | null;
  /** SOL price, USD. */
  solUsd: number | null;
  /** EUR/USD (USD per 1 EUR), from the EURC price. */
  eurUsd: number | null;
}

/** Untrusted Jupiter search payload (SOL + EURC) → market quotes; each field independently null when unusable. */
export function parseMarketQuotes(input: unknown): MarketQuotes {
  return {
    solChange24h: parseSolChange24h(input),
    solUsd: priceOf(input, SOL_MINT, SOL_USD_BOUNDS),
    eurUsd: priceOf(input, EURC_MINT, EUR_USD_BOUNDS),
  };
}

function marketUrl(opts: MarketOptions, mints: string[]): string {
  const base = resolveJupBase(opts.jupBase ?? undefined);
  return `${base}/tokens/v2/search?query=${mints.map(encodeURIComponent).join(',')}`;
}

/** SOL 24 h change (PERCENT) or null on any failure. One request, ≤ 5 s. */
export async function fetchSolChange24h(opts: MarketOptions = {}): Promise<number | null> {
  const url = marketUrl(opts, [SOL_MINT]);
  return parseSolChange24h(await getJson(url, { ...opts, timeoutMs: Math.min(opts.timeoutMs ?? MARKET_TIMEOUT_MS, MARKET_TIMEOUT_MS) }));
}

/** SOL 24 h change + SOL/USD + EUR/USD in ONE Jupiter request (≤ 5 s). All null on failure, never throws. */
export async function fetchMarketQuotes(opts: MarketOptions = {}): Promise<MarketQuotes> {
  const url = marketUrl(opts, [SOL_MINT, EURC_MINT]);
  return parseMarketQuotes(await getJson(url, { ...opts, timeoutMs: Math.min(opts.timeoutMs ?? MARKET_TIMEOUT_MS, MARKET_TIMEOUT_MS) }));
}

/** Sum of the finite, non-negative 24 h volumes (USD) of the scanned tokens; null when there is none. */
export function scanVolume24h(tokens: readonly { volume24h: number | null | undefined }[]): number | null {
  let sum = 0;
  let n = 0;
  for (const t of tokens) {
    const v = t.volume24h;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      sum += v;
      n++;
    }
  }
  return n > 0 ? sum : null;
}

export interface MarketContext {
  solChange24h: number | null;
  scanVolume24h: number | null;
}
