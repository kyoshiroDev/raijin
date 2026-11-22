import type { CollectedFacts } from '@raijin/api-analysis';
import type { DataSourceId, TokenProgram, WalletUnavailableReason } from '@raijin/shared-contracts';

/**
 * Port de collecte du scan de wallet (docs/ARCHITECTURE.md §12.3). Implémenté par l'adaptateur de
 * `@raijin/api-solana` (`listWalletHoldings`, `collectFactsLightBatch`, voie de crédits `wallet`) ou
 * par les fixtures en test. L'API du scan ne connaît que ce port : aucun appel réseau direct.
 */

/** Un mint détenu (comptes de tokens agrégés, solde non nul, hors NFT probables). */
export interface WalletHoldingToken {
  readonly mint: string;
  readonly tokenProgram: TokenProgram;
  /** Somme des soldes en plus petites unités (u64, chaîne décimale). */
  readonly amountRaw: string;
  readonly decimals: number;
  /** Valeur indicative en USD (prix DexScreener × solde), `null` si le prix est inconnu. */
  readonly valueUsd: number | null;
  readonly accountCount: number;
  readonly frozen: boolean;
  readonly delegated: boolean;
  /** Métadonnées **non fiables** (extension Token-2022, DexScreener), nettoyées par le contrat. */
  readonly name: string | null;
  readonly symbol: string | null;
}

/** Délégation active d'un compte de token (y compris sur un compte vide). */
export interface WalletHoldingDelegation {
  readonly tokenAccount: string;
  readonly mint: string;
  readonly tokenProgram: TokenProgram;
  readonly delegate: string;
  readonly delegatedAmountRaw: string;
  readonly balanceRaw: string;
  readonly decimals: number;
  /** Métadonnées non fiables du token si connues (compte vide : le mint n'est pas dans `tokens`). */
  readonly name?: string | null;
  readonly symbol?: string | null;
}

/** Contenu d'un wallet (lecture seule, un appel par scan). */
export interface WalletHoldings {
  readonly tokens: readonly WalletHoldingToken[];
  readonly delegations: readonly WalletHoldingDelegation[];
  readonly nftCount: number;
  readonly emptyAccountCount: number;
  /** Sources interrogées (comptes : `helius` ou `solana_rpc` ; prix : `dexscreener`). */
  readonly sources: readonly DataSourceId[];
  /** Crédits Helius consommés. */
  readonly credits: number;
}

export interface ListHoldingsOptions {
  readonly maxAccounts: number;
  readonly priceLookupMax: number;
  readonly dustUsd: number;
  /** Échéance globale du scan : annule la lecture en cours. */
  readonly signal?: AbortSignal;
}

/** Verdict rapide d'un mint du lot : faits `light`, ou motif d'indisponibilité. */
export type LightBatchEntry =
  | { readonly mint: string; readonly status: 'ok'; readonly collected: CollectedFacts }
  | { readonly mint: string; readonly status: 'unavailable'; readonly reason: WalletUnavailableReason };

export interface LightBatchResult {
  readonly entries: readonly LightBatchEntry[];
  readonly credits: number;
}

export interface LightBatchOptions {
  /** Échéance absolue (ms epoch) : les mints non terminés passent `timeout`. */
  readonly deadlineAt: number;
}

export abstract class WalletDataSource {
  /** Clé Helius configurée (plafond de tokens analysés et durée du cache du wallet). */
  abstract get heliusConfigured(): boolean;

  /**
   * Nature de l'adresse et contenu du wallet. Lève `WalletAddressRejectedError` (programme, compte
   * de token, mint), `WalletTooLargeError` (trop de comptes) ou `UpstreamUnavailableError`.
   */
  abstract listHoldings(address: string, options: ListHoldingsOptions): Promise<WalletHoldings>;

  /** Faits `light` d'un lot de mints (appels groupés). Ne lève pas : chaque mint a une entrée. */
  abstract collectLightBatch(mints: readonly string[], options: LightBatchOptions): Promise<LightBatchResult>;
}

/** L'adresse n'est pas un wallet : programme ou compte de token (`invalid`), ou mint (`token`). */
export class WalletAddressRejectedError extends Error {
  constructor(readonly kind: 'invalid' | 'token') {
    super(kind === 'token' ? 'Adresse de token' : 'Adresse qui n’est pas un wallet');
    this.name = 'WalletAddressRejectedError';
  }
}

/** Plus de `WALLET_SCAN_MAX_ACCOUNTS` comptes de tokens : 422 `WALLET_TOO_LARGE`. */
export class WalletTooLargeError extends Error {
  constructor() {
    super('Wallet trop volumineux');
    this.name = 'WalletTooLargeError';
  }
}
