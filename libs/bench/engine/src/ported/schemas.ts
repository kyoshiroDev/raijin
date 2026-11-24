// Runtime validation of external payloads. Anything that does not parse is dropped.
import { z } from 'zod/v3';

const numish = z.union([z.number(), z.string()]).transform((v) => Number(v)).pipe(z.number().finite());
const txWindow = z.object({ buys: z.number().int().nonnegative(), sells: z.number().int().nonnegative() }).partial();

export const DexPairSchema = z.object({
  chainId: z.string(),
  dexId: z.string().max(64).optional().default(''),
  url: z.string().max(500).optional(),
  pairAddress: z.string().max(64),
  baseToken: z.object({
    address: z.string().max(64),
    name: z.string().max(500).optional().default(''),
    symbol: z.string().max(200).optional().default(''),
  }),
  priceUsd: numish.optional(),
  txns: z.object({ m5: txWindow, h1: txWindow, h6: txWindow, h24: txWindow }).partial().optional(),
  volume: z.object({ m5: z.number(), h1: z.number(), h6: z.number(), h24: z.number() }).partial().optional(),
  priceChange: z.object({ m5: z.number(), h1: z.number(), h6: z.number(), h24: z.number() }).partial().optional(),
  liquidity: z.object({ usd: z.number().optional() }).partial().optional(),
  fdv: z.number().optional(),
  marketCap: z.number().optional(),
  pairCreatedAt: z.number().optional(),
  info: z
    .object({
      imageUrl: z.string().max(500).optional(),
      websites: z.array(z.object({ url: z.string().max(500) }).partial()).max(20).optional(),
      socials: z.array(z.object({ type: z.string().max(32), url: z.string().max(500) }).partial()).max(20).optional(),
    })
    .partial()
    .optional(),
});
export type DexPair = z.infer<typeof DexPairSchema>;

export const DexTokenRefSchema = z.object({ chainId: z.string(), tokenAddress: z.string().max(64) });

export const GeckoOhlcvSchema = z.object({
  data: z.object({
    attributes: z.object({
      ohlcv_list: z.array(z.tuple([z.number(), numish, numish, numish, numish, numish])).max(1000),
    }),
  }),
});

export const JupiterTokenSchema = z
  .object({
    id: z.string().max(64),
    holderCount: z.number().nonnegative().optional(),
    organicScore: z.number().optional(),
    // Pool liquidity in USD (verified on lite-api.jup.ag/tokens/v2/search: top-level number).
    // An invalid value is dropped (undefined) without discarding the rest of the audit.
    liquidity: z.number().finite().nonnegative().optional().catch(undefined),
    // Token price in USD (verified on the same endpoint: top-level number), used for the price consensus.
    usdPrice: z.number().finite().nonnegative().optional().catch(undefined),
    // Holder change over the window, PERCENT (verified on lite-api.jup.ag/tokens/v2/recent on 2026-11-21: 6 holders and
    // +50 → 4 holders before; for a token younger than the window it is the change since creation). Point-in-time
    // source of features.holder_growth_1h / _6h at a first detection (feat/calm-sl-test). Invalid → dropped.
    stats1h: z.object({ holderChange: z.number().finite().optional().catch(undefined) }).passthrough().optional().catch(undefined),
    stats6h: z.object({ holderChange: z.number().finite().optional().catch(undefined) }).passthrough().optional().catch(undefined),
    audit: z
      .object({
        mintAuthorityDisabled: z.boolean().optional(),
        freezeAuthorityDisabled: z.boolean().optional(),
        topHoldersPercentage: z.number().optional(),
      })
      .partial()
      .optional(),
  })
  .passthrough();
export type JupiterToken = z.infer<typeof JupiterTokenSchema>;

/** Parses each item independently and keeps only the valid ones. */
export function parseEach<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T[] {
  if (!Array.isArray(input)) return [];
  const out: T[] = [];
  for (const item of input) {
    const r = schema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out;
}
