import type {
  QuotaInfo,
  WalletDelegation,
  WalletScanQuotaResponse,
  WalletScanResponse,
  WalletScanResult,
  WalletScanSummary,
  WalletToken,
} from '@raijin/shared-contracts';

/**
 * Données de test conformes aux contrats du scan de wallet (specs de data-access et de la
 * feature `/wallet`, captures). Adresses publiques réelles mais sans lien avec un utilisateur.
 */
export const WALLET_FIXTURES = {
  wallet: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  otherWallet: 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH',
  tokenAccount: '7UX2i7SucgLMQcfZ75s3VXmZZY4YRUyJN9X1RgfMoDUi',
  delegate: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
  mints: {
    bonk: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    jup: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    wif: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    pyth: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
  },
} as const;

const NOW = '2026-11-22T10:00:00.000Z';

/** Plus grand u64 : montant délégué « illimité » (approbation maximale). */
export const U64_MAX = '18446744073709551615';

export function fakeWalletQuota(overrides: Partial<QuotaInfo> = {}): QuotaInfo {
  return {
    kind: 'wallet_scan',
    subject: 'user',
    plan: 'PRO',
    limit: 20,
    used: 1,
    remaining: 19,
    resetsAt: '2026-11-23T00:00:00.000Z',
    ...overrides,
  };
}

export function fakeWalletQuotaResponse(allowed = true, quota: Partial<QuotaInfo> = {}): WalletScanQuotaResponse {
  return allowed ? { allowed: true, quota: fakeWalletQuota({ used: 0, remaining: 20, ...quota }) } : { allowed: false, quota: null };
}

export function fakeWalletToken(overrides: Partial<WalletToken> = {}): WalletToken {
  const mint = overrides.mint ?? WALLET_FIXTURES.mints.bonk;
  return {
    mint,
    tokenProgram: 'spl-token',
    token: { mint, name: 'Bonk', symbol: 'BONK', decimals: 5, tokenProgram: 'spl-token', untrusted: true },
    balance: { raw: '123456789000', decimals: 5, ui: '1234567.89' },
    valueUsd: 24.6,
    accountCount: 1,
    frozen: false,
    delegated: false,
    assessment: {
      status: 'analyzed',
      verdict: 'safe',
      explanation: 'Mint et freeze désactivés, liquidité verrouillée, offre répartie.',
      coverage: 'light',
      checksEvaluated: 6,
      degraded: false,
      analyzedAt: NOW,
      fromCache: false,
    },
    ...overrides,
  };
}

export function fakeWalletDelegation(overrides: Partial<WalletDelegation> = {}): WalletDelegation {
  const mint = overrides.mint ?? WALLET_FIXTURES.mints.usdc;
  return {
    tokenAccount: WALLET_FIXTURES.tokenAccount,
    mint,
    tokenProgram: 'spl-token',
    token: { mint, name: 'USD Coin', symbol: 'USDC', decimals: 6, tokenProgram: 'spl-token', untrusted: true },
    delegate: WALLET_FIXTURES.delegate,
    delegatedAmount: { raw: U64_MAX, decimals: 6, ui: '18446744073709.551615' },
    balance: { raw: '12500000', decimals: 6, ui: '12.5' },
    coversFullBalance: true,
    ...overrides,
  };
}

/** Résumé recalculé à partir des tokens et délégations (cohérent avec les refinements du contrat). */
export function fakeWalletScan(
  tokens: WalletToken[] = defaultTokens(),
  delegations: WalletDelegation[] = [],
  overrides: Partial<Omit<WalletScanResult, 'tokens' | 'delegations' | 'summary'>> & { summary?: Partial<WalletScanSummary> } = {},
): WalletScanResult {
  const verdicts = { safe: 0, warn: 0, danger: 0 };
  let unavailableCount = 0;
  let overLimitCount = 0;
  let dustCount = 0;
  let total: number | null = null;
  for (const token of tokens) {
    const { assessment } = token;
    if (assessment.status === 'analyzed') verdicts[assessment.verdict] += 1;
    else if (assessment.status === 'unavailable') unavailableCount += 1;
    else if (assessment.reason === 'dust') dustCount += 1;
    else overLimitCount += 1;
    if (token.valueUsd !== null) total = (total ?? 0) + token.valueUsd;
  }
  return {
    address: WALLET_FIXTURES.wallet,
    tokens,
    delegations,
    sources: ['helius', 'dexscreener'],
    engineVersion: '1.0.0',
    scannedAt: NOW,
    cached: false,
    partial: unavailableCount > 0,
    ...overrides,
    summary: {
      tokenCount: tokens.length,
      analyzedCount: verdicts.safe + verdicts.warn + verdicts.danger,
      verdicts,
      unavailableCount,
      overLimitCount,
      dustCount,
      nftCount: 0,
      emptyAccountCount: 0,
      delegationCount: delegations.length,
      totalValueUsd: total,
      ...overrides.summary,
    },
  };
}

export function fakeWalletScanResponse(scan: WalletScanResult = fakeWalletScan(), quota: Partial<QuotaInfo> = {}): WalletScanResponse {
  return { scan, quota: fakeWalletQuota(quota) };
}

/** Wallet varié : Sain (rapide), Prudence (complète, reprise du cache), Danger, poussière, indisponible. */
function defaultTokens(): WalletToken[] {
  const { mints } = WALLET_FIXTURES;
  return [
    fakeWalletToken({
      mint: mints.jup,
      token: { mint: mints.jup, name: 'Jupiter', symbol: 'JUP', decimals: 6, tokenProgram: 'spl-token', untrusted: true },
      balance: { raw: '4820500000', decimals: 6, ui: '4820.5' },
      valueUsd: 3856.4,
      assessment: {
        status: 'analyzed',
        verdict: 'warn',
        explanation: 'Les 10 plus gros holders détiennent 58 % de l’offre.',
        coverage: 'full',
        checksEvaluated: 9,
        degraded: false,
        analyzedAt: NOW,
        fromCache: true,
      },
    }),
    fakeWalletToken(),
    fakeWalletToken({
      mint: mints.wif,
      token: { mint: mints.wif, name: 'Shady Cat', symbol: 'SCAT', decimals: 6, tokenProgram: 'token-2022', untrusted: true },
      tokenProgram: 'token-2022',
      balance: { raw: '250000000000', decimals: 6, ui: '250000' },
      valueUsd: 3.1,
      frozen: true,
      assessment: {
        status: 'analyzed',
        verdict: 'danger',
        explanation: 'L’autorité de mint est encore active : le créateur peut imprimer des tokens à volonté.',
        coverage: 'light',
        checksEvaluated: 6,
        degraded: false,
        analyzedAt: NOW,
        fromCache: false,
      },
    }),
    fakeWalletToken({
      mint: mints.pyth,
      token: { mint: mints.pyth, name: 'Pyth Network', symbol: 'PYTH', decimals: 6, tokenProgram: 'spl-token', untrusted: true },
      balance: { raw: '1500000', decimals: 6, ui: '1.5' },
      valueUsd: 0.42,
      assessment: { status: 'not_analyzed', reason: 'dust' },
    }),
    fakeWalletToken({
      mint: mints.usdc,
      token: { mint: mints.usdc, name: null, symbol: null, decimals: 6, tokenProgram: 'spl-token', untrusted: true },
      balance: { raw: '12500000', decimals: 6, ui: '12.5' },
      valueUsd: null,
      assessment: { status: 'unavailable', reason: 'timeout' },
    }),
  ];
}
