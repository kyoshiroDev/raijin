import { FactsCollector, isTokenUnanalyzable, TokenUnanalyzableError, UpstreamUnavailableError } from '@raijin/api-analysis';
import {
  WalletAddressRejectedError,
  WalletDataSource,
  WalletTooLargeError,
  type LightBatchEntry,
  type LightBatchResult,
  type WalletHoldings,
} from '../ports/wallet-data-source';

/**
 * Wallets synthétiques des tests Jest du scan (doublure du port, sans réseau ; l'API en mode
 * `ANALYSIS_FIXTURES=1` utilise, elle, la collecte réelle rejouée depuis les fixtures de wallets de
 * `@raijin/api-solana`). Adresses dérivées de `sha256("raijin-fixture-<nom>")` (aucun wallet réel). Les verdicts
 * rapides passent par le collecteur de l'analyse, qui rejoue les fixtures de `@raijin/api-solana`
 * (mint actif → Danger).
 */
export const FIXTURE_WALLETS = {
  /** BONK + USDC (délégation SPL partielle) + token inconnu Token-2022 (délégation sur compte vide). */
  delegations: 'As85YxGGXLZLpHpjzmzbS9mnrTawosheADePutJc5jyh',
  /** Mint actif (Danger) + fresh pump + poussière + 1 NFT + 2 comptes vides. */
  danger: '92QUtofALD6zbjazNPCr8fvovU8JdSjHwZrJUjVhqdLq',
  /** Aucun compte de token. */
  empty: 'A8SdfEZF7xRHA5sNFavJ4WhvskXog6LKrJT7H2KuQuZg',
  /** Plus de 1 000 comptes de tokens. */
  tooLarge: 'E2sCZVRqNexpyjbkby7yfUV3EkKXwBdN2EWvh5gH6Nof',
  /** Compte de programme (lu on-chain, absent de la liste connue). */
  program: '2mzxyx2fKuHc3fMKn4sWzZzS23XRpckxBndzCseYyoB2',
  /** Compte de mint (lu on-chain, absent de la liste connue). */
  mint: 'Cce4RKSAAHNVEsH2g6LghrMFQk2N4a275ytggWYzCUDK',
} as const;

export const FIXTURE_MINTS = {
  mintActive: 'BL7yQWfMeLesszudGL6TqnfWbieFMDTT1TFXzQWBazTi',
  freshPump: '9rA3rJrcFJeQwWaLaHgJLi4LaF6wvRoae9ybwcYApump',
  bonk: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  scam: 'E91bNy3CWvMJojNZakqnMzGYh1jEvhsVtv58Ryvso6Vo',
  dust: 'HNaNj6uyxV3CKRx63ZNHCe9Hi7FEZcLAf3hgXY9iQ29B',
} as const;

export const FIXTURE_DELEGATES = {
  spl: 'BHdMK1AK7WqeC1ZEDNerKkJ1tZsc867DMAgVMA6e3mfC',
  token2022: 'DXfz3zwDqioCi8pcJC4huqvv97CZS7sv5jYadRoTzTeJ',
} as const;

const SPL = 'spl-token' as const;
const T22 = 'token-2022' as const;

const HOLDINGS: Readonly<Record<string, WalletHoldings>> = {
  [FIXTURE_WALLETS.delegations]: {
    tokens: [
      { mint: FIXTURE_MINTS.bonk, tokenProgram: SPL, amountRaw: '600000000000', decimals: 5, valueUsd: 120, accountCount: 1, frozen: false, delegated: false, name: 'Bonk', symbol: 'Bonk' },
      { mint: FIXTURE_MINTS.usdc, tokenProgram: SPL, amountRaw: '50000000', decimals: 6, valueUsd: 50, accountCount: 1, frozen: false, delegated: true, name: 'USD Coin', symbol: 'USDC' },
      { mint: FIXTURE_MINTS.scam, tokenProgram: T22, amountRaw: '1000000000', decimals: 6, valueUsd: null, accountCount: 2, frozen: false, delegated: true, name: 'Free Airdrop', symbol: 'GIFT' },
    ],
    delegations: [
      { tokenAccount: 'FaGq1fwmsnrzjBQ8rKnVPQ1X5cE5U4TdSJ66PMtGoAW5', mint: FIXTURE_MINTS.usdc, tokenProgram: SPL, delegate: FIXTURE_DELEGATES.spl, delegatedAmountRaw: '10000000', balanceRaw: '50000000', decimals: 6 },
      { tokenAccount: 'vNQnEP65WFD7vnQwVqvY9NmotGLPqXAZc5FB1TdQQWC', mint: FIXTURE_MINTS.scam, tokenProgram: T22, delegate: FIXTURE_DELEGATES.token2022, delegatedAmountRaw: '18446744073709551615', balanceRaw: '0', decimals: 6 },
    ],
    nftCount: 0,
    emptyAccountCount: 1,
    sources: ['helius', 'dexscreener'],
    credits: 3,
  },
  [FIXTURE_WALLETS.danger]: {
    tokens: [
      { mint: FIXTURE_MINTS.mintActive, tokenProgram: SPL, amountRaw: '123456789', decimals: 6, valueUsd: 10, accountCount: 1, frozen: false, delegated: false, name: 'Mint actif', symbol: 'MINT' },
      { mint: FIXTURE_MINTS.freshPump, tokenProgram: SPL, amountRaw: '5000000000', decimals: 6, valueUsd: 5, accountCount: 1, frozen: true, delegated: false, name: 'Fresh pump', symbol: 'PUMP' },
      { mint: FIXTURE_MINTS.dust, tokenProgram: SPL, amountRaw: '42', decimals: 0, valueUsd: 0.2, accountCount: 1, frozen: false, delegated: false, name: null, symbol: null },
    ],
    delegations: [],
    nftCount: 1,
    emptyAccountCount: 2,
    sources: ['helius', 'dexscreener'],
    credits: 3,
  },
};

const EMPTY: WalletHoldings = { tokens: [], delegations: [], nftCount: 0, emptyAccountCount: 0, sources: ['helius'], credits: 3 };

/** Doublure du port (tests, sans réseau). Toute autre adresse : wallet sans compte de token. */
export class FixtureWalletDataSource extends WalletDataSource {
  constructor(private readonly facts: FactsCollector) {
    super();
  }

  get heliusConfigured(): boolean {
    return true;
  }

  async listHoldings(address: string): Promise<WalletHoldings> {
    if (address === FIXTURE_WALLETS.program) throw new WalletAddressRejectedError('invalid');
    if (address === FIXTURE_WALLETS.mint) throw new WalletAddressRejectedError('token');
    if (address === FIXTURE_WALLETS.tooLarge) throw new WalletTooLargeError();
    return HOLDINGS[address] ?? EMPTY;
  }

  async collectLightBatch(mints: readonly string[]): Promise<LightBatchResult> {
    const entries = await Promise.all(mints.map((mint) => this.collectOne(mint)));
    return { entries, credits: entries.length };
  }

  private async collectOne(mint: string): Promise<LightBatchEntry> {
    try {
      const collected = await this.facts.collectFacts(mint, { profile: 'light' });
      return collected ? { mint, status: 'ok', collected } : { mint, status: 'unavailable', reason: 'unanalyzable' };
    } catch (error) {
      if (error instanceof TokenUnanalyzableError || isTokenUnanalyzable(error)) return { mint, status: 'unavailable', reason: 'unanalyzable' };
      if (error instanceof UpstreamUnavailableError) return { mint, status: 'unavailable', reason: 'upstream' };
      return { mint, status: 'unavailable', reason: 'upstream' };
    }
  }
}

/** Repli tant qu'aucune source réelle n'est branchée : tout scan répond `UPSTREAM_UNAVAILABLE`. */
export class UnavailableWalletDataSource extends WalletDataSource {
  get heliusConfigured(): boolean {
    return false;
  }

  async listHoldings(): Promise<WalletHoldings> {
    throw new UpstreamUnavailableError();
  }

  async collectLightBatch(mints: readonly string[]): Promise<LightBatchResult> {
    return { entries: mints.map((mint) => ({ mint, status: 'unavailable', reason: 'upstream' })), credits: 0 };
  }
}
