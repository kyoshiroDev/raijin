import * as z from 'zod';
import { UpstreamError } from '../core/errors';
import { lenientArray, optionalAddress } from './lenient';
import { getJson, pathSegment, type RestTransport } from './rest';

const address = z.string().min(32).max(44);

const riskSchema = z.object({
  name: z.string().max(1024),
  level: z.string().max(32).optional(),
});

const marketSchema = z.object({
  pubkey: address,
  marketType: z.string().max(64),
  liquidityA: optionalAddress,
  liquidityB: optionalAddress,
  lp: z
    .object({
      lpLockedPct: z.number().nullish(),
      baseUSD: z.number().nullish(),
      quoteUSD: z.number().nullish(),
    })
    .nullish(),
});

const holderSchema = z.object({
  address,
  owner: address,
  pct: z.number().finite(),
});

/**
 * Rapport RugCheck (champs lus, route publique sans clé `GET /v1/tokens/{mint}/report`).
 * Doc : https://api.rugcheck.xyz/swagger/index.html
 */
const reportSchema = z.object({
  score_normalised: z.number().nullish(),
  rugged: z.boolean().nullish(),
  risks: lenientArray(riskSchema, 500).nullish(),
  lpLockedPct: z.number().nullish(),
  creator: optionalAddress,
  creatorTokens: lenientArray(
    z.object({ mint: address, marketCap: z.number().nullish(), createdAt: z.string().max(64).nullish() }),
    10_000,
  ).nullish(),
  markets: lenientArray(marketSchema, 10_000).nullish(),
  topHolders: lenientArray(holderSchema, 200).nullish(),
  knownAccounts: z.record(z.string().max(44), z.object({ type: z.string().max(32).optional() })).nullish(),
  tokenMeta: z
    .object({
      name: z.string().max(1024).nullish(),
      symbol: z.string().max(1024).nullish(),
      mutable: z.boolean().nullish(),
      updateAuthority: optionalAddress,
    })
    .nullish(),
});
export type RugCheckReport = z.infer<typeof reportSchema> & { readonly complete: boolean };

/** Client RugCheck : rapport complet, repli sur le résumé si le rapport dépasse la taille maximale. */
export class RugCheckClient {
  constructor(private readonly transport: RestTransport) {}

  /** `null` si RugCheck ne connaît pas le token. */
  async getReport(mint: string, signal?: AbortSignal): Promise<RugCheckReport | null> {
    try {
      return await this.fetchReport('report', `/tokens/${pathSegment(mint)}/report`, true, signal);
    } catch (error) {
      // Les tokens très actifs ont des rapports de plusieurs Mo : on se contente du résumé.
      if (!(error instanceof UpstreamError) || error.kind !== 'too_large') throw error;
      return this.fetchReport('report-summary', `/tokens/${pathSegment(mint)}/report/summary`, false, signal);
    }
  }

  private async fetchReport(route: string, path: string, complete: boolean, signal?: AbortSignal): Promise<RugCheckReport | null> {
    const response = await getJson(this.transport, route, path, signal);
    if (response.status === 404) return null;
    if (response.status !== 200) throw new UpstreamError('rugcheck', 'http_error', response.status);
    const parsed = reportSchema.safeParse(response.body);
    if (!parsed.success) throw new UpstreamError('rugcheck', 'invalid_response', 200);
    return { ...parsed.data, complete };
  }
}
