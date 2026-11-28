import { UpstreamUnavailableError, type CollectedFacts } from '@raijin/api-analysis';
import {
  UpstreamError,
  WalletInvalidError,
  WalletIsTokenError,
  WalletTooLargeError as SolanaWalletTooLargeError,
  type LightFactsBatch,
  type LightFactsBatchOptions,
  type SolanaDataService,
  type WalletHoldings as SolanaWalletHoldings,
  type WalletHoldingsOptions,
} from '@raijin/api-solana';
import {
  WalletAddressRejectedError,
  WalletDataSource,
  WalletTooLargeError,
  type LightBatchEntry,
  type LightBatchOptions,
  type LightBatchResult,
  type ListHoldingsOptions,
  type WalletHoldings,
} from '../ports/wallet-data-source';

/** Partie de `SolanaDataService` utilisée par le scan (doublure possible en test). */
export type WalletSolanaData = Pick<SolanaDataService, 'heliusConfigured' | 'listWalletHoldings' | 'collectFactsLightBatch'>;

type SolanaCollected = Extract<LightFactsBatch['entries'][number], { status: 'ok' }>['collected'];

/** Faits de `@raijin/api-solana` → port de l'analyse (même conversion que `SolanaFactsCollector`). */
export function toPortFacts(collected: SolanaCollected): CollectedFacts {
  return {
    facts: collected.facts,
    token: {
      name: collected.token.name,
      symbol: collected.token.symbol,
      decimals: collected.token.decimals,
      tokenProgram: collected.token.tokenProgram,
    },
    sources: collected.sources.map((source) => ({
      source: source.id,
      status: source.status,
      latencyMs: source.latencyMs,
      errorKind: source.errorKind,
    })),
    checkSources: collected.checkSources,
    degraded: collected.degraded,
  };
}

/**
 * Adaptateur du port `WalletDataSource` sur `SolanaDataService` (`listWalletHoldings`,
 * `collectFactsLightBatch`, voie de crédits `wallet`). Erreurs : `WalletInvalidError` →
 * `WALLET_INVALID`, `WalletIsTokenError` → `WALLET_IS_TOKEN`, `WalletTooLargeError` →
 * `WALLET_TOO_LARGE`, `UpstreamError` (liste illisible) → `UPSTREAM_UNAVAILABLE`.
 */
export class SolanaWalletDataSource extends WalletDataSource {
  constructor(
    private readonly solana: WalletSolanaData,
    private readonly maxTokens: () => number,
  ) {
    super();
  }

  get heliusConfigured(): boolean {
    return this.solana.heliusConfigured;
  }

  async listHoldings(address: string, options: ListHoldingsOptions): Promise<WalletHoldings> {
    let holdings: SolanaWalletHoldings;
    try {
      const request: WalletHoldingsOptions = { ...options, maxTokens: this.maxTokens() };
      holdings = await this.solana.listWalletHoldings(address, request);
    } catch (error) {
      if (error instanceof WalletIsTokenError) throw new WalletAddressRejectedError('token');
      if (error instanceof WalletInvalidError) throw new WalletAddressRejectedError('invalid');
      if (error instanceof SolanaWalletTooLargeError) throw new WalletTooLargeError();
      if (error instanceof UpstreamError) throw new UpstreamUnavailableError();
      throw error;
    }
    return {
      tokens: holdings.tokens.map((holding) => ({
        mint: holding.mint,
        tokenProgram: holding.tokenProgram,
        amountRaw: holding.balance.raw,
        decimals: holding.balance.decimals,
        valueUsd: holding.valueUsd,
        accountCount: holding.accountCount,
        frozen: holding.frozen,
        delegated: holding.delegated,
        name: holding.token.name,
        symbol: holding.token.symbol,
      })),
      delegations: holdings.delegations.map((delegation) => ({
        tokenAccount: delegation.tokenAccount,
        mint: delegation.mint,
        tokenProgram: delegation.tokenProgram,
        delegate: delegation.delegate,
        delegatedAmountRaw: delegation.delegatedAmount.raw,
        balanceRaw: delegation.balance.raw,
        decimals: delegation.balance.decimals,
        name: delegation.token?.name ?? null,
        symbol: delegation.token?.symbol ?? null,
      })),
      nftCount: holdings.summary.nftCount,
      emptyAccountCount: holdings.summary.emptyAccountCount,
      sources: holdings.sources,
      credits: holdings.credits,
    };
  }

  async collectLightBatch(mints: readonly string[], options: LightBatchOptions): Promise<LightBatchResult> {
    const deadlineMs = Math.max(1, options.deadlineAt - Date.now());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    try {
      const request: LightFactsBatchOptions = { deadlineMs, signal: controller.signal };
      const batch = await this.solana.collectFactsLightBatch(mints, request);
      const entries = batch.entries.map(
        (entry): LightBatchEntry =>
          entry.status === 'ok'
            ? { mint: entry.mint, status: 'ok', collected: toPortFacts(entry.collected) }
            : { mint: entry.mint, status: 'unavailable', reason: entry.reason },
      );
      return { entries, credits: batch.credits };
    } finally {
      clearTimeout(timer);
    }
  }
}
