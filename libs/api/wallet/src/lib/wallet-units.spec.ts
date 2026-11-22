import type { ExecutionContext } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { UpstreamUnavailableError } from '@raijin/api-analysis';
import { ApiException, testConfig } from '@raijin/api-core';
import { UpstreamError, WalletInvalidError, WalletIsTokenError, WalletTooLargeError as SolanaTooLarge } from '@raijin/api-solana';
import { healthyFacts, NOW, PRO_USER, USER_ID, walletKit } from '../testing/wallet-test-kit';
import { FIXTURE_MINTS, FIXTURE_WALLETS } from './fixtures/fixture-wallets';
import { WalletScanThrottleGuard } from './http/wallet-scan-throttle.guard';
import { WalletScanController } from './http/wallet-scan.controller';
import { WalletAddressRejectedError, WalletTooLargeError } from './ports/wallet-data-source';
import { planHoldings, sortHoldings } from './scan/wallet-result-builder';
import { normalizeRaw, rawGte, tokenAmount, tokenCountBucket, walletKey } from './scan/wallet-utils';
import { SolanaWalletDataSource, type WalletSolanaData } from './solana/solana-wallet-data-source';

const token = (mint: string, valueUsd: number | null) => ({
  mint,
  tokenProgram: 'spl-token' as const,
  amountRaw: '1',
  decimals: 0,
  valueUsd,
  accountCount: 1,
  frozen: false,
  delegated: false,
  name: null,
  symbol: null,
});

describe('utilitaires du scan', () => {
  it('montants exacts u64 (BigInt), bornés, sans zéros superflus', () => {
    expect(tokenAmount('123450000', 6)).toEqual({ raw: '123450000', decimals: 6, ui: '123.45' });
    expect(tokenAmount('5', 9)).toEqual({ raw: '5', decimals: 9, ui: '0.000000005' });
    expect(tokenAmount('42', 0)).toEqual({ raw: '42', decimals: 0, ui: '42' });
    expect(tokenAmount('1000000', 6).ui).toBe('1');
    expect(normalizeRaw('99999999999999999999')).toBe('18446744073709551615');
    expect(normalizeRaw('-1')).toBe('0');
    expect(rawGte('18446744073709551615', '0')).toBe(true);
    expect(rawGte('1', '2')).toBe(false);
  });

  it('clé HMAC : stable, sans l’adresse, dépend du secret', () => {
    const key = walletKey('s'.repeat(48), FIXTURE_WALLETS.empty);
    expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(key).toBe(walletKey('s'.repeat(48), FIXTURE_WALLETS.empty));
    expect(key).not.toBe(walletKey('t'.repeat(48), FIXTURE_WALLETS.empty));
  });

  it('tranches du nombre de tokens', () => {
    expect([0, 1, 5, 6, 20, 21, 100, 101].map(tokenCountBucket)).toEqual(['0', '1-5', '1-5', '6-20', '6-20', '21-100', '21-100', '>100']);
  });

  it('tri valeur décroissante puis inconnue ; poussière = prix connu sous le seuil ; prix inconnu analysé', () => {
    const tokens = [token('C', null), token('A', 0.5), token('B', 10), token('D', 3), token('E', null)];
    expect(sortHoldings(tokens).map((t) => t.mint)).toEqual(['B', 'D', 'A', 'C', 'E']);
    const plan = planHoldings(tokens, 2, 1);
    expect(plan.toAnalyze).toEqual(['B', 'D']);
    expect(plan.notAnalyzed.get('A')).toEqual({ status: 'not_analyzed', reason: 'dust' });
    expect(plan.notAnalyzed.get('C')).toEqual({ status: 'not_analyzed', reason: 'over_limit' });
  });
});

describe('WalletScanThrottleGuard', () => {
  function context(auth: unknown): ExecutionContext {
    return { switchToHttp: () => ({ getRequest: () => ({ auth }) }) } as unknown as ExecutionContext;
  }

  it('limite par utilisateur (5/min en production), 429 RATE_LIMITED au-delà', async () => {
    const hits = new Map<string, number>();
    const storage = {
      increment: jest.fn(async (key: string) => {
        hits.set(key, (hits.get(key) ?? 0) + 1);
        return { totalHits: hits.get(key) ?? 0, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 };
      }),
    } as unknown as ThrottlerStorage;
    const config = testConfig({ RATE_LIMIT_WALLET_SCAN_PER_MINUTE: '2' });
    const guard = new WalletScanThrottleGuard(storage, config);
    await expect(guard.canActivate(context({ userId: 'u1' }))).resolves.toBe(true);
    await expect(guard.canActivate(context({ userId: 'u1' }))).resolves.toBe(true);
    await expect(guard.canActivate(context({ userId: 'u1' }))).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    // Un autre utilisateur (même IP éventuelle) garde sa propre limite.
    await expect(guard.canActivate(context({ userId: 'u2' }))).resolves.toBe(true);
    expect([...hits.keys()]).toEqual(['wallet-scan:u:u1', 'wallet-scan:u:u2']);
    await expect(guard.canActivate(context(undefined))).rejects.toBeInstanceOf(ApiException);
  });
});

describe('WalletScanController', () => {
  it('délègue au service avec l’identité de la session', async () => {
    const kit = walletKit({ user: PRO_USER, facts: { [FIXTURE_MINTS.bonk]: healthyFacts(FIXTURE_MINTS.bonk) } });
    const controller = new WalletScanController(kit.scan, kit.access);
    const auth = { userId: USER_ID, sessionId: 's', role: 'USER' as const, accessTokenExpiresAt: NOW };
    const response = await controller.scan({ address: FIXTURE_WALLETS.empty }, auth);
    expect(response.scan.summary.tokenCount).toBe(0);
    await expect(controller.quota(auth)).resolves.toMatchObject({ allowed: true, quota: { used: 1 } });
  });
});

describe('SolanaWalletDataSource (adaptateur @raijin/api-solana)', () => {
  const facts = healthyFacts(FIXTURE_MINTS.bonk);
  const holdings = {
    address: FIXTURE_WALLETS.delegations,
    tokens: [
      {
        mint: FIXTURE_MINTS.bonk,
        tokenProgram: 'spl-token',
        token: { mint: FIXTURE_MINTS.bonk, name: 'Bonk', symbol: 'Bonk', decimals: 5, tokenProgram: 'spl-token', untrusted: true },
        balance: { raw: '100000', decimals: 5, ui: '1' },
        priceUsd: 2,
        valueUsd: 2,
        accountCount: 1,
        frozen: false,
        delegated: true,
        selection: 'analyze',
      },
    ],
    delegations: [
      {
        tokenAccount: 'FaGq1fwmsnrzjBQ8rKnVPQ1X5cE5U4TdSJ66PMtGoAW5',
        mint: FIXTURE_MINTS.scam,
        tokenProgram: 'token-2022',
        token: { mint: FIXTURE_MINTS.scam, name: 'Gift', symbol: 'GIFT', decimals: 6, tokenProgram: 'token-2022', untrusted: true },
        delegate: 'BHdMK1AK7WqeC1ZEDNerKkJ1tZsc867DMAgVMA6e3mfC',
        delegatedAmount: { raw: '5', decimals: 6, ui: '0.000005' },
        balance: { raw: '0', decimals: 6, ui: '0' },
        coversFullBalance: true,
      },
    ],
    summary: { nftCount: 2, emptyAccountCount: 3 },
    sources: ['helius', 'dexscreener'],
    credits: 3,
  };

  function solana(overrides: Partial<Record<keyof WalletSolanaData, unknown>> = {}): WalletSolanaData {
    return {
      heliusConfigured: true,
      listWalletHoldings: jest.fn(async () => holdings),
      collectFactsLightBatch: jest.fn(async () => ({
        entries: [
          {
            mint: FIXTURE_MINTS.bonk,
            status: 'ok',
            fromCache: false,
            collected: {
              facts,
              token: { name: 'Bonk', symbol: 'Bonk', decimals: 5, tokenProgram: 'spl-token' },
              sources: [{ id: 'helius', status: 'ok', latencyMs: 12, errorKind: null }],
              checkSources: undefined,
              degraded: false,
            },
          },
          { mint: FIXTURE_MINTS.scam, status: 'unavailable', reason: 'budget' },
        ],
        credits: 11,
        budgetExhausted: true,
        timedOut: false,
      })),
      ...overrides,
    } as unknown as WalletSolanaData;
  }

  it('convertit avoirs, délégations (compte vide) et faits light ; passe le plafond et l’échéance', async () => {
    const data = solana();
    const source = new SolanaWalletDataSource(data, () => 20);
    expect(source.heliusConfigured).toBe(true);
    const listed = await source.listHoldings(FIXTURE_WALLETS.delegations, { maxAccounts: 1000, priceLookupMax: 150, dustUsd: 1 });
    expect(data.listWalletHoldings).toHaveBeenCalledWith(FIXTURE_WALLETS.delegations, { maxAccounts: 1000, priceLookupMax: 150, dustUsd: 1, maxTokens: 20 });
    expect(listed.tokens[0]).toMatchObject({ mint: FIXTURE_MINTS.bonk, amountRaw: '100000', decimals: 5, valueUsd: 2, name: 'Bonk' });
    expect(listed.delegations[0]).toMatchObject({ delegatedAmountRaw: '5', balanceRaw: '0', decimals: 6, symbol: 'GIFT' });
    expect(listed).toMatchObject({ nftCount: 2, emptyAccountCount: 3, credits: 3 });
    const signal = new AbortController().signal;
    await source.listHoldings(FIXTURE_WALLETS.delegations, { maxAccounts: 1000, priceLookupMax: 150, dustUsd: 1, signal });
    expect((data.listWalletHoldings as jest.Mock).mock.calls[1][1]).toMatchObject({ signal, maxTokens: 20 });

    const batch = await source.collectLightBatch([FIXTURE_MINTS.bonk, FIXTURE_MINTS.scam], { deadlineAt: Date.now() + 5_000 });
    expect(batch.credits).toBe(11);
    expect(batch.entries[0]).toMatchObject({ status: 'ok', collected: { facts, sources: [{ source: 'helius', status: 'ok' }] } });
    expect(batch.entries[1]).toEqual({ mint: FIXTURE_MINTS.scam, status: 'unavailable', reason: 'budget' });
    const options = (data.collectFactsLightBatch as jest.Mock).mock.calls[0][1] as { deadlineMs: number; signal: AbortSignal };
    expect(options.deadlineMs).toBeGreaterThan(4_000);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('erreurs de la lib → erreurs du port', async () => {
    const cases: [unknown, unknown][] = [
      [new WalletIsTokenError(), new WalletAddressRejectedError('token')],
      [new WalletInvalidError('program'), new WalletAddressRejectedError('invalid')],
      [new SolanaTooLarge(1200), new WalletTooLargeError()],
      [new UpstreamError('helius_rpc', 'timeout'), new UpstreamUnavailableError()],
    ];
    for (const [thrown, expected] of cases) {
      const source = new SolanaWalletDataSource(solana({ listWalletHoldings: jest.fn().mockRejectedValue(thrown) }), () => 8);
      const failure = await source.listHoldings(FIXTURE_WALLETS.empty, { maxAccounts: 1, priceLookupMax: 0, dustUsd: 1 }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf((expected as object).constructor);
      if (expected instanceof WalletAddressRejectedError) expect((failure as WalletAddressRejectedError).kind).toBe(expected.kind);
    }
    const unknown = new SolanaWalletDataSource(solana({ listWalletHoldings: jest.fn().mockRejectedValue(new TypeError('x')) }), () => 8);
    await expect(unknown.listHoldings(FIXTURE_WALLETS.empty, { maxAccounts: 1, priceLookupMax: 0, dustUsd: 1 })).rejects.toBeInstanceOf(TypeError);
  });
});
