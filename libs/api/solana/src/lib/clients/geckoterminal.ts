import { z } from 'zod';
import { UpstreamError } from '../core/errors';
import { lenientArray } from './lenient';
import { getJson, pathSegment, type RestTransport } from './rest';

const numericString = z
  .union([z.string().max(64), z.number()])
  .nullish()
  .transform((value) => (value === null || value === undefined ? null : Number(value)))
  .refine((value) => value === null || Number.isFinite(value));

/** Pool GeckoTerminal (champs lus). Doc : https://www.geckoterminal.com/dex-api */
const poolSchema = z.object({
  id: z.string().max(120),
  attributes: z.object({
    address: z.string().min(32).max(44),
    pool_created_at: z.iso.datetime({ offset: true }).nullish(),
    reserve_in_usd: numericString,
    base_token_price_usd: numericString,
  }),
  relationships: z
    .object({ base_token: z.object({ data: z.object({ id: z.string().max(120) }).nullish() }).nullish() })
    .nullish(),
});
export type GeckoPool = z.infer<typeof poolSchema>;

const poolsSchema = z.object({ data: lenientArray(poolSchema, 200) });

/** Client GeckoTerminal (API publique : ~10 appels/min). */
export class GeckoTerminalClient {
  constructor(private readonly transport: RestTransport) {}

  async getTokenPools(mint: string, signal?: AbortSignal): Promise<GeckoPool[]> {
    const response = await getJson(this.transport, 'token-pools', `/networks/solana/tokens/${pathSegment(mint)}/pools`, signal);
    if (response.status === 404) return [];
    if (response.status !== 200) throw new UpstreamError('geckoterminal', 'http_error', response.status);
    const parsed = poolsSchema.safeParse(response.body);
    if (!parsed.success) throw new UpstreamError('geckoterminal', 'invalid_response', response.status);
    return parsed.data.data;
  }
}
