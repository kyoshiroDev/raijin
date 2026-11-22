import { z } from 'zod';
import { UpstreamError } from '../core/errors';
import type { CreditBudget, SolanaLogger } from '../core/ports';
import { callJsonRpc, type JsonRpcTransport } from './json-rpc';

/** Programmes de token reconnus. */
export const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const address = z.string().min(32).max(44);
const u64String = z.string().regex(/^\d{1,30}$/);

const extensionSchema = z.object({
  extension: z.string().max(64),
  state: z.record(z.string(), z.unknown()).optional(),
});

const parsedMintSchema = z.object({
  type: z.literal('mint'),
  info: z.object({
    mintAuthority: address.nullable().optional(),
    freezeAuthority: address.nullable().optional(),
    supply: u64String,
    decimals: z.number().int().min(0).max(255),
    isInitialized: z.boolean().optional(),
    extensions: z.array(extensionSchema).max(64).optional(),
  }),
});

const accountInfoSchema = z.object({
  value: z
    .object({
      owner: address,
      data: z.union([
        z.object({ program: z.string().max(64), parsed: z.unknown() }),
        z.array(z.string()),
        z.string(),
      ]),
    })
    .nullable(),
});

export type ParsedMint = z.infer<typeof parsedMintSchema>['info'] & { program: 'spl-token' | 'token-2022' };

const largestAccountsSchema = z.object({
  value: z
    .array(z.object({ address, amount: u64String }))
    .max(50),
});

const parsedTokenAccountSchema = z.object({
  data: z.object({
    parsed: z.object({
      type: z.string().max(32),
      info: z.object({ owner: address, mint: address.optional() }),
    }),
  }),
});

const multipleAccountsSchema = z.object({
  value: z.array(z.object({ owner: address, data: z.unknown() }).nullable()).max(100),
});

const signaturesSchema = z
  .array(
    z.object({
      signature: z.string().max(100),
      slot: z.number().int().min(0),
      blockTime: z.number().int().nullable().optional(),
      err: z.unknown().optional(),
    }),
  )
  .max(1_000);
export type SignatureInfo = z.infer<typeof signaturesSchema>[number];

export interface RpcEndpoint {
  readonly transport: JsonRpcTransport;
  /** `helius` : crédits comptés ; `solana_rpc` : RPC public. */
  readonly id: 'helius' | 'solana_rpc';
}

export interface RpcCallResult<T> {
  readonly value: T;
  readonly servedBy: 'helius' | 'solana_rpc';
}

/**
 * Client RPC Solana : Helius si la clé est présente et le budget du jour disponible, sinon RPC
 * public. Un échec Helius bascule une fois sur le RPC public (ARCHITECTURE.md §9.3, §9.4).
 */
export class SolanaRpcClient {
  constructor(
    private readonly helius: RpcEndpoint | null,
    private readonly publicRpc: RpcEndpoint,
    private readonly budget: CreditBudget,
    private readonly logger: SolanaLogger,
  ) {}

  get heliusConfigured(): boolean {
    return this.helius !== null;
  }

  private async call<T>(method: string, params: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<RpcCallResult<T>> {
    if (this.helius !== null) {
      if (await this.budget.tryConsume(1)) {
        try {
          return { value: await callJsonRpc(this.helius.transport, method, params, schema, signal), servedBy: 'helius' };
        } catch (error) {
          if (signal?.aborted) throw error;
          const kind = error instanceof UpstreamError ? error.kind : 'network';
          this.logger.warn('helius_fallback_public_rpc', { method, kind });
        }
      } else {
        this.logger.warn('helius_budget_exhausted', { method });
      }
    }
    return { value: await callJsonRpc(this.publicRpc.transport, method, params, schema, signal), servedBy: 'solana_rpc' };
  }

  /** Compte de mint (jsonParsed). `null` si le compte n'existe pas ou n'est pas un mint. */
  async getMint(mint: string, signal?: AbortSignal): Promise<RpcCallResult<ParsedMint | null>> {
    const result = await this.call('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }], accountInfoSchema, signal);
    const value = result.value.value;
    if (value === null || (value.owner !== SPL_TOKEN_PROGRAM && value.owner !== TOKEN_2022_PROGRAM)) {
      return { value: null, servedBy: result.servedBy };
    }
    const data = value.data;
    const parsed = typeof data === 'object' && !Array.isArray(data) ? parsedMintSchema.safeParse(data.parsed) : null;
    if (parsed === null || !parsed.success) return { value: null, servedBy: result.servedBy };
    return {
      value: { ...parsed.data.info, program: value.owner === TOKEN_2022_PROGRAM ? 'token-2022' : 'spl-token' },
      servedBy: result.servedBy,
    };
  }

  /** 20 plus gros comptes de token (souvent refusé par le RPC public : 429). */
  async getTokenLargestAccounts(mint: string, signal?: AbortSignal) {
    const result = await this.call('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }], largestAccountsSchema, signal);
    return { value: result.value.value, servedBy: result.servedBy };
  }

  /** Propriétaires des comptes de token (jsonParsed). Index aligné sur `tokenAccounts`, `null` si inconnu. */
  async getTokenAccountOwners(tokenAccounts: readonly string[], signal?: AbortSignal) {
    const result = await this.call(
      'getMultipleAccounts',
      [tokenAccounts, { encoding: 'jsonParsed', commitment: 'confirmed' }],
      multipleAccountsSchema,
      signal,
    );
    const owners = result.value.value.map((account) => {
      const parsed = parsedTokenAccountSchema.safeParse(account);
      return parsed.success ? parsed.data.data.parsed.info.owner : null;
    });
    return { value: owners, servedBy: result.servedBy };
  }

  /** Programme propriétaire de chaque compte (sans données). Index aligné, `null` si le compte n'existe pas. */
  async getAccountPrograms(addresses: readonly string[], signal?: AbortSignal) {
    const result = await this.call(
      'getMultipleAccounts',
      [addresses, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }],
      multipleAccountsSchema,
      signal,
    );
    return { value: result.value.value.map((account) => account?.owner ?? null), servedBy: result.servedBy };
  }

  async getSignaturesForAddress(addressValue: string, limit: number, before: string | undefined, signal?: AbortSignal) {
    const options: Record<string, unknown> = { limit, commitment: 'confirmed' };
    if (before !== undefined) options['before'] = before;
    return this.call('getSignaturesForAddress', [addressValue, options], signaturesSchema, signal);
  }

  /** Réservé au scan de wallet (phase 5) : comptes de token d'un propriétaire. */
  async getTokenAccountsByOwner(owner: string, programId: string, signal?: AbortSignal) {
    return this.call(
      'getTokenAccountsByOwner',
      [owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
      z.object({ value: z.array(z.object({ pubkey: address, account: z.unknown() })).max(5_000) }),
      signal,
    );
  }
}
