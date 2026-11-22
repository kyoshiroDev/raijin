import { isAllowedHttpsUrl, isSolanaAddress } from '@raijin/shared-util';
import {
  KNOWN_NON_WALLET_ADDRESSES,
  WALLET_ERROR_CODES,
  WALLET_ERROR_MESSAGES,
  WALLET_REVOKE_GUIDES,
  WALLET_REVOKE_GUIDE_URLS,
  apiErrorCodeSchema,
  knownNonWalletKind,
  revokeGuideUrlSchema,
  walletScanQuotaResponseSchema,
  walletScanRequestSchema,
  walletScanResponseSchema,
  walletScanResultSchema,
  type WalletScanResult,
} from '../../index';

const WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_ACCOUNT = '7UX2i7SucgLMQcfZ75s3VXmZZY4YRUyJN9X1RgfMoDUi';
const DELEGATE = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
const NOW = '2026-11-22T10:00:00.000Z';

function buildScan(): WalletScanResult {
  return {
    address: WALLET,
    summary: {
      tokenCount: 2,
      analyzedCount: 1,
      verdicts: { safe: 0, warn: 1, danger: 0 },
      unavailableCount: 0,
      overLimitCount: 0,
      dustCount: 1,
      nftCount: 0,
      emptyAccountCount: 0,
      delegationCount: 1,
      totalValueUsd: 12.5,
    },
    tokens: [
      {
        mint: MINT,
        tokenProgram: 'spl-token',
        token: { mint: MINT, name: 'USD Coin', symbol: 'USDC', decimals: 6, tokenProgram: 'spl-token', untrusted: true },
        balance: { raw: '12500000', decimals: 6, ui: '12.5' },
        valueUsd: 12.5,
        accountCount: 1,
        frozen: false,
        delegated: true,
        assessment: {
          status: 'analyzed',
          verdict: 'warn',
          explanation: 'Émetteur régulé : autorité de freeze active.',
          coverage: 'light',
          checksEvaluated: 6,
          degraded: false,
          analyzedAt: NOW,
          fromCache: false,
        },
      },
    ],
    delegations: [
      {
        tokenAccount: TOKEN_ACCOUNT,
        mint: MINT,
        tokenProgram: 'spl-token',
        token: null,
        delegate: DELEGATE,
        delegatedAmount: { raw: '18446744073709551615', decimals: 6, ui: '18446744073709.551615' },
        balance: { raw: '12500000', decimals: 6, ui: '12.5' },
        coversFullBalance: true,
      },
    ],
    sources: ['helius', 'dexscreener'],
    engineVersion: '1.0.0',
    scannedAt: NOW,
    cached: false,
    partial: false,
  };
}

const QUOTA = {
  kind: 'wallet_scan' as const,
  subject: 'user' as const,
  plan: 'PRO' as const,
  limit: 20,
  used: 1,
  remaining: 19,
  resetsAt: '2026-11-23T00:00:00.000Z',
};

describe('contrats du scan de wallet', () => {
  it('accepte une adresse publique de wallet et refuse le reste', () => {
    expect(walletScanRequestSchema.parse({ address: `  ${WALLET} ` })).toEqual({ address: WALLET });
    expect(walletScanRequestSchema.safeParse({ address: 'pas-une-adresse' }).success).toBe(false);
    expect(walletScanRequestSchema.safeParse({ address: MINT }).success).toBe(false);
    expect(walletScanRequestSchema.safeParse({ address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }).success).toBe(false);
    expect(walletScanRequestSchema.safeParse({ address: WALLET, extra: 1 }).success).toBe(false);
  });

  it('liste d’adresses connues valides et classées', () => {
    for (const address of Object.keys(KNOWN_NON_WALLET_ADDRESSES)) expect(isSolanaAddress(address)).toBe(true);
    expect(knownNonWalletKind(MINT)).toBe('mint');
    expect(knownNonWalletKind('11111111111111111111111111111111')).toBe('program');
    expect(knownNonWalletKind(WALLET)).toBeNull();
    expect(knownNonWalletKind('toString')).toBeNull();
  });

  it('valide un résultat complet et la réponse avec quota', () => {
    expect(walletScanResultSchema.parse(buildScan())).toEqual(buildScan());
    expect(walletScanResponseSchema.safeParse({ scan: buildScan(), quota: QUOTA }).success).toBe(true);
    expect(walletScanResponseSchema.safeParse({ scan: buildScan(), quota: { ...QUOTA, kind: 'analysis' } }).success).toBe(false);
  });

  it('nettoie les noms non fiables et refuse les incohérences', () => {
    const hostile = buildScan();
    const first = hostile.tokens[0];
    if (!first) throw new Error('fixture');
    first.token = { ...first.token, name: 'USDC‮<b>', symbol: 'U​SDC' };
    const parsed = walletScanResultSchema.parse(hostile);
    expect(parsed.tokens[0]?.token.symbol).toBe('USDC');
    expect(parsed.tokens[0]?.token.name).not.toContain('‮');

    const badVerdicts = buildScan();
    badVerdicts.summary.verdicts.danger = 1;
    expect(walletScanResultSchema.safeParse(badVerdicts).success).toBe(false);

    const badMint = buildScan();
    const token = badMint.tokens[0];
    if (!token) throw new Error('fixture');
    token.token = { ...token.token, mint: WALLET };
    expect(walletScanResultSchema.safeParse(badMint).success).toBe(false);

    const badAmount = buildScan();
    const delegation = badAmount.delegations[0];
    if (!delegation) throw new Error('fixture');
    delegation.delegatedAmount = { raw: '-1', decimals: 6, ui: '0' };
    expect(walletScanResultSchema.safeParse(badAmount).success).toBe(false);

    const tooMany = buildScan();
    tooMany.summary.delegationCount = 0;
    expect(walletScanResultSchema.safeParse(tooMany).success).toBe(false);
  });

  it('accepte les statuts non analysé et indisponible', () => {
    const scan = buildScan();
    const token = scan.tokens[0];
    if (!token) throw new Error('fixture');
    token.assessment = { status: 'unavailable', reason: 'budget' };
    scan.summary = { ...scan.summary, analyzedCount: 0, verdicts: { safe: 0, warn: 0, danger: 0 }, unavailableCount: 1 };
    expect(walletScanResultSchema.safeParse(scan).success).toBe(true);
    token.assessment = { status: 'not_analyzed', reason: 'over_limit' };
    expect(walletScanResultSchema.safeParse(scan).success).toBe(true);
    expect(walletScanResultSchema.safeParse({ ...scan, tokens: [{ ...token, assessment: { status: 'not_analyzed', reason: 'x' } }] }).success).toBe(false);
  });

  it('quota : refusé en Gratuit sans quota, autorisé avec un quota de scan', () => {
    expect(walletScanQuotaResponseSchema.safeParse({ allowed: false, quota: null }).success).toBe(true);
    expect(walletScanQuotaResponseSchema.safeParse({ allowed: true, quota: QUOTA }).success).toBe(true);
    expect(walletScanQuotaResponseSchema.safeParse({ allowed: true, quota: null }).success).toBe(false);
    expect(walletScanQuotaResponseSchema.safeParse({ allowed: false, quota: QUOTA }).success).toBe(false);
  });

  it('codes d’erreur intégrés au format commun, avec un message chacun', () => {
    for (const code of WALLET_ERROR_CODES) {
      expect(apiErrorCodeSchema.safeParse(code).success).toBe(true);
      expect(WALLET_ERROR_MESSAGES[code].length).toBeGreaterThan(10);
    }
  });

  it('liens de révocation : https officiels seulement, liste blanche exacte', () => {
    const hosts = ['help.phantom.com', 'solflare.com', 'help.solflare.com'];
    expect(new Set(WALLET_REVOKE_GUIDES.map((guide) => guide.wallet))).toEqual(new Set(['phantom', 'solflare']));
    for (const url of WALLET_REVOKE_GUIDE_URLS) {
      expect(isAllowedHttpsUrl(url, hosts)).toBe(true);
      expect(revokeGuideUrlSchema.safeParse(url).success).toBe(true);
    }
    expect(revokeGuideUrlSchema.safeParse('https://help.phantom.com/articles/autre').success).toBe(false);
    expect(revokeGuideUrlSchema.safeParse('https://revoke.example.com').success).toBe(false);
  });
});
