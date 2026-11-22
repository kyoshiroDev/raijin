import * as z from 'zod';
import { UpstreamError } from '../core/errors';
import type { CreditBudget, CreditLane } from '../core/ports';
import { callJsonRpc, type JsonRpcTransport } from './json-rpc';
import { lenientArray } from './lenient';

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

/** Taille maximale d'un lot `getAssetBatch` (doc Helius : 1 000 actifs par requête). */
export const DAS_BATCH_MAX = 1_000;
const assetBatchSchema = lenientArray(assetSchema, DAS_BATCH_MAX);

/** Client Helius DAS (clé requise). */
export class HeliusDasClient {
  constructor(
    private readonly transport: JsonRpcTransport | null,
    private readonly budget: CreditBudget,
    readonly lane: CreditLane = 'interactive',
  ) {}

  /** Même client, crédits décomptés sur une autre voie. */
  withLane(lane: CreditLane): HeliusDasClient {
    return new HeliusDasClient(this.transport, this.budget, lane);
  }

  /** Même client, crédits réservés via `budget` (compteur d'un scan). */
  withBudget(budget: CreditBudget): HeliusDasClient {
    return new HeliusDasClient(this.transport, budget, this.lane);
  }

  get configured(): boolean {
    return this.transport !== null;
  }

  async getAsset(mint: string, signal?: AbortSignal): Promise<DasAsset> {
    if (this.transport === null) throw new UpstreamError('helius_das', 'not_configured');
    // Crédits décomptés à chaque tentative (rejeux compris).
    const consume = async () => {
      if (!(await this.budget.tryConsume(DAS_CREDITS_PER_CALL, this.lane))) throw new UpstreamError('helius_das', 'budget_exhausted');
    };
    return callJsonRpc(this.transport, 'getAsset', { id: mint }, assetSchema, signal, consume);
  }

  /**
   * Actifs d'un lot de mints (`getAssetBatch`, ≤ 1 000 ids, 10 crédits l'appel ; doc :
   * https://www.helius.dev/docs/api-reference/das/getassetbatch). Entrée absente, `null` ou
   * malformée : ignorée. Clé : id de l'actif, recoupé avec la demande.
   */
  async getAssetBatch(mints: readonly string[], signal?: AbortSignal): Promise<Map<string, DasAsset>> {
    if (this.transport === null) throw new UpstreamError('helius_das', 'not_configured');
    if (mints.length === 0 || mints.length > DAS_BATCH_MAX) throw new RangeError('Lot DAS invalide.');
    const consume = async () => {
      if (!(await this.budget.tryConsume(DAS_CREDITS_PER_CALL, this.lane))) throw new UpstreamError('helius_das', 'budget_exhausted');
    };
    const assets = await callJsonRpc(this.transport, 'getAssetBatch', { ids: [...mints] }, assetBatchSchema, signal, consume);
    const wanted = new Set(mints);
    return new Map(assets.filter((asset) => wanted.has(asset.id)).map((asset) => [asset.id, asset]));
  }
}
