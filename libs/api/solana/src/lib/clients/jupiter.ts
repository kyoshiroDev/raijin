import { z } from 'zod';
import { UpstreamError } from '../core/errors';
import { getJson, pathSegment, type RestTransport } from './rest';

const u64String = z.string().regex(/^\d{1,30}$/);

/** Devis Jupiter (champs lus). Doc : https://developers.jup.ag/docs/swap/get-quote */
const quoteSchema = z.object({
  inAmount: u64String,
  outAmount: u64String,
  /** Fraction (0,29 = 29 %), vérifié sur un devis réel de 100 000 USD. */
  priceImpactPct: z.union([z.string().max(64), z.number()]).transform((value) => Number(value)),
  routePlan: z.array(z.unknown()).max(20),
});

const quoteErrorSchema = z.object({ error: z.string().max(500).optional(), errorCode: z.string().max(64).optional() });

/** Codes Jupiter signifiant « aucune route de vente » (constatés : TOKEN_NOT_TRADABLE, NO_ROUTES_FOUND). */
const NO_ROUTE_CODES = new Set(['COULD_NOT_FIND_ANY_ROUTE', 'NO_ROUTES_FOUND', 'TOKEN_NOT_TRADABLE', 'ROUTE_NOT_FOUND']);

export type SellQuote =
  | { readonly routeFound: true; readonly inAmount: bigint; readonly outAmount: bigint; readonly priceImpactPct: number; readonly hops: number }
  | { readonly routeFound: false };

/**
 * Client Jupiter **devis seulement** (`/quote`) : aucune transaction n'est construite, signée ni
 * envoyée ; la route `/swap` n'existe pas dans ce client.
 */
export class JupiterQuoteClient {
  constructor(
    private readonly transport: RestTransport,
    private readonly slippageBps: number,
  ) {}

  async getSellQuote(inputMint: string, outputMint: string, amount: bigint, signal?: AbortSignal): Promise<SellQuote> {
    const query =
      `inputMint=${pathSegment(inputMint)}&outputMint=${pathSegment(outputMint)}` +
      `&amount=${amount.toString()}&slippageBps=${Math.trunc(this.slippageBps)}`;
    const response = await getJson(this.transport, 'quote', `/quote?${query}`, signal);
    if (response.status === 200) {
      const parsed = quoteSchema.safeParse(response.body);
      if (!parsed.success || !Number.isFinite(parsed.data.priceImpactPct)) {
        throw new UpstreamError('jupiter', 'invalid_response', 200);
      }
      return {
        routeFound: true,
        inAmount: BigInt(parsed.data.inAmount),
        outAmount: BigInt(parsed.data.outAmount),
        priceImpactPct: parsed.data.priceImpactPct,
        hops: parsed.data.routePlan.length,
      };
    }
    if (response.status === 400 || response.status === 404) {
      const parsed = quoteErrorSchema.safeParse(response.body);
      if (parsed.success && parsed.data.errorCode !== undefined && NO_ROUTE_CODES.has(parsed.data.errorCode)) {
        return { routeFound: false };
      }
    }
    throw new UpstreamError('jupiter', 'http_error', response.status);
  }
}
