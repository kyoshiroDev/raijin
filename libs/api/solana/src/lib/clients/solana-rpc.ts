import { isSolanaAddress } from '@raijin/shared-util';
import * as z from 'zod';
import { TokenUnanalyzableError, UpstreamError } from '../core/errors';
import type { CreditBudget, CreditLane, SolanaLogger } from '../core/ports';
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

/** `getAccountInfo` jsonParsed avec l'indicateur `executable` (nature d'une adresse de wallet). */
const accountNatureSchema = z.object({
  value: z
    .object({
      owner: address,
      executable: z.boolean().optional(),
      data: z.unknown(),
    })
    .nullable(),
});

/** Nature d'une adresse saisie comme wallet (ARCHITECTURE.md §12.3, étape 1). */
export type AccountNature = 'absent' | 'mint' | 'token_account' | 'program' | 'other';

const tokenAmountSchema = z.object({
  amount: z.string().regex(/^\d{1,20}$/),
  decimals: z.number().int().min(0).max(255),
});

const solanaAddress = z.string().refine(isSolanaAddress);

/**
 * Compte de token jsonParsed (`solana-account-decoder` : `UiTokenAccount`, champs camelCase ;
 * `delegate` / `delegatedAmount` absents sans délégation, `state` `initialized` | `frozen`).
 */
const tokenAccountEntrySchema = z.object({
  pubkey: solanaAddress,
  account: z.object({
    owner: z.enum([SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM]),
    data: z.object({
      parsed: z.object({
        type: z.string().max(32).optional(),
        info: z.object({
          mint: solanaAddress,
          owner: solanaAddress,
          state: z.enum(['initialized', 'frozen', 'uninitialized']),
          tokenAmount: tokenAmountSchema,
          delegate: solanaAddress.nullish(),
          delegatedAmount: tokenAmountSchema.nullish(),
        }),
      }),
    }),
  }),
});

/** Compte de token d'un wallet, validé (donnée externe hostile : adresses base58, u64 bornés). */
export interface ParsedTokenAccount {
  readonly pubkey: string;
  readonly program: 'spl-token' | 'token-2022';
  readonly mint: string;
  readonly owner: string;
  /** Solde brut (u64 en texte). */
  readonly amount: string;
  readonly decimals: number;
  readonly frozen: boolean;
  /** Délégué actif, `null` sans délégation. */
  readonly delegate: string | null;
  /** Montant délégué brut (u64 en texte), `null` sans délégation. */
  readonly delegatedAmount: string | null;
}

export interface TokenAccountsResult {
  /** Comptes valides appartenant bien au propriétaire demandé. */
  readonly accounts: ParsedTokenAccount[];
  /** Nombre d'entrées reçues (valides ou non) : sert au plafond `WALLET_TOO_LARGE`. */
  readonly received: number;
  /** Entrées ignorées (format inattendu ou propriétaire incohérent). */
  readonly rejected: number;
}

export type ParsedMint = z.infer<typeof parsedMintSchema>['info'] & { program: 'spl-token' | 'token-2022' };

/** Compte jsonParsed → mint SPL / Token-2022, `null` si absent ou si ce n'est pas un mint. */
function toParsedMint(value: { owner: string; data: unknown } | null): ParsedMint | null {
  if (value === null || (value.owner !== SPL_TOKEN_PROGRAM && value.owner !== TOKEN_2022_PROGRAM)) return null;
  const data = value.data;
  const parsed =
    typeof data === 'object' && data !== null && !Array.isArray(data) && 'parsed' in data
      ? parsedMintSchema.safeParse((data as { parsed: unknown }).parsed)
      : null;
  if (parsed === null || !parsed.success) return null;
  return { ...parsed.data.info, program: value.owner === TOKEN_2022_PROGRAM ? 'token-2022' : 'spl-token' };
}

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
    /** Voie de crédits décomptée par ce client (`withLane` pour les passes de suivi). */
    readonly lane: CreditLane = 'interactive',
  ) {}

  get heliusConfigured(): boolean {
    return this.helius !== null;
  }

  /** Même client (mêmes files de débit), crédits décomptés sur une autre voie. */
  withLane(lane: CreditLane): SolanaRpcClient {
    return new SolanaRpcClient(this.helius, this.publicRpc, this.budget, this.logger, lane);
  }

  /** Même client, crédits réservés via `budget` (compteur d'un scan posé sur le budget partagé). */
  withBudget(budget: CreditBudget): SolanaRpcClient {
    return new SolanaRpcClient(this.helius, this.publicRpc, budget, this.logger, this.lane);
  }

  /** Même client (mêmes files de débit), délai par appel `timeoutMs` (listes de comptes volumineuses). */
  withTimeout(timeoutMs: number): SolanaRpcClient {
    const retime = (endpoint: RpcEndpoint): RpcEndpoint => ({ ...endpoint, transport: { ...endpoint.transport, timeoutMs } });
    return new SolanaRpcClient(this.helius === null ? null : retime(this.helius), retime(this.publicRpc), this.budget, this.logger, this.lane);
  }

  private async call<T>(method: string, params: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<RpcCallResult<T>> {
    if (this.helius !== null) {
      // 1 crédit par tentative (rejeux compris, mineur m2) ; budget épuisé → RPC public.
      const consume = async () => {
        if (!(await this.budget.tryConsume(1, this.lane))) throw new UpstreamError('helius_rpc', 'budget_exhausted');
      };
      try {
        return { value: await callJsonRpc(this.helius.transport, method, params, schema, signal, consume), servedBy: 'helius' };
      } catch (error) {
        if (signal?.aborted) throw error;
        // Réponse trop volumineuse : propriété du compte, pas une panne ; le RPC public dirait pareil.
        if (error instanceof UpstreamError && error.kind === 'too_large') throw error;
        const kind = error instanceof UpstreamError ? error.kind : 'network';
        if (kind === 'budget_exhausted') this.logger.warn('helius_budget_exhausted', { method, lane: this.lane });
        else this.logger.warn('helius_fallback_public_rpc', { method, kind });
      }
    }
    return { value: await callJsonRpc(this.publicRpc.transport, method, params, schema, signal), servedBy: 'solana_rpc' };
  }

  /**
   * Compte de mint (jsonParsed). `null` si le compte n'existe pas ou n'est pas un mint.
   * Réponse de plus de 2 Mo : `TokenUnanalyzableError` (le compte existe ; `dataSlice` est
   * incompatible avec jsonParsed, on ne peut pas savoir à coût nul si c'est un mint, mineur m4).
   */
  async getMint(mint: string, signal?: AbortSignal): Promise<RpcCallResult<ParsedMint | null>> {
    let result: RpcCallResult<z.infer<typeof accountInfoSchema>>;
    try {
      result = await this.call('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }], accountInfoSchema, signal);
    } catch (error) {
      if (error instanceof UpstreamError && error.kind === 'too_large') throw new TokenUnanalyzableError();
      throw error;
    }
    return { value: toParsedMint(result.value.value), servedBy: result.servedBy };
  }

  /**
   * Comptes de mint par lot (≤ 100, `getMultipleAccounts` jsonParsed, 1 crédit). Index aligné sur
   * `mints`, `null` si absent ou pas un mint. Réponse trop volumineuse : `UpstreamError('too_large')`
   * (l'appelant coupe le lot).
   */
  async getMints(mints: readonly string[], signal?: AbortSignal): Promise<RpcCallResult<Array<ParsedMint | null>>> {
    const result = await this.call(
      'getMultipleAccounts',
      [mints, { encoding: 'jsonParsed', commitment: 'confirmed' }],
      multipleAccountsSchema,
      signal,
    );
    if (result.value.value.length !== mints.length) throw new UpstreamError(result.servedBy === 'helius' ? 'helius_rpc' : 'solana_rpc', 'invalid_response');
    return { value: result.value.value.map((account) => toParsedMint(account)), servedBy: result.servedBy };
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

  /**
   * Nature d'une adresse saisie comme wallet (`getAccountInfo` jsonParsed, 1 crédit) : `absent`
   * (wallet sans SOL), `program` (exécutable), `mint`, `token_account` (compte de token ou multisig
   * des programmes de token), `other` (wallet, PDA…). Compte de plus de 2 Mo : `UpstreamError('too_large')`.
   */
  async getAccountNature(addressValue: string, signal?: AbortSignal): Promise<RpcCallResult<AccountNature>> {
    const result = await this.call('getAccountInfo', [addressValue, { encoding: 'jsonParsed', commitment: 'confirmed' }], accountNatureSchema, signal);
    const account = result.value.value;
    let nature: AccountNature = 'other';
    if (account === null) nature = 'absent';
    else if (account.executable === true) nature = 'program';
    else if (account.owner === SPL_TOKEN_PROGRAM || account.owner === TOKEN_2022_PROGRAM) {
      nature = toParsedMint({ owner: account.owner, data: account.data }) === null ? 'token_account' : 'mint';
    }
    return { value: nature, servedBy: result.servedBy };
  }

  /**
   * Comptes de token d'un propriétaire pour un programme (`getTokenAccountsByOwner` jsonParsed,
   * 1 crédit) : tous les comptes, vides compris, avec délégations et état gelé. Réponse de plus de
   * 2 Mo : `UpstreamError('too_large')` (wallet hors normes).
   */
  async getTokenAccountsByOwner(owner: string, programId: typeof SPL_TOKEN_PROGRAM | typeof TOKEN_2022_PROGRAM, signal?: AbortSignal): Promise<RpcCallResult<TokenAccountsResult>> {
    const result = await this.call(
      'getTokenAccountsByOwner',
      [owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
      z.object({ value: z.array(z.unknown()) }),
      signal,
    );
    const accounts: ParsedTokenAccount[] = [];
    let rejected = 0;
    for (const entry of result.value.value) {
      const parsed = tokenAccountEntrySchema.safeParse(entry);
      if (!parsed.success || parsed.data.account.owner !== programId || parsed.data.account.data.parsed.info.owner !== owner) {
        rejected += 1;
        continue;
      }
      const info = parsed.data.account.data.parsed.info;
      const delegate = info.delegate ?? null;
      accounts.push({
        pubkey: parsed.data.pubkey,
        program: programId === TOKEN_2022_PROGRAM ? 'token-2022' : 'spl-token',
        mint: info.mint,
        owner: info.owner,
        amount: info.tokenAmount.amount,
        decimals: info.tokenAmount.decimals,
        frozen: info.state === 'frozen',
        delegate,
        delegatedAmount: delegate === null ? null : (info.delegatedAmount?.amount ?? '0'),
      });
    }
    return { value: { accounts, received: result.value.value.length, rejected }, servedBy: result.servedBy };
  }
}
