import { isSolanaAddress } from '@raijin/shared-util';
import * as z from 'zod';
import { UpstreamError } from '../core/errors';
import { lenientArray } from './lenient';
import { getJson, pathSegment, type RestTransport } from './rest';

const address = z.string().refine(isSolanaAddress);
const numeric = z.union([z.number(), z.string().max(40)]).transform((value) => Number(value));

const tokenRefSchema = z.object({
  address,
  name: z.string().max(1024).optional(),
  symbol: z.string().max(1024).optional(),
});

/** Paire DexScreener (champs lus). Doc : https://docs.dexscreener.com/api/reference */
const pairSchema = z.object({
  chainId: z.string().max(32),
  dexId: z.string().max(64),
  pairAddress: address,
  labels: z.array(z.string().max(32)).max(10).nullish(),
  baseToken: tokenRefSchema,
  quoteToken: tokenRefSchema,
  priceUsd: numeric.nullish(),
  /** `base` / `quote` : réserves en unités de tokens (passe rapide des suivis, √(base × quote)). */
  liquidity: z.object({ usd: z.number().nullish(), base: z.number().nullish(), quote: z.number().nullish() }).nullish(),
  pairCreatedAt: z.number().int().nullish(),
});
export type DexPair = z.infer<typeof pairSchema>;

const pairsArraySchema = lenientArray(pairSchema, 200);

/** Paires relues depuis un cache (Redis de l'hôte) : revalidées comme une réponse externe. */
export function parseCachedPairs(value: unknown): DexPair[] | null {
  const parsed = pairsArraySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
const pairLookupSchema = z.object({ pairs: lenientArray(pairSchema, 30).nullable() });

/** Taille maximale d'un lot DexScreener (`tokens/v1` et `latest/dex/pairs` : 30 adresses). */
export const DEXSCREENER_BATCH_MAX = 30;

function batchSegment(addresses: readonly string[]): string {
  if (addresses.length === 0 || addresses.length > DEXSCREENER_BATCH_MAX) throw new RangeError('Lot DexScreener invalide.');
  return addresses.map(pathSegment).join(',');
}

/** Client DexScreener (300 req/min sur ces routes, doc officielle). */
export class DexScreenerClient {
  constructor(private readonly transport: RestTransport) {}

  /** Pools du token sur Solana (jusqu'à 30, route `token-pairs/v1`). */
  async getTokenPairs(mint: string, signal?: AbortSignal): Promise<DexPair[]> {
    return getJson(this.transport, 'token-pairs', `/token-pairs/v1/solana/${pathSegment(mint)}`, signal, (response) => {
      if (response.status === 404) return [];
      if (response.status !== 200) throw new UpstreamError('dexscreener', 'http_error', response.status);
      const parsed = pairsArraySchema.safeParse(response.body);
      if (!parsed.success) throw new UpstreamError('dexscreener', 'invalid_response', response.status);
      return parsed.data.filter((pair) => pair.chainId === 'solana');
    });
  }

  /**
   * Paires de plusieurs tokens (≤ 30, route `tokens/v1`, vérifiée le 22/11/2026 : une paire
   * principale par token, réserves `liquidity.base` / `liquidity.quote`). Passe rapide des suivis.
   */
  async getTokensPairs(mints: readonly string[], signal?: AbortSignal): Promise<DexPair[]> {
    return getJson(this.transport, 'tokens', `/tokens/v1/solana/${batchSegment(mints)}`, signal, (response) => {
      if (response.status === 404) return [];
      if (response.status !== 200) throw new UpstreamError('dexscreener', 'http_error', response.status);
      const parsed = pairsArraySchema.safeParse(response.body);
      if (!parsed.success) throw new UpstreamError('dexscreener', 'invalid_response', response.status);
      return parsed.data.filter((pair) => pair.chainId === 'solana');
    });
  }

  /** Paires par adresse (≤ 30, `latest/dex/pairs`) : relecture des pools déjà suivis. */
  async getPairs(pairAddresses: readonly string[], signal?: AbortSignal): Promise<DexPair[]> {
    return getJson(this.transport, 'pairs', `/latest/dex/pairs/solana/${batchSegment(pairAddresses)}`, signal, (response) => {
      if (response.status === 404) return [];
      if (response.status !== 200) throw new UpstreamError('dexscreener', 'http_error', response.status);
      const parsed = pairLookupSchema.safeParse(response.body);
      if (!parsed.success) throw new UpstreamError('dexscreener', 'invalid_response', response.status);
      const wanted = new Set(pairAddresses);
      return (parsed.data.pairs ?? []).filter((pair) => pair.chainId === 'solana' && wanted.has(pair.pairAddress));
    });
  }

  /** Paire par adresse (résolution d'un lien DexScreener de paire vers le mint). `null` si inconnue. */
  async getPair(pairAddress: string, signal?: AbortSignal): Promise<DexPair | null> {
    return getJson(this.transport, 'pairs', `/latest/dex/pairs/solana/${pathSegment(pairAddress)}`, signal, (response) => {
      if (response.status === 404) return null;
      if (response.status !== 200) throw new UpstreamError('dexscreener', 'http_error', response.status);
      const parsed = pairLookupSchema.safeParse(response.body);
      if (!parsed.success) throw new UpstreamError('dexscreener', 'invalid_response', response.status);
      return parsed.data.pairs?.find((pair) => pair.chainId === 'solana' && pair.pairAddress === pairAddress) ?? null;
    });
  }
}
