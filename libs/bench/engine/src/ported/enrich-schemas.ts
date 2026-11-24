// Runtime validation of the enrich-tokens external payloads (Jupiter quote, RugCheck, GeckoTerminal).
// Every response is untrusted: anything that does not parse is dropped (the client returns null).
// Field names checked against real responses on 2026-11-16 (fixtures in enrich_test.ts).
import { z } from 'zod/v3';

const numish = z.union([z.number(), z.string().max(100)]).transform((v) => Number(v)).pipe(z.number().finite());
/** Non-negative integer amount encoded as a decimal string (token base units / lamports). */
const intString = z.string().regex(/^\d{1,30}$/);
const mintLike = z.string().min(32).max(44);

/**
 * Jupiter `GET /swap/v1/quote` (lite-api.jup.ag, no key).
 * Real sample: { inputMint, inAmount: "100000000", outputMint, outAmount: "305760000000",
 *   priceImpactPct: "0.0020035366103494735287860805", swapMode: "ExactIn", routePlan: [...] }.
 * priceImpactPct is a FRACTION (0.0069 = 0.69 %): verified by comparing quotes of 0.001 / 0.1 / 10 SOL
 * and a full round trip (buy 0.69 % + sell 1.02 % ~ round-trip cost 1.76 %).
 */
export const JupQuoteSchema = z.object({
  inputMint: mintLike,
  outputMint: mintLike,
  inAmount: intString,
  outAmount: intString,
  priceImpactPct: numish,
  swapMode: z.string().max(16).optional(),
  routePlan: z.array(z.unknown()).max(50).optional(),
});
export type JupQuote = z.infer<typeof JupQuoteSchema>;

/**
 * One RugCheck risk. Real sample: { name: "Low Liquidity", value: "$273.07", score: 2726, level: "danger" }.
 * Names seen on 25 fresh tokens (2026-11-17): « Low Liquidity » (danger/warn), « Creator history of rugged
 * tokens » (danger), « Mutable metadata » (warn).
 */
export const RugRiskSchema = z.object({
  name: z.string().max(200),
  level: z.string().max(32),
});
export type RugRisk = z.infer<typeof RugRiskSchema>;

/**
 * RugCheck `GET /v1/tokens/{mint}/report/summary` (no key).
 * Real sample: { tokenProgram, tokenType: "", risks: [...], score: 8834, score_normalised: 48,
 *   lpLockedPct: 99.98881614497041 }. `score` is raw and unbounded (1 … 33601 seen), higher = riskier.
 * Invalid optional fields are dropped (undefined) without discarding the rest; risks are validated one by one.
 */
export const RugSummarySchema = z.object({
  score: z.number().finite().nonnegative().optional().catch(undefined),
  score_normalised: z.number().finite().nonnegative().optional().catch(undefined),
  lpLockedPct: z.number().finite().min(0).max(100).optional().catch(undefined),
  risks: z.array(z.unknown()).max(100).optional().catch(undefined),
});
export type RugSummary = z.infer<typeof RugSummarySchema>;

/**
 * RugCheck FULL report `GET /v1/tokens/{mint}/report` (no key), read ONLY for the insider graph: the summary has
 * no insider field. Checked on 2026-11-17 on 6 fresh pump.fun tokens: top-level `graphInsidersDetected` is an
 * integer (0, 4, 5, 25, 40 seen) and `insiderNetworks` an array or null. Bodies are 9–95 KB (getJson caps 2 MB).
 * Everything else in the report is ignored (score/risks identical to the summary; the summary's lpLockedPct has
 * no top-level equivalent here, so the summary call is kept).
 */
export const RugReportInsidersSchema = z.object({
  graphInsidersDetected: z.number().int().nonnegative().max(1e9).nullable().optional().catch(undefined),
});
export type RugReportInsiders = z.infer<typeof RugReportInsidersSchema>;

const geckoRel = z.object({ data: z.object({ id: z.string().max(100) }) }).optional();

/**
 * One pool of GeckoTerminal `GET /networks/solana/pools/multi/{addr,…}` (data[] items).
 * Real sample: { id: "solana_B8a1…", type: "pool", attributes: { address, reserve_in_usd: "95340.4401",
 *   base_token_price_usd: "0.00165…", quote_token_price_usd: "72.14…", … },
 *   relationships: { base_token: { data: { id: "solana_<mint>" } }, quote_token: { … } } }.
 * The pool may list our token as base OR quote: the price is picked from the matching side only.
 */
export const GeckoPoolSchema = z.object({
  attributes: z.object({
    address: mintLike,
    reserve_in_usd: numish.nullable().optional().catch(undefined),
    base_token_price_usd: numish.nullable().optional().catch(undefined),
    quote_token_price_usd: numish.nullable().optional().catch(undefined),
  }),
  relationships: z.object({ base_token: geckoRel, quote_token: geckoRel }).partial().optional().catch(undefined),
});
export type GeckoPool = z.infer<typeof GeckoPoolSchema>;

export const GeckoMultiSchema = z.object({ data: z.array(z.unknown()).max(100) });
