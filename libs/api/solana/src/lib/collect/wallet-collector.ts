import {
  ANALYSIS_CHECK_IDS,
  RISK_FACTS_VERSION,
  TOKEN_NAME_MAX_LENGTH,
  TOKEN_SYMBOL_MAX_LENGTH,
  dataSourceIdSchema,
  dataSourceRefSchema,
  knownNonWalletKind,
  riskFactsSchema,
  tokenMetadataSchema,
  type DataSourceId,
  type RiskFacts,
  type TokenAmount,
  type TokenMetadata,
  type TokenProgram,
  type WalletDelegation,
  type WalletUnavailableReason,
} from '@raijin/shared-contracts';
import { isSolanaAddress } from '@raijin/shared-util';
import * as z from 'zod';
import { DEXSCREENER_BATCH_MAX, parseCachedPairs, type DexPair, type DexScreenerClient } from '../clients/dexscreener';
import { DAS_BATCH_MAX, type DasAsset, type HeliusDasClient } from '../clients/helius-das';
import {
  SPL_TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  type ParsedMint,
  type ParsedTokenAccount,
  type RpcCallResult,
  type SolanaRpcClient,
} from '../clients/solana-rpc';
import type { SolanaDataConfig } from '../config';
import {
  UpstreamError,
  WalletInvalidError,
  WalletIsTokenError,
  WalletTooLargeError,
  toUpstreamError,
  type UpstreamErrorKind,
} from '../core/errors';
import { MeteredCreditBudget } from '../core/memory';
import type { CacheStore, Clock, CreditBudget, SolanaLogger } from '../core/ports';
import { KNOWN_AMM_PROGRAMS, KNOWN_EXCLUDED_OWNERS } from '../known-accounts';
import {
  buildCheckSources,
  buildLiquidityFacts,
  buildMintAccountFacts,
  concentration,
  mainPoolCreatedAt,
  poolAddresses,
  priceUsd,
  shareOf,
  token2022Metadata,
  type HolderEntry,
} from './builders';
import { SourceTracker, cleanName, type CollectedFacts, type SourceReport } from './facts-collector';

/** Taille maximale d'un lot `getMultipleAccounts` (doc Solana : 100 comptes). */
const RPC_BATCH = 100;
/** Paires gardées par mint dans le cache (pool principal et suivants). */
const PAIRS_PER_MINT = 10;
const U64 = /^\d{1,20}$/;
const LIGHT_CACHE_PREFIX = 'solana:light-facts:v1:';
const PAIRS_CACHE_PREFIX = 'solana:wallet-pairs:';

// --- Types publics ---------------------------------------------------------------------------------

export interface WalletHoldingsOptions {
  /** Tokens analysés (défaut : `config.wallet.maxTokens`, `maxTokensNoKey` sans clé Helius). */
  readonly maxTokens?: number;
  /** Plafond de comptes de tokens (défaut : `config.wallet.maxAccounts`, 1 000). */
  readonly maxAccounts?: number;
  /** Mints dont le prix est demandé (défaut : `config.wallet.priceLookupMax`, 150). */
  readonly priceLookupMax?: number;
  /** Seuil de poussière en USD (défaut : `config.wallet.dustUsd`, 1). */
  readonly dustUsd?: number;
  /** Annulation par l'hôte (échéance globale du scan). */
  readonly signal?: AbortSignal;
}

/** Sort d'un token dans le scan : à analyser, poussière (prix connu, valeur < seuil), au-delà du plafond. */
export type WalletHoldingSelection = 'analyze' | 'dust' | 'over_limit';

/** Token fongible détenu (comptes d'un même mint agrégés, solde non nul). */
export interface WalletHolding {
  readonly mint: string;
  readonly tokenProgram: TokenProgram;
  /** Nom / symbole **non fiables** (DexScreener, nettoyés) ; complétés par `collectFactsLightBatch`. */
  readonly token: TokenMetadata;
  readonly balance: TokenAmount;
  /** Prix indicatif DexScreener (médiane des paires où le token est la base), `null` si inconnu. */
  readonly priceUsd: number | null;
  /** Valeur indicative (solde × prix), `null` si le prix est inconnu. */
  readonly valueUsd: number | null;
  readonly accountCount: number;
  readonly frozen: boolean;
  readonly delegated: boolean;
  readonly selection: WalletHoldingSelection;
}

export interface WalletHoldingsSummary {
  /** Comptes de tokens reçus (SPL + Token-2022, valides ou non). */
  readonly accountCount: number;
  /** Entrées ignorées (format inattendu, propriétaire incohérent). */
  readonly rejectedAccountCount: number;
  /** Mints fongibles à solde non nul. */
  readonly tokenCount: number;
  readonly analyzeCount: number;
  readonly dustCount: number;
  readonly overLimitCount: number;
  /** Comptes probablement NFT (0 décimale, solde 1). */
  readonly nftCount: number;
  /** Comptes vides sans délégation (ceux qui en portent une sont dans `delegations`). */
  readonly emptyAccountCount: number;
  readonly delegationCount: number;
  /** Somme des valeurs connues, `null` si aucune n'est connue. */
  readonly totalValueUsd: number | null;
}

export interface WalletHoldings {
  readonly address: string;
  /** Triés par valeur connue décroissante, puis valeur inconnue (mint croissant à égalité). */
  readonly tokens: WalletHolding[];
  /** Délégations actives (tous les comptes : vides, poussière et NFT compris), contrat `walletDelegationSchema`. */
  readonly delegations: WalletDelegation[];
  readonly summary: WalletHoldingsSummary;
  /** Plafond de tokens analysés appliqué. */
  readonly maxTokens: number;
  /** Source des comptes : Helius, ou RPC public (pas de clé, budget épuisé, panne). */
  readonly accountsSource: 'helius' | 'solana_rpc';
  /** Faux si au moins un lot de prix DexScreener a échoué (valeurs inconnues, aucune poussière déduite). */
  readonly pricesComplete: boolean;
  /** Sources interrogées (contrat `walletScanResultSchema.sources`). */
  readonly sources: DataSourceId[];
  /** Crédits Helius consommés par cet appel. */
  readonly credits: number;
}

export interface LightFactsBatchOptions {
  readonly signal?: AbortSignal;
  /** Échéance propre (défaut : `config.wallet.deadlineMs`). */
  readonly deadlineMs?: number;
}

export type LightFactsEntry =
  | {
      readonly mint: string;
      readonly status: 'ok';
      /** Faits `light` (profil sans devis, créateur ni RugCheck) prêts pour le moteur avec la règle D3. */
      readonly collected: CollectedFacts;
      /** Faits repris du cache `light` (≤ `lightFactsCacheTtlSeconds`). */
      readonly fromCache: boolean;
    }
  | { readonly mint: string; readonly status: 'unavailable'; readonly reason: WalletUnavailableReason };

export interface LightFactsBatch {
  /** Une entrée par mint distinct, dans l'ordre d'entrée. */
  readonly entries: LightFactsEntry[];
  /** Crédits Helius consommés par cet appel. */
  readonly credits: number;
  /** Le budget Helius (global ou voie `wallet`) a refusé au moins une réservation. */
  readonly budgetExhausted: boolean;
  /** L'échéance ou l'annulation a interrompu une partie de la collecte. */
  readonly timedOut: boolean;
}

export interface WalletCollectorDeps {
  readonly config: SolanaDataConfig;
  /** Client RPC sur la voie `wallet`. */
  readonly rpc: SolanaRpcClient;
  /** Client DAS sur la voie `wallet`. */
  readonly das: HeliusDasClient;
  readonly dexscreener: DexScreenerClient;
  /** Budget partagé (un compteur par appel est posé dessus). */
  readonly budget: CreditBudget;
  readonly cache: CacheStore;
  readonly clock: Clock;
  readonly logger: SolanaLogger;
}

// --- Utilitaires -----------------------------------------------------------------------------------

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function kindOf(error: unknown): UpstreamErrorKind {
  return error instanceof UpstreamError ? error.kind : 'network';
}

/** Montant décimal exact `raw / 10^decimals` (zéros finaux retirés). */
export function formatTokenAmount(raw: bigint, decimals: number): TokenAmount {
  const digits = raw.toString();
  if (decimals === 0) return { raw: digits, decimals, ui: digits };
  const padded = digits.padStart(decimals + 1, '0');
  const integer = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return { raw: digits, decimals, ui: fraction === '' ? integer : `${integer}.${fraction}` };
}

function finitePositive(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Signal annulé à l'échéance ou par l'hôte. */
function deadlineSignal(ms: number, parent?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  (timer as { unref?: () => void }).unref?.();
  const onAbort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

/** Faits `light` relus depuis le cache de l'hôte : revalidés (le cache n'est pas une source de confiance). */
const cachedLightFactsSchema = z.object({
  profile: z.literal('light'),
  facts: riskFactsSchema,
  token: tokenMetadataSchema,
  checkSources: z.record(z.enum(ANALYSIS_CHECK_IDS), z.array(dataSourceRefSchema).max(6)),
  sources: z
    .array(
      z.object({
        id: dataSourceIdSchema,
        status: z.enum(['ok', 'error', 'skipped']),
        latencyMs: z.number().finite().min(0).nullable(),
        errorKind: z.string().max(32).nullable(),
      }),
    )
    .max(12),
  degraded: z.boolean(),
});

interface MintRead {
  readonly mint: string;
  readonly result: { status: 'ok'; parsed: ParsedMint; servedBy: DataSourceId } | { status: 'not_found' | 'unanalyzable' } | { status: 'error'; kind: UpstreamErrorKind };
}

// --- Collecteur ------------------------------------------------------------------------------------

/**
 * Scan de wallet (ARCHITECTURE.md §12) : liste des avoirs et délégations d'une adresse publique, puis
 * faits `light` d'un lot de mints par appels groupés. **Lecture seule** : aucune transaction n'est
 * construite, signée ni envoyée ; aucune clé privée n'est jamais demandée.
 */
export class WalletCollector {
  constructor(private readonly deps: WalletCollectorDeps) {}

  // --- Avoirs ----------------------------------------------------------------------------------------

  /**
   * Avoirs d'un wallet. Lève `WalletInvalidError`, `WalletIsTokenError`, `WalletTooLargeError` (avant
   * toute collecte coûteuse) ou `UpstreamError` si la liste des comptes est impossible à lire.
   * Coût : 3 crédits avec clé (nature + 2 listes), prix DexScreener gratuits.
   */
  async listHoldings(address: string, options: WalletHoldingsOptions = {}): Promise<WalletHoldings> {
    if (!isSolanaAddress(address)) throw new WalletInvalidError('malformed');
    const known = knownNonWalletKind(address);
    if (known === 'mint') throw new WalletIsTokenError();
    if (known === 'program') throw new WalletInvalidError('program');

    const { config, logger } = this.deps;
    const metered = new MeteredCreditBudget(this.deps.budget);
    const rpc = this.deps.rpc.withBudget(metered);
    const signal = options.signal;
    const maxAccounts = options.maxAccounts ?? config.wallet.maxAccounts;
    const maxTokens = options.maxTokens ?? (rpc.heliusConfigured ? config.wallet.maxTokens : config.wallet.maxTokensNoKey);

    // 1. Nature de l'adresse (1 crédit) : un mint ou un programme ne coûte rien de plus.
    try {
      const nature = await rpc.getAccountNature(address, signal);
      if (nature.value === 'mint') throw new WalletIsTokenError();
      if (nature.value === 'program') throw new WalletInvalidError('program');
      if (nature.value === 'token_account') throw new WalletInvalidError('token_account');
    } catch (error) {
      if (error instanceof WalletIsTokenError || error instanceof WalletInvalidError) throw error;
      if (error instanceof UpstreamError && error.kind === 'too_large') throw new WalletInvalidError('oversized_account');
      // Nature inconnue (panne) : la liste suit ; un mint n'a pas de comptes de tokens (résultat vide).
      logger.warn('wallet_nature_unavailable', { kind: kindOf(error) });
    }

    // 2. Comptes SPL et Token-2022 (2 crédits), délégations comprises.
    const listRpc = rpc.withTimeout(config.wallet.accountsTimeoutMs);
    let lists: [RpcCallResult<{ accounts: ParsedTokenAccount[]; received: number; rejected: number }>, RpcCallResult<{ accounts: ParsedTokenAccount[]; received: number; rejected: number }>];
    try {
      lists = await Promise.all([
        listRpc.getTokenAccountsByOwner(address, SPL_TOKEN_PROGRAM, signal),
        listRpc.getTokenAccountsByOwner(address, TOKEN_2022_PROGRAM, signal),
      ]);
    } catch (error) {
      if (error instanceof UpstreamError && error.kind === 'too_large') throw new WalletTooLargeError(null);
      logger.warn('wallet_accounts_unavailable', { kind: kindOf(error) });
      throw toUpstreamError(rpc.heliusConfigured ? 'helius_rpc' : 'solana_rpc', error);
    }
    const received = lists[0].value.received + lists[1].value.received;
    if (received > maxAccounts) throw new WalletTooLargeError(received);
    const rejected = lists[0].value.rejected + lists[1].value.rejected;
    const accountsSource = lists.some((list) => list.servedBy === 'solana_rpc') ? 'solana_rpc' : 'helius';

    // 3. Classement : vides, NFT probables, fongibles agrégés par mint (BigInt), délégations.
    const seen = new Set<string>();
    const byMint = new Map<string, { program: TokenProgram; decimals: number; raw: bigint; accounts: number; frozen: boolean; delegated: boolean }>();
    const rawDelegations: ParsedTokenAccount[] = [];
    let nftCount = 0;
    let emptyAccountCount = 0;
    for (const account of [...lists[0].value.accounts, ...lists[1].value.accounts]) {
      if (seen.has(account.pubkey)) continue;
      seen.add(account.pubkey);
      if (account.delegate !== null) rawDelegations.push(account);
      if (account.amount === '0') {
        if (account.delegate === null) emptyAccountCount += 1;
        continue;
      }
      if (account.decimals === 0 && account.amount === '1') {
        nftCount += 1;
        continue;
      }
      const entry = byMint.get(account.mint);
      if (entry === undefined) {
        byMint.set(account.mint, {
          program: account.program,
          decimals: account.decimals,
          raw: BigInt(account.amount),
          accounts: 1,
          frozen: account.frozen,
          delegated: account.delegate !== null,
        });
      } else if (entry.decimals === account.decimals && entry.program === account.program) {
        entry.raw += BigInt(account.amount);
        entry.accounts += 1;
        entry.frozen ||= account.frozen;
        entry.delegated ||= account.delegate !== null;
      }
    }

    // 4. Prix DexScreener par lots de 30 (gratuit) ; paires gardées en cache pour la liquidité.
    const priceLookupMax = options.priceLookupMax ?? config.wallet.priceLookupMax;
    const toPrice = [...byMint.keys()].sort().slice(0, Math.max(0, priceLookupMax));
    const pairsByMint = new Map<string, DexPair[]>();
    let pricesComplete = true;
    await Promise.all(
      chunks(toPrice, DEXSCREENER_BATCH_MAX).map(async (chunk) => {
        try {
          const pairs = await this.deps.dexscreener.getTokensPairs(chunk, signal);
          for (const mint of chunk) {
            const own = pairs.filter((pair) => pair.baseToken.address === mint || pair.quoteToken.address === mint).slice(0, PAIRS_PER_MINT);
            pairsByMint.set(mint, own);
            await this.writeCache(`${PAIRS_CACHE_PREFIX}${mint}`, own, config.wallet.pairsCacheTtlSeconds);
          }
        } catch (error) {
          pricesComplete = false;
          logger.warn('wallet_prices_unavailable', { mints: chunk.length, kind: kindOf(error) });
        }
      }),
    );

    // 5. Valeur, tri (valeur connue décroissante, puis inconnue), sélection (poussière, plafond).
    const dustUsd = options.dustUsd ?? config.wallet.dustUsd;
    const draft = [...byMint.entries()].map(([mint, entry]) => {
      const balance = formatTokenAmount(entry.raw, entry.decimals);
      const pairs = pairsByMint.get(mint) ?? null;
      const price = pairs === null ? null : priceUsd(mint, pairs, null);
      const value = price === null ? null : finitePositive(Number(balance.ui) * price);
      const basePair = (pairs ?? []).find((pair) => pair.baseToken.address === mint);
      const token = tokenMetadataSchema.parse({
        mint,
        name: cleanName(basePair?.baseToken.name, TOKEN_NAME_MAX_LENGTH),
        symbol: cleanName(basePair?.baseToken.symbol, TOKEN_SYMBOL_MAX_LENGTH),
        decimals: entry.decimals,
        tokenProgram: entry.program,
        untrusted: true,
      });
      return { mint, entry, balance, price, value, token };
    });
    draft.sort((a, b) => {
      if (a.value !== null && b.value !== null && a.value !== b.value) return b.value - a.value;
      if (a.value !== null && b.value === null) return -1;
      if (a.value === null && b.value !== null) return 1;
      return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
    });
    let analyzeCount = 0;
    const tokens: WalletHolding[] = draft.map((item) => {
      let selection: WalletHoldingSelection;
      if (item.value !== null && item.value < dustUsd) selection = 'dust';
      else if (analyzeCount < maxTokens) {
        selection = 'analyze';
        analyzeCount += 1;
      } else selection = 'over_limit';
      return {
        mint: item.mint,
        tokenProgram: item.entry.program,
        token: item.token,
        balance: item.balance,
        priceUsd: item.price,
        valueUsd: item.value,
        accountCount: item.entry.accounts,
        frozen: item.entry.frozen,
        delegated: item.entry.delegated,
        selection,
      };
    });

    const metadataByMint = new Map(tokens.map((token) => [token.mint, token.token]));
    const delegations: WalletDelegation[] = rawDelegations
      .map((account) => {
        const delegated = BigInt(account.delegatedAmount ?? '0');
        const balance = BigInt(account.amount);
        return {
          tokenAccount: account.pubkey,
          mint: account.mint,
          tokenProgram: account.program,
          token: metadataByMint.get(account.mint) ?? null,
          delegate: account.delegate as string,
          delegatedAmount: formatTokenAmount(delegated, account.decimals),
          balance: formatTokenAmount(balance, account.decimals),
          coversFullBalance: delegated >= balance,
        };
      })
      .sort((a, b) => Number(b.coversFullBalance) - Number(a.coversFullBalance) || (a.tokenAccount < b.tokenAccount ? -1 : 1));

    const priced = tokens.filter((token) => token.valueUsd !== null);
    const sources: DataSourceId[] = [accountsSource];
    if (toPrice.length > 0) sources.push('dexscreener');
    return {
      address,
      tokens,
      delegations,
      summary: {
        accountCount: received,
        rejectedAccountCount: rejected,
        tokenCount: tokens.length,
        analyzeCount,
        dustCount: tokens.filter((token) => token.selection === 'dust').length,
        overLimitCount: tokens.filter((token) => token.selection === 'over_limit').length,
        nftCount,
        emptyAccountCount,
        delegationCount: delegations.length,
        totalValueUsd: priced.length === 0 ? null : priced.reduce((sum, token) => sum + (token.valueUsd ?? 0), 0),
      },
      maxTokens,
      accountsSource,
      pricesComplete,
      sources,
      credits: metered.credits,
    };
  }

  // --- Faits light par lot ---------------------------------------------------------------------------

  /**
   * Faits `light` d'un lot de mints (ARCHITECTURE.md §12.3, étape 4) : cache `light` d'abord, puis
   * `getMultipleAccounts` des mints (1 crédit / 100), DAS `getAssetBatch` (10 crédits / 1 000), paires
   * DexScreener (cache du scan, sinon lots de 30, gratuit), holders (`getTokenLargestAccounts` par mint,
   * propriétaires et programmes groupés par 100 et en cache 24 h). Sans clé : ni DAS ni holders.
   * Ne lève pas : chaque mint est `ok` (éventuellement `degraded`) ou `unavailable` avec un motif.
   */
  async collectLightBatch(mints: readonly string[], options: LightFactsBatchOptions = {}): Promise<LightFactsBatch> {
    const { config, clock } = this.deps;
    const unique = [...new Set(mints)];
    const entries = new Map<string, LightFactsEntry>();
    for (const mint of unique) {
      if (!isSolanaAddress(mint)) entries.set(mint, { mint, status: 'unavailable', reason: 'unanalyzable' });
    }
    const valid = unique.filter((mint) => !entries.has(mint));
    for (const mint of valid) {
      const cached = await this.readLightCache(mint);
      if (cached !== null) entries.set(mint, { mint, status: 'ok', collected: cached, fromCache: true });
    }
    // Ordre trié : lots reproductibles (cache partagé, fixtures de rejeu).
    const todo = valid.filter((mint) => !entries.has(mint)).sort();
    const metered = new MeteredCreditBudget(this.deps.budget);
    let timedOut = false;

    if (todo.length > 0) {
      const { signal, done } = deadlineSignal(options.deadlineMs ?? config.wallet.deadlineMs, options.signal);
      try {
        const rpc = this.deps.rpc.withBudget(metered);
        const das = this.deps.das.withBudget(metered);
        const tracker = new SourceTracker(clock);
        const rpcFallback: DataSourceId = rpc.heliusConfigured ? 'helius' : 'solana_rpc';

        // Comptes de mint (1 crédit le lot de 100) : sans eux, pas de verdict (D1).
        const reads: MintRead[] = [];
        for (const chunk of chunks(todo, RPC_BATCH)) reads.push(...(await this.readMints(rpc, chunk, tracker, signal)));
        const parsed = new Map<string, { parsed: ParsedMint; servedBy: DataSourceId }>();
        for (const read of reads) {
          if (read.result.status === 'ok') parsed.set(read.mint, { parsed: read.result.parsed, servedBy: read.result.servedBy });
          else if (read.result.status === 'error') {
            const reason: WalletUnavailableReason = signal.aborted ? 'timeout' : metered.refused > 0 ? 'budget' : 'upstream';
            entries.set(read.mint, { mint: read.mint, status: 'unavailable', reason });
          } else entries.set(read.mint, { mint: read.mint, status: 'unavailable', reason: 'unanalyzable' });
        }
        const okMints = [...parsed.keys()];

        if (okMints.length > 0) {
          const [assets, pairs] = await Promise.all([
            das.configured
              ? tracker.track('helius', 'helius', () => this.readAssets(das, okMints, signal))
              : Promise.resolve(null),
            this.readPairs(okMints, tracker, signal),
          ]);
          if (!das.configured) tracker.skip('helius');
          // Budget refusé : le RPC public refuse `getTokenLargestAccounts`, inutile de l'y envoyer.
          const holders =
            rpc.heliusConfigured && metered.refused === 0
              ? await this.readHolders(rpc, okMints, parsed, pairs, tracker, rpcFallback, signal)
              : new Map<string, { value: NonNullable<RiskFacts['holders']>; source: DataSourceId }>();
          tracker.skip('geckoterminal');
          tracker.skip('rugcheck');
          tracker.skip('jupiter');
          const sources = tracker.list();

          for (const mint of okMints) {
            const read = parsed.get(mint) as { parsed: ParsedMint; servedBy: DataSourceId };
            try {
              const collected = await this.buildLight(mint, read, assets?.get(mint) ?? null, das.configured, pairs.get(mint) ?? null, holders.get(mint) ?? null, sources);
              entries.set(mint, { mint, status: 'ok', collected, fromCache: false });
              await this.writeCache(
                `${LIGHT_CACHE_PREFIX}${mint}`,
                collected,
                collected.degraded ? config.wallet.degradedLightFactsCacheTtlSeconds : config.wallet.lightFactsCacheTtlSeconds,
              );
            } catch {
              this.deps.logger.warn('wallet_light_facts_invalid', { reason: 'schema' });
              entries.set(mint, { mint, status: 'unavailable', reason: 'upstream' });
            }
          }
        }
        timedOut = signal.aborted;
      } finally {
        done();
      }
    }

    return {
      entries: unique.map((mint) => entries.get(mint) as LightFactsEntry),
      credits: metered.credits,
      budgetExhausted: metered.refused > 0,
      timedOut,
    };
  }

  /** Lot de mints ; réponse trop volumineuse : lot coupé en deux jusqu'au mint fautif (`unanalyzable`). */
  private async readMints(rpc: SolanaRpcClient, mints: readonly string[], tracker: SourceTracker, signal: AbortSignal): Promise<MintRead[]> {
    const startedAt = this.deps.clock.now();
    try {
      const { value, servedBy } = await rpc.getMints(mints, signal);
      tracker.markOk(servedBy, this.deps.clock.now() - startedAt);
      return mints.map((mint, index) => {
        const parsed = value[index] ?? null;
        return { mint, result: parsed === null ? { status: 'not_found' as const } : { status: 'ok' as const, parsed, servedBy } };
      });
    } catch (error) {
      if (error instanceof UpstreamError && error.kind === 'too_large' && !signal.aborted) {
        if (mints.length === 1) return [{ mint: mints[0] as string, result: { status: 'unanalyzable' } }];
        const middle = Math.ceil(mints.length / 2);
        return [...(await this.readMints(rpc, mints.slice(0, middle), tracker, signal)), ...(await this.readMints(rpc, mints.slice(middle), tracker, signal))];
      }
      const kind = kindOf(error);
      this.deps.logger.warn('wallet_mints_unavailable', { mints: mints.length, kind });
      return mints.map((mint) => ({ mint, result: { status: 'error' as const, kind } }));
    }
  }

  private async readAssets(das: HeliusDasClient, mints: readonly string[], signal: AbortSignal): Promise<Map<string, DasAsset>> {
    const result = new Map<string, DasAsset>();
    for (const chunk of chunks(mints, DAS_BATCH_MAX)) {
      for (const [id, asset] of await das.getAssetBatch(chunk, signal)) result.set(id, asset);
    }
    return result;
  }

  /** Paires par mint : cache du scan (prix), sinon DexScreener par lots de 30. `null` = indisponible. */
  private async readPairs(mints: readonly string[], tracker: SourceTracker, signal: AbortSignal): Promise<Map<string, DexPair[] | null>> {
    const result = new Map<string, DexPair[] | null>();
    const missing: string[] = [];
    for (const mint of mints) {
      const cached = await this.readJson(`${PAIRS_CACHE_PREFIX}${mint}`);
      const pairs = cached === undefined ? null : parseCachedPairs(cached);
      if (pairs === null) missing.push(mint);
      else result.set(mint, pairs);
    }
    if (missing.length === 0) {
      tracker.markOk('dexscreener', 0);
      return result;
    }
    await Promise.all(
      chunks(missing, DEXSCREENER_BATCH_MAX).map(async (chunk) => {
        const pairs = await tracker.track('dexscreener', 'dexscreener', () => this.deps.dexscreener.getTokensPairs(chunk, signal));
        for (const mint of chunk) {
          if (pairs === null) {
            result.set(mint, null);
            continue;
          }
          const own = pairs.filter((pair) => pair.baseToken.address === mint || pair.quoteToken.address === mint).slice(0, PAIRS_PER_MINT);
          result.set(mint, own);
          await this.writeCache(`${PAIRS_CACHE_PREFIX}${mint}`, own, this.deps.config.wallet.pairsCacheTtlSeconds);
        }
      }),
    );
    return result;
  }

  /**
   * Concentration par mint : top 20 (`getTokenLargestAccounts`, 1 crédit par mint), propriétaires
   * puis programmes des propriétaires groupés par 100 (ordre trié : requêtes reproductibles) et en
   * cache 24 h (mêmes clés que la passe holders des suivis). Exclusions identiques à l'analyse.
   */
  private async readHolders(
    rpc: SolanaRpcClient,
    mints: readonly string[],
    parsed: ReadonlyMap<string, { parsed: ParsedMint }>,
    pairs: ReadonlyMap<string, DexPair[] | null>,
    tracker: SourceTracker,
    rpcFallback: DataSourceId,
    signal: AbortSignal,
  ): Promise<Map<string, { value: NonNullable<RiskFacts['holders']>; source: DataSourceId }>> {
    const servedBy = <T>(result: RpcCallResult<T>): DataSourceId => result.servedBy;
    const withSupply = mints.filter((mint) => BigInt(parsed.get(mint)?.parsed.supply ?? '0') > 0n);
    const largest = new Map<string, { entries: Array<{ address: string; amount: string }>; source: DataSourceId }>();
    await Promise.all(
      withSupply.map(async (mint) => {
        const result = await tracker.track(servedBy, rpcFallback, () => rpc.getTokenLargestAccounts(mint, signal));
        if (result === null || result.value.length === 0) return;
        const entries = result.value.filter((entry) => U64.test(entry.amount) && isSolanaAddress(entry.address)).slice(0, 20);
        largest.set(mint, { entries, source: result.servedBy });
      }),
    );

    const tokenAccounts = [...new Set([...largest.values()].flatMap((item) => item.entries.map((entry) => entry.address)))];
    const owners = await this.lookupCached(
      tokenAccounts,
      'solana:token-owner:',
      async (chunk) => (await tracker.track(servedBy, rpcFallback, () => rpc.getTokenAccountOwners(chunk, signal)))?.value ?? null,
      (value) => (value !== null && isSolanaAddress(value) ? value : undefined),
    );
    const uniqueOwners = [...new Set(owners.values())].filter((owner): owner is string => owner !== null);
    const programs = await this.lookupCached(
      uniqueOwners,
      'solana:account-program:',
      async (chunk) => (await tracker.track(servedBy, rpcFallback, () => rpc.getAccountPrograms(chunk, signal)))?.value ?? null,
      // Compte inexistant mis en cache aussi (« ») : un wallet vide ne devient pas un programme.
      (value) => (value === null ? '' : isSolanaAddress(value) ? value : undefined),
    );

    const result = new Map<string, { value: NonNullable<RiskFacts['holders']>; source: DataSourceId }>();
    for (const [mint, item] of largest) {
      const supply = BigInt((parsed.get(mint) as { parsed: ParsedMint }).parsed.supply);
      const pools = poolAddresses(pairs.get(mint) ?? null, null, null);
      const excluded = new Set([...Object.keys(KNOWN_EXCLUDED_OWNERS), ...pools]);
      const entries: HolderEntry[] = item.entries.map((entry) => ({
        tokenAccount: entry.address,
        owner: owners.get(entry.address) ?? entry.address,
        pct: shareOf(BigInt(entry.amount), supply),
      }));
      const isExcluded = (entry: HolderEntry) => {
        if (excluded.has(entry.owner) || pools.has(entry.tokenAccount)) return true;
        const program = programs.get(entry.owner);
        return program !== undefined && program !== null && program !== '' && program in KNOWN_AMM_PROGRAMS;
      };
      result.set(mint, { value: concentration(entries, isExcluded), source: item.source });
    }
    return result;
  }

  /**
   * Valeurs par clé : cache (chaîne JSON), puis lots triés de 100 pour le reste. `toCache` donne la
   * valeur à mémoriser (`undefined` = ne pas mémoriser). Lot en échec : clés absentes du résultat.
   */
  private async lookupCached(
    keys: readonly string[],
    prefix: string,
    fetchChunk: (chunk: string[]) => Promise<Array<string | null> | null>,
    toCache: (value: string | null) => string | undefined,
  ): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    const missing: string[] = [];
    for (const key of keys) {
      const cached = await this.readJson(`${prefix}${key}`);
      if (typeof cached === 'string' && (cached === '' || isSolanaAddress(cached))) result.set(key, cached === '' ? null : cached);
      else missing.push(key);
    }
    for (const chunk of chunks([...missing].sort(), RPC_BATCH)) {
      const values = await fetchChunk(chunk);
      if (values === null || values.length !== chunk.length) continue;
      for (const [index, key] of chunk.entries()) {
        const value = values[index] ?? null;
        const stored = toCache(value);
        if (stored === undefined) continue;
        result.set(key, stored === '' ? null : stored);
        await this.writeCache(`${prefix}${key}`, stored, this.deps.config.holderOwnersCacheTtlSeconds);
      }
    }
    return result;
  }

  private async buildLight(
    mint: string,
    read: { parsed: ParsedMint; servedBy: DataSourceId },
    asset: DasAsset | null,
    dasConfigured: boolean,
    pairs: DexPair[] | null,
    holders: { value: NonNullable<RiskFacts['holders']>; source: DataSourceId } | null,
    sources: SourceReport[],
  ): Promise<CollectedFacts> {
    const { config, clock } = this.deps;
    const nowMs = clock.now();
    const embedded = token2022Metadata(read.parsed);
    const tokenCreated = await this.readJson(`solana:token-created:${mint}`);
    const tokenCreatedAt = typeof tokenCreated === 'string' && z.iso.datetime().safeParse(tokenCreated).success ? tokenCreated : null;
    const metadata = asset !== null ? { mutable: asset.mutable } : embedded !== null ? { mutable: embedded.mutable } : null;
    const metadataSource: DataSourceId = asset !== null ? 'helius' : embedded !== null ? read.servedBy : dasConfigured ? 'helius' : 'rugcheck';

    const facts = riskFactsSchema.parse({
      version: RISK_FACTS_VERSION,
      mint,
      observedAt: new Date(nowMs).toISOString(),
      mintAccount: buildMintAccountFacts(read.parsed),
      metadata,
      liquidity: buildLiquidityFacts(mint, pairs, null, null, config.lpRemovedMaxUsd),
      holders: holders?.value ?? null,
      sellSimulation: null,
      age: pairs === null && tokenCreatedAt === null ? null : { tokenCreatedAt, poolCreatedAt: mainPoolCreatedAt(mint, pairs, null, nowMs) },
      creator: null,
      rugcheck: null,
    } satisfies RiskFacts);

    const basePair = (pairs ?? []).find((pair) => pair.baseToken.address === mint);
    const pick = (field: 'name' | 'symbol', max: number) => {
      for (const candidate of [asset?.content?.metadata?.[field], embedded?.[field], basePair?.baseToken[field]]) {
        const cleaned = cleanName(candidate, max);
        if (cleaned !== null) return cleaned;
      }
      return null;
    };
    const token = tokenMetadataSchema.parse({
      mint,
      name: pick('name', TOKEN_NAME_MAX_LENGTH),
      symbol: pick('symbol', TOKEN_SYMBOL_MAX_LENGTH),
      decimals: read.parsed.decimals,
      tokenProgram: read.parsed.program,
      untrusted: true,
    });
    const expected: Array<keyof RiskFacts> = ['mintAccount', 'metadata', 'liquidity', 'holders', 'age'];
    return {
      profile: 'light',
      facts,
      token,
      checkSources: buildCheckSources(mint, {
        rpc: read.servedBy,
        holders: holders?.source ?? read.servedBy,
        metadata: metadataSource,
        lpFromRugcheck: false,
        light: true,
      }),
      sources,
      degraded: expected.some((key) => facts[key] === null),
    };
  }

  private async readLightCache(mint: string): Promise<CollectedFacts | null> {
    const raw = await this.readJson(`${LIGHT_CACHE_PREFIX}${mint}`);
    if (raw === undefined) return null;
    const parsed = cachedLightFactsSchema.safeParse(raw);
    if (!parsed.success || parsed.data.facts.mint !== mint || parsed.data.token.mint !== mint) return null;
    return parsed.data as unknown as CollectedFacts;
  }

  /** Valeur JSON du cache, `undefined` si absente ou illisible. */
  private async readJson(key: string): Promise<unknown> {
    try {
      const raw = await this.deps.cache.get(key);
      return raw === null ? undefined : (JSON.parse(raw) as unknown);
    } catch {
      this.deps.logger.warn('solana_cache_read_failed', { key: key.split(':').slice(0, 2).join(':') });
      return undefined;
    }
  }

  private async writeCache(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.deps.cache.set(key, JSON.stringify(value), ttlSeconds);
    } catch {
      this.deps.logger.warn('solana_cache_write_failed', { key: key.split(':').slice(0, 2).join(':') });
    }
  }
}
