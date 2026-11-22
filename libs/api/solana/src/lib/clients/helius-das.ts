import { z } from 'zod';
import { UpstreamError } from '../core/errors';
import type { CreditBudget } from '../core/ports';
import { callJsonRpc, type JsonRpcTransport } from './json-rpc';

/** Coût d'un appel DAS (doc Helius « Credits » : 10 crédits). */
export const DAS_CREDITS_PER_CALL = 10;

const address = z.string().min(32).max(44);

/** Sous-ensemble de `getAsset` lu par Raijin (doc : https://www.helius.dev/docs/api-reference/das/getasset). */
const assetSchema = z.object({
  interface: z.string().max(40).optional(),
  id: address,
  content: z
    .object({
      metadata: z
        .object({ name: z.string().max(1024).optional(), symbol: z.string().max(1024).optional() })
        .optional(),
    })
    .optional(),
  authorities: z.array(z.object({ address, scopes: z.array(z.string().max(32)).max(10).optional() })).max(10).optional(),
  creators: z.array(z.object({ address, verified: z.boolean().optional() })).max(10).optional(),
  mutable: z.boolean(),
  burnt: z.boolean().optional(),
});
export type DasAsset = z.infer<typeof assetSchema>;

/** Client Helius DAS (clé requise). */
export class HeliusDasClient {
  constructor(
    private readonly transport: JsonRpcTransport | null,
    private readonly budget: CreditBudget,
  ) {}

  get configured(): boolean {
    return this.transport !== null;
  }

  async getAsset(mint: string, signal?: AbortSignal): Promise<DasAsset> {
    if (this.transport === null) throw new UpstreamError('helius_das', 'not_configured');
    if (!(await this.budget.tryConsume(DAS_CREDITS_PER_CALL))) throw new UpstreamError('helius_das', 'budget_exhausted');
    return callJsonRpc(this.transport, 'getAsset', { id: mint }, assetSchema, signal);
  }
}
