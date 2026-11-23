import { mintAddressSchema } from '@raijin/shared-contracts';
import * as z from './zod';
import { countSchema, externalTextSchema, isoDateTimeSchema, listResponseSchema, nonNegativeSchema } from './common';

/**
 * Tokens suivis par le banc (`public.tokens`, `public.token_snapshots`, `public.scan_runs`).
 * Les textes (nom, symbole, dangers RugCheck, narratif) sont hostiles : bornés ici, nettoyés à
 * l'affichage par le front. Colonnes archivées (slim-down 2026-11-21) : absentes du contrat.
 */
export const DATA_CONFIDENCES = ['high', 'medium', 'low'] as const;
export const dataConfidenceSchema = z.enum(DATA_CONFIDENCES);

const urlText = externalTextSchema(500).nullable();
const optionalNumber = z.number().nullable();

export const tokenRowSchema = z.object({
  mint: mintAddressSchema,
  symbol: externalTextSchema(64),
  name: externalTextSchema(128),
  pair_address: z.string().max(64),
  dex_id: z.string().max(64),
  image_url: urlText,
  website_url: urlText,
  x_url: urlText,
  telegram_url: urlText,
  price_usd: nonNegativeSchema,
  market_cap: nonNegativeSchema,
  liquidity_usd: nonNegativeSchema,
  liquidity_jup_usd: optionalNumber,
  volume_24h: nonNegativeSchema,
  change_1h: z.number(),
  change_24h: z.number(),
  buys_1h: countSchema,
  sells_1h: countSchema,
  pair_created_at: isoDateTimeSchema.nullable(),
  flags: z.array(externalTextSchema(120)).max(20),
  mint_authority_disabled: z.boolean().nullable(),
  freeze_authority_disabled: z.boolean().nullable(),
  top10_pct: optionalNumber,
  holder_count: countSchema.nullable(),
  organic_score: optionalNumber,
  first_seen_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
  liquidity_dex_usd: optionalNumber,
  liquidity_gecko_usd: optionalNumber,
  liquidity_effective_usd: optionalNumber,
  /** Écart entre sources, en FRACTION (0,5 = 50 %). */
  liquidity_divergence: optionalNumber,
  /** Coût d'aller-retour en POURCENT pour 0,1 SOL (devis Jupiter). */
  roundtrip_cost_pct: optionalNumber,
  roundtrip_fee_pct: optionalNumber,
  buy_impact_pct: optionalNumber,
  lp_locked_pct: optionalNumber,
  rugcheck_score: optionalNumber,
  rugcheck_dangers: z.array(externalTextSchema(200)).max(20),
  price_jup_usd: optionalNumber,
  price_gecko_usd: optionalNumber,
  data_confidence: dataConfidenceSchema.nullable(),
  quote_at: isoDateTimeSchema.nullable(),
  rugcheck_at: isoDateTimeSchema.nullable(),
  enriched_at: isoDateTimeSchema.nullable(),
  narrative: externalTextSchema(64).nullable(),
  narrative_rank: z.number().int().positive().nullable(),
  insiders_detected: z.boolean().nullable(),
  creator_rug_history: z.boolean().nullable(),
  /** Prix des 6 dernières heures, du plus ancien au plus récent. */
  spark_6h: z.array(z.number()).max(500).nullable(),
});
export type BenchTokenRow = z.infer<typeof tokenRowSchema>;

export const TOKENS_LIMIT_MAX = 500;
/** `GET /api/tokens?since=&limit=` : tokens mis à jour depuis `since`, paires les plus jeunes d'abord. */
export const tokenListQuerySchema = z.object({
  since: isoDateTimeSchema,
  limit: z.coerce.number().int().min(1).max(TOKENS_LIMIT_MAX).default(200),
});
export type TokenListQuery = z.infer<typeof tokenListQuerySchema>;
export const tokenListResponseSchema = listResponseSchema(tokenRowSchema, TOKENS_LIMIT_MAX);
export type TokenListResponse = z.infer<typeof tokenListResponseSchema>;

/** `GET /api/tokens/:mint` → `BenchTokenRow` (404 sinon). */
export const tokenParamsSchema = z.object({ mint: mintAddressSchema });

/** Liste de mints en paramètre (`?mints=a,b,c`), 100 au plus. */
export const MINTS_PER_QUERY_MAX = 100;
export const mintListQuerySchema = z.object({
  mints: z
    .string()
    .transform((value) => value.split(',').filter((m) => m.length > 0))
    .pipe(z.array(mintAddressSchema).min(1).max(MINTS_PER_QUERY_MAX)),
});
export type MintListQuery = z.infer<typeof mintListQuerySchema>;

/** `GET /api/tokens/briefs?mints=` : symbole et dernier prix (tokens, sinon dernier snapshot). */
export const tokenBriefSchema = z.object({
  mint: mintAddressSchema,
  symbol: externalTextSchema(64).nullable(),
  price_usd: nonNegativeSchema.nullable(),
});
export type TokenBrief = z.infer<typeof tokenBriefSchema>;
export const tokenBriefsResponseSchema = listResponseSchema(tokenBriefSchema, MINTS_PER_QUERY_MAX);

/** `GET /api/tokens/:mint/snapshots?since=` : historique de prix, du plus ancien au plus récent. */
export const SNAPSHOTS_LIMIT_MAX = 2000;
export const snapshotQuerySchema = z.object({ since: isoDateTimeSchema });
export const pricePointSchema = z.object({ price_usd: nonNegativeSchema, captured_at: isoDateTimeSchema });
export type BenchPricePoint = z.infer<typeof pricePointSchema>;
export const snapshotsResponseSchema = listResponseSchema(pricePointSchema, SNAPSHOTS_LIMIT_MAX);

/** `GET /api/market/rates` : derniers taux connus (`scan_runs`), `null` si aucun. */
export const marketRatesSchema = z.object({ sol_usd: z.number().positive(), eur_usd: z.number().positive().nullable() });
export type MarketRates = z.infer<typeof marketRatesSchema>;
export const marketRatesResponseSchema = z.object({ rates: marketRatesSchema.nullable() });
