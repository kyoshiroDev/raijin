import { z } from 'zod';
import { UpstreamError } from '../core/errors';
import { lenientArray } from './lenient';
import { getJson, pathSegment, type RestTransport } from './rest';

const address = z.string().min(32).max(44);
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
  liquidity: z.object({ usd: z.number().nullish() }).nullish(),
  pairCreatedAt: z.number().int().nullish(),
});
export type DexPair = z.infer<typeof pairSchema>;

const pairsArraySchema = lenientArray(pairSchema, 200);
const pairLookupSchema = z.object({ pairs: lenientArray(pairSchema, 30).nullable() });

/** Client DexScreener (300 req/min sur ces routes, doc officielle). */
export class DexScreenerClient {
  constructor(private readonly transport: RestTransport) {}

  /** Pools du token sur Solana (jusqu'à 30, route `token-pairs/v1`). */
  async getTokenPairs(mint: string, signal?: AbortSignal): Promise<DexPair[]> {
    const response = await getJson(this.transport, 'token-pairs', `/token-pairs/v1/solana/${pathSegment(mint)}`, signal);
    if (response.status === 404) return [];
    if (response.status !== 200) throw new UpstreamError('dexscreener', 'http_error', response.status);
    const parsed = pairsArraySchema.safeParse(response.body);
    if (!parsed.success) throw new UpstreamError('dexscreener', 'invalid_response', response.status);
    return parsed.data.filter((pair) => pair.chainId === 'solana');
  }

  /** Paire par adresse (résolution d'un lien DexScreener de paire vers le mint). `null` si inconnue. */
  async getPair(pairAddress: string, signal?: AbortSignal): Promise<DexPair | null> {
    const response = await getJson(this.transport, 'pairs', `/latest/dex/pairs/solana/${pathSegment(pairAddress)}`, signal);
    if (response.status === 404) return null;
    if (response.status !== 200) throw new UpstreamError('dexscreener', 'http_error', response.status);
    const parsed = pairLookupSchema.safeParse(response.body);
    if (!parsed.success) throw new UpstreamError('dexscreener', 'invalid_response', response.status);
    return parsed.data.pairs?.find((pair) => pair.chainId === 'solana' && pair.pairAddress === pairAddress) ?? null;
  }
}
