import { Logger } from '@nestjs/common';
import { ApiException } from '@raijin/api-core';
import { walletScanQuotaResponseSchema, walletScanResponseSchema, type AnalysisResult } from '@raijin/shared-contracts';
import {
  dangerFacts,
  FREE_USER,
  healthyFacts,
  NOW,
  PRO_USER,
  TRIAL_USER,
  USER_ID,
  walletKit,
} from '../../testing/wallet-test-kit';
import { FIXTURE_DELEGATES, FIXTURE_MINTS, FIXTURE_WALLETS, UnavailableWalletDataSource } from '../fixtures/fixture-wallets';
import { WalletDataSource, type LightBatchResult, type ListHoldingsOptions, type WalletHoldings } from '../ports/wallet-data-source';
import { walletKey } from './wallet-utils';

const FACTS = {
  [FIXTURE_MINTS.bonk]: healthyFacts(FIXTURE_MINTS.bonk),
  [FIXTURE_MINTS.usdc]: healthyFacts(FIXTURE_MINTS.usdc),
  [FIXTURE_MINTS.mintActive]: dangerFacts(FIXTURE_MINTS.mintActive),
  [FIXTURE_MINTS.freshPump]: healthyFacts(FIXTURE_MINTS.freshPump),
};
const OTHER_USER_ID = '0195a0c4-0000-7000-8000-000000000002';
const OTHER_WALLET = '7nYabs9dUhvxYwdTnrWVBL9MYviKSfrEbdWCUbcnwkpF';

async function rejection(promise: Promise<unknown>): Promise<{ code: string; status: number }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiException) return { code: error.code, status: error.getStatus() };
    throw error;
  }
  throw new Error('Aucune erreur levée');
}

/** Toutes les clés du stockage mémoire (vérification : aucune adresse en clair). */
function storeKeys(store: unknown): string[] {
  return [...(store as { entries: Map<string, unknown> }).entries.keys()];
}

describe('WalletScanService', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logs.push(String(args[0]));
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it('Pro : scan contractuel avec délégations SPL et Token-2022 (compte vide), quota Pro 20', async () => {
    const kit = walletKit({ facts: FACTS });
    const response = await kit.scan.scan(USER_ID, { address: FIXTURE_WALLETS.delegations });
    expect(walletScanResponseSchema.safeParse(response).success).toBe(true);
    const { scan, quota } = response;
    expect(quota).toMatchObject({ kind: 'wallet_scan', plan: 'PRO', limit: 20, used: 1, remaining: 19 });
    expect(scan.cached).toBe(false);
    expect(scan.summary).toMatchObject({ tokenCount: 3, delegationCount: 2, emptyAccountCount: 1, totalValueUsd: 170 });
    // Tri : valeur décroissante, prix inconnu en dernier (mais analysé : prix inconnu ≠ poussière).
    expect(scan.tokens.map((token) => token.mint)).toEqual([FIXTURE_MINTS.bonk, FIXTURE_MINTS.usdc, FIXTURE_MINTS.scam]);
    expect(scan.tokens[2]?.assessment).toEqual({ status: 'unavailable', reason: 'upstream' });
    // Délégation couvrant tout le solde (compte vide) en tête.
    expect(scan.delegations[0]).toMatchObject({
      delegate: FIXTURE_DELEGATES.token2022,
      tokenProgram: 'token-2022',
      coversFullBalance: true,
      balance: { raw: '0', ui: '0' },
    });
    expect(scan.delegations[1]).toMatchObject({
      delegate: FIXTURE_DELEGATES.spl,
      coversFullBalance: false,
      delegatedAmount: { raw: '10000000', decimals: 6, ui: '10' },
      token: { symbol: 'USDC', untrusted: true },
    });
  });

  it('verdict rapide (règle D3) : Sain possible, « contrôle rapide (6/9) », Danger reste Danger', async () => {
    const kit = walletKit({ facts: FACTS });
    const { scan } = await kit.scan.scan(USER_ID, { address: FIXTURE_WALLETS.danger });
    const [danger, fresh, dust] = scan.tokens;
    expect(danger?.assessment).toMatchObject({ status: 'analyzed', verdict: 'danger', coverage: 'light', fromCache: false });
    expect(fresh?.assessment).toMatchObject({ status: 'analyzed', verdict: 'safe', coverage: 'light', checksEvaluated: 6, degraded: false });
    expect(fresh?.assessment.status === 'analyzed' && fresh.assessment.explanation).toContain('Contrôle rapide (6/9)');
    expect(fresh?.frozen).toBe(true);
    expect(dust?.assessment).toEqual({ status: 'not_analyzed', reason: 'dust' });
    expect(scan.summary).toMatchObject({ analyzedCount: 2, verdicts: { safe: 1, warn: 0, danger: 1 }, dustCount: 1, nftCount: 1, emptyAccountCount: 2 });
  });

  it('Gratuit, e-mail non vérifié, essai expiré : 403 WALLET_SCAN_PLAN_REQUIRED sans toucher au quota ni aux sources', async () => {
    const expired = { ...TRIAL_USER, trialEndsAt: new Date(NOW.getTime() - 1) };
    for (const user of [FREE_USER, { ...PRO_USER, emailVerifiedAt: null }, expired]) {
      const kit = walletKit({ user, facts: FACTS });
      const listHoldings = jest.spyOn(kit.source, 'listHoldings');
      // Le plan est vérifié avant le schéma : même un corps invalide donne 403.
      await expect(rejection(kit.scan.scan(USER_ID, { address: 'nimportequoi' }))).resolves.toEqual({ code: 'WALLET_SCAN_PLAN_REQUIRED', status: 403 });
      await expect(rejection(kit.scan.scan(USER_ID, { address: FIXTURE_WALLETS.delegations }))).resolves.toMatchObject({ status: 403 });
      expect(kit.quota.counts.size).toBe(0);
      expect(listHoldings).not.toHaveBeenCalled();
      await expect(kit.access.quotaResponse(USER_ID)).resolves.toEqual({ allowed: false, quota: null });
    }
  });

  it('compte supprimé : 401 AUTH_SESSION_EXPIRED', async () => {
    const kit = walletKit({ user: null });
    await expect(rejection(kit.scan.scan(USER_ID, { address: OTHER_WALLET }))).resolves.toEqual({ code: 'AUTH_SESSION_EXPIRED', status: 401 });
  });

  it('essai Pro : quota 10, puis 429 WALLET_SCAN_QUOTA_EXCEEDED ; GET quota cohérent', async () => {
    const kit = walletKit({ user: TRIAL_USER, facts: FACTS, env: { WALLET_SCAN_DAILY_LIMIT_TRIAL: '2' } });
    const first = await kit.scan.scan(USER_ID, { address: FIXTURE_WALLETS.empty });
    expect(first.quota).toMatchObject({ plan: 'FREE', limit: 2, used: 1, remaining: 1 });
    await kit.scan.scan(USER_ID, { address: OTHER_WALLET });
    await expect(rejection(kit.scan.scan(USER_ID, { address: FIXTURE_WALLETS.delegations }))).resolves.toEqual({
      code: 'WALLET_SCAN_QUOTA_EXCEEDED',
      status: 429,
    });
    const quota = await kit.access.quotaResponse(USER_ID);
    expect(walletScanQuotaResponseSchema.safeParse(quota).success).toBe(true);
    expect(quota).toMatchObject({ allowed: true, quota: { kind: 'wallet_scan', limit: 2, used: 2, remaining: 0 } });
    expect(walletKit({ user: TRIAL_USER }).config.wallet.dailyLimitTrial).toBe(10);
  });

  it('schéma : 400 WALLET_INVALID (saisie, champ en trop, programme connu), 422 WALLET_IS_TOKEN (mint connu), sans quota', async () => {
    const kit = walletKit();
    const cases: [unknown, string][] = [
      [{ address: 'pas-une-adresse' }, 'WALLET_INVALID'],
      [{ address: OTHER_WALLET, extra: 1 }, 'WALLET_INVALID'],
      [{}, 'WALLET_INVALID'],
      [null, 'WALLET_INVALID'],
      [[OTHER_WALLET], 'WALLET_INVALID'],
      [{ address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, 'WALLET_INVALID'],
      [{ address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' }, 'WALLET_IS_TOKEN'],
    ];
    for (const [body, code] of cases) {
      await expect(rejection(kit.scan.scan(USER_ID, body))).resolves.toEqual({ code, status: code === 'WALLET_IS_TOKEN' ? 422 : 400 });
    }
    expect(kit.quota.counts.size).toBe(0);
  });

  it('refus on-chain (programme, mint, trop gros) : quota remboursé, refus mis en cache sans nouvelle collecte', async () => {
    const kit = walletKit();
    const listHoldings = jest.spyOn(kit.source, 'listHoldings');
    const expected: [string, string, number][] = [
      [FIXTURE_WALLETS.program, 'WALLET_INVALID', 400],
      [FIXTURE_WALLETS.mint, 'WALLET_IS_TOKEN', 422],
      [FIXTURE_WALLETS.tooLarge, 'WALLET_TOO_LARGE', 422],
    ];
    for (const [address, code, status] of expected) {
      await expect(rejection(kit.scan.scan(USER_ID, { address }))).resolves.toEqual({ code, status });
    }
    expect(kit.quota.refunds).toBe(3);
    expect(kit.quota.counts.get('wallet_scan')).toBe(0);
    await expect(rejection(kit.scan.scan(USER_ID, { address: FIXTURE_WALLETS.tooLarge }))).resolves.toMatchObject({ code: 'WALLET_TOO_LARGE' });
    expect(listHoldings).toHaveBeenCalledTimes(3);
  });

  it('sources en panne : 503 UPSTREAM_UNAVAILABLE, quota remboursé', async () => {
    const kit = walletKit({ source: new UnavailableWalletDataSource() });
    await expect(rejection(kit.scan.scan(USER_ID, { address: OTHER_WALLET }))).resolves.toEqual({ code: 'UPSTREAM_UNAVAILABLE', status: 503 });
    expect(kit.quota.refunds).toBe(1);
  });

  it('cache du wallet sous clé HMAC (120 s) : re-scan servi en cache, non recompté, aucune adresse dans les clés', async () => {
    const kit = walletKit({ facts: FACTS });
    const listHoldings = jest.spyOn(kit.source, 'listHoldings');
    await kit.scan.scan(USER_ID, { address: FIXTURE_WALLETS.delegations });
    const again = await kit.scan.scan(USER_ID, { address: FIXTURE_WALLETS.delegations });
    expect(again.scan.cached).toBe(true);
    expect(again.quota.used).toBe(1);
    expect(listHoldings).toHaveBeenCalledTimes(1);
    const key = walletKey(kit.config.analysis.ipHashSecret, FIXTURE_WALLETS.delegations);
    expect(storeKeys(kit.store)).toContain(`wallet:scan:${kit.engine.version}:${key}`);
    for (const stored of storeKeys(kit.store)) expect(stored).not.toContain(FIXTURE_WALLETS.delegations);
    expect(kit.scan.cacheTtlMs).toBe(120_000);
  });

  it('verdicts réutilisés : analyse complète en cache Redis ou en base (≤ 1 h), verdict rapide partagé', async () => {
    const kit = walletKit({ facts: FACTS });
    const full: AnalysisResult = {
      mint: FIXTURE_MINTS.bonk,
      token: { mint: FIXTURE_MINTS.bonk, name: 'Bonk', symbol: 'Bonk', decimals: 5, tokenProgram: 'spl-token', untrusted: true },
      verdict: 'warn',
      explanation: '1 contrôle demande ton attention, sans signal critique.',
      checks: (['mint_authority', 'freeze_authority', 'liquidity', 'holder_concentration', 'sell_simulation', 'metadata_mutable', 'token_age', 'creator_history', 'rugcheck'] as const).map(
        (id) => ({ id, status: id === 'rugcheck' ? 'unavailable' : 'ok', summary: 'ok', metrics: [], sources: [{ id: 'helius', name: 'Helius', url: null }], reasonCodes: [] }),
      ),
      engineVersion: kit.engine.version,
      analyzedAt: NOW.toISOString(),
      cached: false,
      degraded: true,
    };
    await kit.store.set(`analysis:result:${kit.engine.version}:${FIXTURE_MINTS.bonk}`, JSON.stringify(full), 60_000);
    kit.prisma.tokenAnalysis.findMany.mockResolvedValueOnce([
      { mint: FIXTURE_MINTS.usdc, token: { ...full.token, mint: FIXTURE_MINTS.usdc }, verdict: 'safe', explanation: 'Aucun signal.', checks: full.checks, engineVersion: '1.0.0', degraded: false, createdAt: NOW },
    ]);
    const { scan } = await kit.scan.scan(USER_ID, { address: FIXTURE_WALLETS.delegations });
    expect(scan.tokens[0]?.assessment).toMatchObject({ status: 'analyzed', verdict: 'warn', coverage: 'full', checksEvaluated: 8, fromCache: true });
    expect(scan.tokens[1]?.assessment).toMatchObject({ status: 'analyzed', verdict: 'safe', coverage: 'full', fromCache: true });
    expect(kit.facts.calls).toEqual([FIXTURE_MINTS.scam]);
    const since = (kit.prisma.tokenAnalysis.findMany.mock.calls[0] as unknown as [{ where: { createdAt: { gte: Date } } }])[0].where.createdAt.gte;
    expect(since.toISOString()).toBe(new Date(NOW.getTime() - 3_600_000).toISOString());

    // Verdict rapide d'un mint mis en cache : un autre wallet qui le détient ne relance pas la collecte.
    await kit.scan.scan(USER_ID, { address: FIXTURE_WALLETS.danger });
    const calls = kit.facts.calls.length;
    await kit.store.delete(`wallet:scan:${kit.engine.version}:${walletKey(kit.config.analysis.ipHashSecret, FIXTURE_WALLETS.danger)}`);
    const second = await kit.scan.scan(USER_ID, { address: FIXTURE_WALLETS.danger });
    expect(kit.facts.calls.length).toBe(calls);
    expect(second.scan.tokens[0]?.assessment).toMatchObject({ verdict: 'danger', coverage: 'light', fromCache: true });
  });

  it('plafond de tokens analysés : les suivants « au-delà du plafond »', async () => {
    const kit = walletKit({ facts: FACTS, env: { WALLET_SCAN_MAX_TOKENS: '1' } });
    const { scan } = await kit.scan.scan(USER_ID, { address: FIXTURE_WALLETS.delegations });
    expect(scan.tokens.map((token) => token.assessment.status)).toEqual(['analyzed', 'not_analyzed', 'not_analyzed']);
    expect(scan.summary.overLimitCount).toBe(2);
  });

  it('échéance dépassée : tokens « timeout », résultat partiel, jamais d’erreur bloquante', async () => {
    class SlowSource extends WalletDataSource {
      get heliusConfigured() {
        return false;
      }
      async listHoldings(): Promise<WalletHoldings> {
        return {
          tokens: [{ mint: FIXTURE_MINTS.bonk, tokenProgram: 'spl-token', amountRaw: '1', decimals: 0, valueUsd: null, accountCount: 1, frozen: false, delegated: false, name: null, symbol: null }],
          delegations: [],
          nftCount: 0,
          emptyAccountCount: 0,
          sources: ['solana_rpc'],
          credits: 0,
        };
      }
      collectLightBatch(): Promise<LightBatchResult> {
        return new Promise(() => undefined);
      }
    }
    const kit = walletKit({ source: new SlowSource(), env: { WALLET_SCAN_DEADLINE_MS: '1000' } });
    const { scan } = await kit.scan.scan(USER_ID, { address: OTHER_WALLET });
    expect(scan.partial).toBe(true);
    expect(scan.tokens[0]?.assessment).toEqual({ status: 'unavailable', reason: 'timeout' });
    expect(kit.scan.cacheTtlMs).toBe(600_000);
    expect(kit.scan.maxTokens).toBe(8);
  });

  it('single-flight : deux scans simultanés du même wallet → une seule collecte', async () => {
    const kit = walletKit({ facts: FACTS });
    const listHoldings = jest.spyOn(kit.source, 'listHoldings');
    const [a, b] = await Promise.all([
      kit.scan.scan(USER_ID, { address: FIXTURE_WALLETS.danger }),
      kit.scan.scan(USER_ID, { address: FIXTURE_WALLETS.danger }),
    ]);
    expect(listHoldings).toHaveBeenCalledTimes(1);
    expect([a.scan.cached, b.scan.cached].sort()).toEqual([false, true]);
  });

  it('RGPD : ProductEvent wallet_scanned sans adresse, mint ni délégué ; journaux sans adresse', async () => {
    const kit = walletKit({ facts: FACTS });
    await kit.scan.scan(USER_ID, { address: FIXTURE_WALLETS.delegations });
    await expect(rejection(kit.scan.scan(USER_ID, { address: FIXTURE_WALLETS.program }))).resolves.toMatchObject({ code: 'WALLET_INVALID' });
    expect(kit.prisma.productEvent.create).toHaveBeenCalledTimes(1);
    const event = (kit.prisma.productEvent.create.mock.calls[0] as unknown as [{ data: { type: string; properties: Record<string, unknown> } }])[0].data;
    expect(event.type).toBe('wallet_scanned');
    expect(event.properties).toEqual({
      tokenCountBucket: '1-5',
      analyzedCount: 2,
      delegationCount: 2,
      cached: false,
      partial: false,
      durationMs: expect.any(Number),
      credits: 6,
      plan: 'PRO',
      trialActive: false,
    });
    const written = JSON.stringify([kit.prisma.productEvent.create.mock.calls, logs]);
    for (const secret of [FIXTURE_WALLETS.delegations, FIXTURE_WALLETS.program, FIXTURE_DELEGATES.spl, FIXTURE_MINTS.bonk, FIXTURE_WALLETS.delegations.slice(0, 4)]) {
      expect(written).not.toContain(secret);
    }
    expect(logs.some((line) => line.startsWith('Scan de wallet frais'))).toBe(true);
    // Aucune écriture en base hors de l'événement (pas de table de scans, pas de TokenAnalysis).
    expect(Object.keys(kit.prisma)).toEqual(['user', 'tokenAnalysis', 'productEvent']);
  });

  it('audit : valeur en cache sans l’adresse (remise depuis la requête à la lecture)', async () => {
    const kit = walletKit({ facts: FACTS });
    await kit.scan.scan(USER_ID, { address: FIXTURE_WALLETS.delegations });
    const key = `wallet:scan:${kit.engine.version}:${walletKey(kit.config.analysis.ipHashSecret, FIXTURE_WALLETS.delegations)}`;
    const raw = (await kit.store.get(key)) ?? '';
    expect(raw).not.toContain(FIXTURE_WALLETS.delegations);
    expect(JSON.parse(raw)).not.toHaveProperty('address');
    const again = await kit.scan.scan(USER_ID, { address: FIXTURE_WALLETS.delegations });
    expect(again.scan).toMatchObject({ address: FIXTURE_WALLETS.delegations, cached: true });
  });

  it('audit : `cached` ne révèle pas le scan d’un autre compte (cache et single-flight partagés)', async () => {
    const kit = walletKit({ facts: FACTS });
    const listHoldings = jest.spyOn(kit.source, 'listHoldings');
    await kit.scan.scan(USER_ID, { address: FIXTURE_WALLETS.danger });
    const other = await kit.scan.scan(OTHER_USER_ID, { address: FIXTURE_WALLETS.danger });
    expect(other.scan.cached).toBe(false);
    expect(listHoldings).toHaveBeenCalledTimes(1);
    expect((await kit.scan.scan(OTHER_USER_ID, { address: FIXTURE_WALLETS.danger })).scan.cached).toBe(true);

    const flight = walletKit({ facts: FACTS });
    const [a, b] = await Promise.all([
      flight.scan.scan(USER_ID, { address: FIXTURE_WALLETS.delegations }),
      flight.scan.scan(OTHER_USER_ID, { address: FIXTURE_WALLETS.delegations }),
    ]);
    expect([a.scan.cached, b.scan.cached]).toEqual([false, false]);
  });

  it('audit : échéance propagée à listHoldings (AbortSignal), attente du verrou déduite', async () => {
    let received: AbortSignal | undefined;
    class HangingSource extends WalletDataSource {
      get heliusConfigured() {
        return true;
      }
      listHoldings(_address: string, options: ListHoldingsOptions): Promise<WalletHoldings> {
        received = options.signal;
        return new Promise((_resolve, reject) => {
          if (options.signal?.aborted) reject(new Error('aborted'));
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      async collectLightBatch(): Promise<LightBatchResult> {
        return { entries: [], credits: 0 };
      }
    }
    const kit = walletKit({ source: new HangingSource(), env: { WALLET_SCAN_DEADLINE_MS: '1000' } });
    let started = Date.now();
    await expect(rejection(kit.scan.scan(USER_ID, { address: OTHER_WALLET }))).resolves.toEqual({ code: 'UPSTREAM_UNAVAILABLE', status: 503 });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(received?.aborted).toBe(true);
    expect(kit.quota.refunds).toBe(1);

    // Verrou tenu par une autre instance : l'attente consomme l'échéance, pas 2 × 15 s.
    const lockKey = `wallet:lock:${walletKey(kit.config.analysis.ipHashSecret, FIXTURE_WALLETS.empty)}`;
    await kit.store.set(lockKey, 'autre-instance', 60_000);
    started = Date.now();
    await expect(rejection(kit.scan.scan(USER_ID, { address: FIXTURE_WALLETS.empty }))).resolves.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});
