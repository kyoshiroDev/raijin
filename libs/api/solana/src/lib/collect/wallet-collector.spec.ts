import {
  ANALYSIS_CHECK_IDS,
  riskFactsSchema,
  walletDelegationSchema,
} from '@raijin/shared-contracts';
import { LIGHT_PROFILE_NOT_EVALUATED, assessmentDepth, createRiskEngine, explainVerdict } from '@raijin/shared-risk-engine';
import { resolveSolanaDataConfig } from '../config';
import { UpstreamError, WalletInvalidError, WalletIsTokenError, WalletTooLargeError } from '../core/errors';
import { MemoryCacheStore, MemoryCreditBudget } from '../core/memory';
import type { CacheStore, Clock, CreditBudget, CreditLane, FetchLike, LogFields, SolanaLogger } from '../core/ports';
import { SolanaDataService, type SolanaDataOptions } from '../solana-data.service';
import { createFixtureFetch, fixtureAddress, loadAllFixtures } from '../testing/fixture-fetch';
import { WALLET_FIXTURE_ACCOUNTS as ACC, WALLET_FIXTURE_ADDRESSES as W } from '../testing/wallet-fixtures';
import { formatTokenAmount, type LightFactsEntry } from './wallet-collector';

const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const clock: Clock = { now: () => NOW };
const KEY = 'wallet-test-helius-key-0000-SECRET';
const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const fast = { ratePerSecond: 1_000, maxQueue: 200 };
const testConfig = {
  maxAttempts: 1,
  backoffBaseMs: 0,
  breakerThreshold: 1_000,
  limits: { helius_rpc: fast, helius_das: fast, solana_rpc: fast, dexscreener: fast, geckoterminal: fast, jupiter: fast, rugcheck: fast },
};

class CapturingLogger implements SolanaLogger {
  readonly lines: string[] = [];
  debug(event: string, fields: LogFields): void {
    this.lines.push(JSON.stringify({ event, ...fields }));
  }
  warn(event: string, fields: LogFields): void {
    this.lines.push(JSON.stringify({ event, ...fields }));
  }
}

/** Budget qui compte par voie (vérifie que le scan débite bien la voie `wallet`). */
class LaneBudget implements CreditBudget {
  readonly byLane: Record<string, number> = {};
  constructor(private readonly refuse: (lane: CreditLane) => boolean = () => false) {}
  async tryConsume(credits: number, lane: CreditLane): Promise<boolean> {
    if (this.refuse(lane)) return false;
    this.byLane[lane] = (this.byLane[lane] ?? 0) + credits;
    return true;
  }
}

function fixtureService(options: Partial<SolanaDataOptions> & { overrides?: Parameters<typeof createFixtureFetch>[2] } = {}) {
  const config = resolveSolanaDataConfig({ ...testConfig, ...options.config });
  const fixtureFetch = createFixtureFetch(loadAllFixtures(), config, options.overrides);
  const logger = new CapturingLogger();
  const budget = new LaneBudget();
  const svc = new SolanaDataService({
    clock,
    logger,
    random: () => 0,
    cache: new MemoryCacheStore(clock),
    creditBudget: budget,
    heliusApiKey: null,
    ...options,
    config: { ...testConfig, ...options.config },
    fetch: fixtureFetch.fetch,
  });
  return { svc, budget, logger, ...fixtureFetch };
}

const lightEngine = createRiskEngine({ notEvaluated: LIGHT_PROFILE_NOT_EVALUATED });

function okEntry(entries: readonly LightFactsEntry[], mint: string) {
  const entry = entries.find((candidate) => candidate.mint === mint);
  if (entry?.status !== 'ok') throw new Error(`entrée non ok : ${mint} ${JSON.stringify(entry)}`);
  return entry;
}

describe('formatTokenAmount', () => {
  it.each([
    [0n, 6, '0'],
    [1n, 6, '0.000001'],
    [400_000_000n, 6, '400'],
    [123_450_000n, 6, '123.45'],
    [7n, 0, '7'],
    [18_446_744_073_709_551_615n, 9, '18446744073.709551615'],
  ])('%s / 10^%s = %s', (raw, decimals, ui) => {
    expect(formatTokenAmount(raw, decimals)).toEqual({ raw: raw.toString(), decimals, ui });
  });
});

describe('listWalletHoldings : fixtures synthétiques', () => {
  it('délégations SPL et Token-2022 (dont compte vide), tri par valeur, 3 crédits sur la voie wallet', async () => {
    const { svc, budget, calls } = fixtureService({ heliusApiKey: KEY });
    const holdings = await svc.listWalletHoldings(W.delegation);

    expect(holdings.tokens.map((token) => [token.mint, token.valueUsd, token.selection])).toEqual([
      [ACC.safeMint, 100, 'analyze'],
      [ACC.pyusd, expect.closeTo(40, 0), 'analyze'],
    ]);
    const safe = holdings.tokens[0];
    expect(safe).toMatchObject({
      tokenProgram: 'spl-token',
      balance: { raw: '400000000', decimals: 6, ui: '400' },
      priceUsd: 0.25,
      accountCount: 1,
      frozen: false,
      delegated: true,
      token: { name: 'Raijin Fixture Safe', symbol: 'RFSAFE', untrusted: true },
    });
    expect(holdings.tokens[1]?.tokenProgram).toBe('token-2022');

    expect(holdings.delegations).toHaveLength(3);
    for (const delegation of holdings.delegations) expect(walletDelegationSchema.parse(delegation)).toEqual(delegation);
    const byDelegate = Object.fromEntries(holdings.delegations.map((d) => [d.delegate, d]));
    expect(byDelegate[ACC.delegateFull]).toMatchObject({ mint: ACC.safeMint, coversFullBalance: true, delegatedAmount: { ui: '400' } });
    expect(byDelegate[ACC.delegateEmptyAccount]).toMatchObject({ mint: ACC.usdc, token: null, balance: { raw: '0' }, delegatedAmount: { ui: '25' }, coversFullBalance: true });
    expect(byDelegate[ACC.delegatePartial]).toMatchObject({ mint: ACC.pyusd, tokenProgram: 'token-2022', coversFullBalance: false, delegatedAmount: { ui: '10' }, balance: { ui: '40' } });

    expect(holdings.summary).toEqual({
      accountCount: 4,
      rejectedAccountCount: 0,
      tokenCount: 2,
      analyzeCount: 2,
      dustCount: 0,
      overLimitCount: 0,
      nftCount: 0,
      emptyAccountCount: 1,
      delegationCount: 3,
      totalValueUsd: expect.closeTo(140, 0),
    });
    expect(holdings).toMatchObject({ address: W.delegation, maxTokens: 20, accountsSource: 'helius', pricesComplete: true, sources: ['helius', 'dexscreener'], credits: 3 });
    expect(budget.byLane).toEqual({ wallet: 3 });
    expect(calls.map((call) => call.route)).toEqual(['getAccountInfo', 'getTokenAccountsByOwner', 'getTokenAccountsByOwner', expect.stringMatching(/^\/tokens\/v1\/solana\//)]);
  });

  it('wallet Danger sans clé : poussière, prix inconnu ≠ poussière, NFT compté, plafond 8, 0 crédit', async () => {
    const { svc, budget } = fixtureService();
    const holdings = await svc.listWalletHoldings(W.danger);
    expect(holdings.tokens.map((token) => [token.mint, token.selection])).toEqual([
      [ACC.safeMint, 'analyze'],
      [ACC.usdc, 'dust'],
      [ACC.mintActive, 'analyze'],
    ]);
    expect(holdings.tokens[2]?.valueUsd).toBeNull();
    expect(holdings.summary).toMatchObject({ tokenCount: 3, analyzeCount: 2, dustCount: 1, nftCount: 1, emptyAccountCount: 0, delegationCount: 0, totalValueUsd: expect.closeTo(500.4, 0) });
    expect(holdings).toMatchObject({ maxTokens: 8, accountsSource: 'solana_rpc', sources: ['solana_rpc', 'dexscreener'], credits: 0 });
    expect(budget.byLane).toEqual({});
  });

  it('plafond de tokens analysés : les suivants passent over_limit', async () => {
    const { svc } = fixtureService();
    const holdings = await svc.listWalletHoldings(W.danger, { maxTokens: 1, dustUsd: 0 });
    expect(holdings.tokens.map((token) => token.selection)).toEqual(['analyze', 'over_limit', 'over_limit']);
    expect(holdings.summary).toMatchObject({ analyzeCount: 1, overLimitCount: 2, dustCount: 0 });
  });

  it('wallet vide (compte absent) : résultat vide, aucun appel de prix', async () => {
    const { svc, calls } = fixtureService({ heliusApiKey: KEY });
    const holdings = await svc.listWalletHoldings(W.empty);
    expect(holdings.tokens).toEqual([]);
    expect(holdings.delegations).toEqual([]);
    expect(holdings.summary).toMatchObject({ accountCount: 0, tokenCount: 0, totalValueUsd: null });
    expect(holdings.sources).toEqual(['helius']);
    expect(calls.some((call) => call.source === 'dexscreener')).toBe(false);
  });

  it('plus de 1 000 comptes : WALLET_TOO_LARGE avant tout prix ou verdict', async () => {
    const { svc, calls } = fixtureService({ heliusApiKey: KEY });
    const error = (await svc.listWalletHoldings(W.tooLarge).catch((e: unknown) => e)) as WalletTooLargeError;
    expect(error).toBeInstanceOf(WalletTooLargeError);
    expect(error.code).toBe('WALLET_TOO_LARGE');
    expect(error.accountCount).toBe(1001);
    expect(calls.some((call) => call.source === 'dexscreener')).toBe(false);
  });

  it('plafond configurable', async () => {
    const { svc } = fixtureService();
    await expect(svc.listWalletHoldings(W.delegation, { maxAccounts: 3 })).rejects.toBeInstanceOf(WalletTooLargeError);
  });

  it('adresse de mint (lue on-chain) : WALLET_IS_TOKEN après un seul appel', async () => {
    const { svc, calls } = fixtureService({ heliusApiKey: KEY });
    const error = (await svc.listWalletHoldings(W.isToken).catch((e: unknown) => e)) as WalletIsTokenError;
    expect(error).toBeInstanceOf(WalletIsTokenError);
    expect(error.code).toBe('WALLET_IS_TOKEN');
    expect(calls.map((call) => call.route)).toEqual(['getAccountInfo']);
  });

  it('programme exécutable : WALLET_INVALID', async () => {
    const { svc } = fixtureService();
    const error = (await svc.listWalletHoldings(W.program).catch((e: unknown) => e)) as WalletInvalidError;
    expect(error).toBeInstanceOf(WalletInvalidError);
    expect([error.code, error.reason]).toEqual(['WALLET_INVALID', 'program']);
  });

  it.each([
    ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', WalletIsTokenError],
    ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', WalletInvalidError],
    ['pas-une-adresse', WalletInvalidError],
  ])('%s refusé sans appel réseau', async (address, type) => {
    const { svc, calls } = fixtureService();
    await expect(svc.listWalletHoldings(address)).rejects.toBeInstanceOf(type);
    expect(calls).toEqual([]);
  });
});

describe('collectFactsLightBatch : fixtures synthétiques', () => {
  it('avec clé : sain → Sain 6/9 (règle D3), mint actif → Danger ; ≈ 15 crédits sur la voie wallet', async () => {
    const { svc, budget } = fixtureService({ heliusApiKey: KEY });
    const batch = await svc.collectFactsLightBatch([ACC.safeMint, ACC.mintActive]);
    expect(batch.entries.map((entry) => entry.mint)).toEqual([ACC.safeMint, ACC.mintActive]);

    const safe = okEntry(batch.entries, ACC.safeMint);
    expect(riskFactsSchema.parse(safe.collected.facts)).toEqual(safe.collected.facts);
    expect(safe.collected.profile).toBe('light');
    expect(safe.collected.degraded).toBe(false);
    expect(safe.collected.facts.holders).toEqual({ top10Pct: 22.25, maxSingleHolderPct: 2.9, excludedAccounts: 2 });
    expect(safe.collected.facts.metadata).toEqual({ mutable: false });
    expect(safe.collected.facts.age?.poolCreatedAt).toBe('2024-03-01T00:00:00.000Z');
    expect(safe.collected.token).toMatchObject({ name: 'Raijin Fixture Safe', symbol: 'RFSAFE', decimals: 6, tokenProgram: 'spl-token' });
    expect(Object.keys(safe.collected.checkSources)).toEqual([...ANALYSIS_CHECK_IDS]);
    const safeAssessment = lightEngine(safe.collected.facts);
    expect(safeAssessment.verdict).toBe('safe');
    expect(assessmentDepth(safeAssessment, LIGHT_PROFILE_NOT_EVALUATED).checksEvaluated).toBe(6);
    expect(explainVerdict(safeAssessment, { notEvaluated: LIGHT_PROFILE_NOT_EVALUATED })).toContain('Contrôle rapide (6/9)');

    const danger = okEntry(batch.entries, ACC.mintActive);
    expect(danger.collected.facts.mintAccount?.mintAuthorityActive).toBe(true);
    expect(danger.collected.facts.holders).toBeNull();
    expect(danger.collected.degraded).toBe(true);
    expect(lightEngine(danger.collected.facts).verdict).toBe('danger');

    // mints 1 + getAssetBatch 10 + top 20 (×2 : le second échoue, débité) + propriétaires 1 + programmes 1.
    expect(batch.credits).toBe(15);
    expect(budget.byLane).toEqual({ wallet: 15 });
    expect(batch).toMatchObject({ budgetExhausted: false, timedOut: false });
  });

  it('sans clé : RPC public, ni DAS ni holders ; sain → Sain 4/9, 0 crédit', async () => {
    const { svc, calls } = fixtureService();
    const batch = await svc.collectFactsLightBatch([ACC.mintActive, ACC.safeMint]);
    const safe = okEntry(batch.entries, ACC.safeMint);
    expect(safe.collected.facts.holders).toBeNull();
    expect(safe.collected.facts.metadata).toBeNull();
    const assessment = lightEngine(safe.collected.facts);
    expect(assessment.verdict).toBe('safe');
    expect(assessmentDepth(assessment, LIGHT_PROFILE_NOT_EVALUATED).checksEvaluated).toBe(4);
    expect(lightEngine(okEntry(batch.entries, ACC.mintActive).collected.facts).verdict).toBe('danger');
    expect(batch.credits).toBe(0);
    expect(calls.map((call) => call.source)).toEqual(['solana_rpc', 'dexscreener']);
    expect(safe.collected.sources.find((source) => source.id === 'helius')?.status).toBe('skipped');
  });

  it('réutilise les paires lues pour les prix et met en cache les faits light (cache partiel rejoué)', async () => {
    const cache = new MemoryCacheStore(clock);
    const { svc, calls } = fixtureService({ heliusApiKey: KEY, cache });
    await svc.listWalletHoldings(W.danger);
    calls.length = 0;
    const first = await svc.collectFactsLightBatch([ACC.safeMint]);
    expect(calls.some((call) => call.source === 'dexscreener')).toBe(false);
    expect(okEntry(first.entries, ACC.safeMint).fromCache).toBe(false);

    calls.length = 0;
    const second = await svc.collectFactsLightBatch([ACC.safeMint, ACC.mintActive, ACC.safeMint]);
    expect(second.entries).toHaveLength(2);
    expect(okEntry(second.entries, ACC.safeMint).fromCache).toBe(true);
    expect(okEntry(second.entries, ACC.mintActive).fromCache).toBe(false);
    expect(calls.filter((call) => call.route === 'getMultipleAccounts')).toHaveLength(1);

    const third = await svc.collectFactsLightBatch([ACC.safeMint]);
    expect(third.credits).toBe(0);
  });

  it('cache hostile ou corrompu : ignoré, faits recollectés', async () => {
    const store = new Map<string, string>();
    const cache: CacheStore = {
      get: async (key) => store.get(key) ?? null,
      set: async (key, value) => {
        store.set(key, value);
      },
    };
    store.set(`solana:light-facts:v1:${ACC.safeMint}`, JSON.stringify({ profile: 'light', facts: { mint: 'x' } }));
    store.set(`solana:wallet-pairs:${ACC.safeMint}`, '{pas du json');
    const { svc } = fixtureService({ cache });
    const batch = await svc.collectFactsLightBatch([ACC.safeMint]);
    expect(okEntry(batch.entries, ACC.safeMint).fromCache).toBe(false);
  });

  it('mint invalide ou absent : unavailable unanalyzable', async () => {
    const { svc } = fixtureService({
      overrides: (url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string };
        if (body.method === 'getMultipleAccounts') {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: [null] } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return undefined;
      },
    });
    const batch = await svc.collectFactsLightBatch(['pas-un-mint', ACC.safeMint]);
    expect(batch.entries).toEqual([
      { mint: 'pas-un-mint', status: 'unavailable', reason: 'unanalyzable' },
      { mint: ACC.safeMint, status: 'unavailable', reason: 'unanalyzable' },
    ]);
  });
});

// --- Chaîne simulée : wallet de N tokens (mesure du coût, budget, échéance) --------------------------

interface ChainOptions {
  readonly tokens: number;
  /** Méthodes RPC qui échouent (HTTP 500), par point d'accès. */
  readonly failHelius?: ReadonlySet<string>;
  readonly failPublic?: ReadonlySet<string>;
  readonly delayMs?: number;
  readonly dexDown?: boolean;
  readonly hostileName?: boolean;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const rpc = (value: unknown) => json({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value } });
const rpcRaw = (result: unknown) => json({ jsonrpc: '2.0', id: 1, result });

/** Petite chaîne Solana simulée (format jsonParsed), sans fixture : sert aux mesures de coût. */
function simulatedChain(owner: string, options: ChainOptions) {
  const mints = Array.from({ length: options.tokens }, (_, index) => fixtureAddress(`sim:mint:${index}`));
  const mintSet = new Set(mints);
  const holderAccount = (mint: string, index: number) => fixtureAddress(`sim:holder:${mint}:${index}`);
  const accountOwner = new Map<string, string>();
  for (const mint of mints) for (let index = 0; index < 20; index += 1) accountOwner.set(holderAccount(mint, index), fixtureAddress(`sim:wallet:${mint}:${index}`));
  const tokenAccount = (mint: string, ownerAddress: string, amount: string, extra: Record<string, unknown> = {}) => ({
    data: { parsed: { info: { isNative: false, mint, owner: ownerAddress, state: 'initialized', tokenAmount: { amount, decimals: 6, uiAmount: 1, uiAmountString: '1' }, ...extra }, type: 'account' }, program: 'spl-token', space: 165 },
    executable: false,
    lamports: 2039280,
    owner: SPL,
    space: 165,
  });
  const mintAccount = { data: { parsed: { info: { decimals: 6, freezeAuthority: null, mintAuthority: null, supply: '1000000000000', isInitialized: true }, type: 'mint' }, program: 'spl-token', space: 82 }, executable: false, lamports: 1, owner: SPL, space: 82 };

  const fetchFn: FetchLike = async (url, init) => {
    if (options.delayMs) {
      // Comme `fetch` : l'annulation du signal interrompt la requête en cours.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, options.delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }
    if (url.startsWith('https://api.dexscreener.com/tokens/v1/solana/')) {
      if (options.dexDown) return json({}, 500);
      const wanted = url.slice('https://api.dexscreener.com/tokens/v1/solana/'.length).split(',');
      return json(
        wanted.map((mint, index) => ({
          chainId: 'solana',
          dexId: 'raydium',
          pairAddress: fixtureAddress(`sim:pair:${mint}`),
          baseToken: { address: mint, name: options.hostileName ? 'Fake‮USDC​' : `Sim ${index}`, symbol: 'SIM' },
          quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', symbol: 'SOL' },
          priceUsd: String(1 + mints.indexOf(mint)),
          liquidity: { usd: 500_000, base: 1, quote: 1 },
          pairCreatedAt: 1_700_000_000_000,
        })),
      );
    }
    const helius = url.startsWith('https://mainnet.helius-rpc.com');
    const payload = JSON.parse(String(init?.body)) as { method: string; params: unknown };
    if ((helius ? options.failHelius : options.failPublic)?.has(payload.method)) return json({}, 500);
    const params = payload.params as unknown[];
    switch (payload.method) {
      case 'getAccountInfo':
        return rpc({ data: ['', 'base64'], executable: false, lamports: 1, owner: '11111111111111111111111111111111', space: 0 });
      case 'getTokenAccountsByOwner': {
        if ((params[1] as { programId: string }).programId === T22) return rpc([]);
        return rpc([
          ...mints.map((mint, index) => ({ pubkey: fixtureAddress(`sim:own:${index}`), account: tokenAccount(mint, owner, '5000000') })),
          // Entrées hostiles : propriétaire incohérent, mint invalide.
          { pubkey: fixtureAddress('sim:own:foreign'), account: tokenAccount(mints[0] as string, fixtureAddress('someone-else'), '1') },
          { pubkey: fixtureAddress('sim:own:bad'), account: tokenAccount('pas-un-mint', owner, '1') },
        ]);
      }
      case 'getMultipleAccounts': {
        const addresses = params[0] as string[];
        const config = params[1] as { encoding: string };
        if (config.encoding === 'base64') return rpc(addresses.map(() => ({ data: ['', 'base64'], executable: false, lamports: 1, owner: '11111111111111111111111111111111', space: 0 })));
        return rpc(addresses.map((address) => (mintSet.has(address) ? mintAccount : accountOwner.has(address) ? tokenAccount('11111111111111111111111111111111', accountOwner.get(address) as string, '1') : null)));
      }
      case 'getAssetBatch':
        return rpcRaw((params as unknown as { ids: string[] }).ids.map((id) => ({ id, mutable: false, content: { metadata: { name: 'Sim', symbol: 'SIM' } } })));
      case 'getTokenLargestAccounts': {
        const mint = params[0] as string;
        return rpc(Array.from({ length: 20 }, (_, index) => ({ address: holderAccount(mint, index), amount: '10000000000' })));
      }
      default:
        return json({}, 404);
    }
  };
  return { fetch: fetchFn, mints };
}

function simulatedService(options: ChainOptions, extra: Partial<SolanaDataOptions> = {}) {
  const owner = fixtureAddress('sim:wallet-owner');
  const chain = simulatedChain(owner, options);
  const logger = new CapturingLogger();
  const svc = new SolanaDataService({
    clock,
    logger,
    random: () => 0,
    heliusApiKey: KEY,
    config: testConfig,
    fetch: chain.fetch,
    ...extra,
  });
  return { svc, owner, mints: chain.mints, logger };
}

describe('coût mesuré (chaîne simulée, avec clé Helius)', () => {
  it('20 tokens à froid : 3 crédits (liste) + 37 crédits (verdicts) = 40 ; 3 crédits en cache', async () => {
    const budget = new LaneBudget();
    const { svc, owner } = simulatedService({ tokens: 20 }, { creditBudget: budget, cache: new MemoryCacheStore(clock) });
    const holdings = await svc.listWalletHoldings(owner);
    expect(holdings.summary).toMatchObject({ tokenCount: 20, analyzeCount: 20, rejectedAccountCount: 2, accountCount: 22 });
    // Tri : valeur décroissante (prix 1 → 20).
    expect(holdings.tokens[0]?.valueUsd).toBe(100);
    expect(holdings.credits).toBe(3);

    const toAnalyze = holdings.tokens.filter((token) => token.selection === 'analyze').map((token) => token.mint);
    const batch = await svc.collectFactsLightBatch(toAnalyze);
    expect(batch.entries.every((entry) => entry.status === 'ok' && !entry.collected.degraded)).toBe(true);
    // mints 1 + getAssetBatch 10 + top 20 × 20 + propriétaires 4 (400 comptes / 100) + programmes 4 (400 wallets / 100).
    expect(batch.credits).toBe(1 + 10 + 20 + 4 + 4);
    expect(budget.byLane).toEqual({ wallet: 3 + 39 });

    // Second scan du même wallet : liste seule (3), verdicts light en cache.
    const again = await svc.listWalletHoldings(owner);
    const cached = await svc.collectFactsLightBatch(toAnalyze);
    expect(again.credits + cached.credits).toBe(3);
  });

  it('nom hostile (bidi, invisibles) nettoyé', async () => {
    const { svc, owner } = simulatedService({ tokens: 1, hostileName: true });
    const holdings = await svc.listWalletHoldings(owner);
    expect(holdings.tokens[0]?.token.name).toBe('FakeUSDC');
  });

  it('DexScreener en panne : prix inconnus, aucune poussière déduite, verdicts quand même (liquidité indisponible)', async () => {
    const { svc, owner } = simulatedService({ tokens: 3, dexDown: true });
    const holdings = await svc.listWalletHoldings(owner);
    expect(holdings.pricesComplete).toBe(false);
    expect(holdings.tokens.every((token) => token.valueUsd === null && token.selection === 'analyze')).toBe(true);
    expect(holdings.summary.totalValueUsd).toBeNull();
    const batch = await svc.collectFactsLightBatch(holdings.tokens.map((token) => token.mint));
    const entry = batch.entries[0];
    expect(entry?.status === 'ok' && entry.collected.facts.liquidity).toBeNull();
  });

  it('budget de la voie wallet épuisé : liste via le RPC public, mints servis par le RPC public, holders sautés', async () => {
    const budget = new MemoryCreditBudget(22_000, clock, { wallet: 0 });
    const { svc, owner, logger } = simulatedService({ tokens: 2 }, { creditBudget: budget });
    const holdings = await svc.listWalletHoldings(owner);
    expect(holdings.accountsSource).toBe('solana_rpc');
    expect(holdings.credits).toBe(0);
    const batch = await svc.collectFactsLightBatch(holdings.tokens.map((token) => token.mint));
    expect(batch.budgetExhausted).toBe(true);
    const entry = batch.entries[0];
    if (entry?.status !== 'ok') throw new Error('attendu ok');
    expect(entry.collected.facts.holders).toBeNull();
    expect(entry.collected.facts.metadata).toBeNull();
    expect(entry.collected.degraded).toBe(true);
    expect(logger.lines.some((line) => line.includes('helius_budget_exhausted') && line.includes('wallet'))).toBe(true);
  });

  it('budget épuisé et RPC public en panne : unavailable budget', async () => {
    const budget = new MemoryCreditBudget(22_000, clock, { wallet: 3 });
    const { svc, owner } = simulatedService({ tokens: 2, failPublic: new Set(['getMultipleAccounts']) }, { creditBudget: budget });
    const holdings = await svc.listWalletHoldings(owner);
    const batch = await svc.collectFactsLightBatch(holdings.tokens.map((token) => token.mint));
    expect(batch.entries.map((entry) => entry.status === 'unavailable' && entry.reason)).toEqual(['budget', 'budget']);
  });

  it('sources en panne : unavailable upstream', async () => {
    const all = new Set(['getMultipleAccounts']);
    const { svc, mints } = simulatedService({ tokens: 2, failHelius: all, failPublic: all });
    const batch = await svc.collectFactsLightBatch(mints);
    expect(batch.entries.map((entry) => entry.status === 'unavailable' && entry.reason)).toEqual(['upstream', 'upstream']);
  });

  it('échéance dépassée : unavailable timeout', async () => {
    const { svc, mints } = simulatedService({ tokens: 2, delayMs: 60 });
    const batch = await svc.collectFactsLightBatch(mints, { deadlineMs: 20 });
    expect(batch.timedOut).toBe(true);
    expect(batch.entries.map((entry) => entry.status === 'unavailable' && entry.reason)).toEqual(['timeout', 'timeout']);
  });

  it('annulation par l’hôte (signal déjà annulé)', async () => {
    const { svc, mints } = simulatedService({ tokens: 1 });
    const controller = new AbortController();
    controller.abort();
    const batch = await svc.collectFactsLightBatch(mints, { signal: controller.signal });
    expect(batch.entries[0]).toEqual({ mint: mints[0], status: 'unavailable', reason: 'timeout' });
  });

  it('liste illisible : UpstreamError (le scan est refusé, quota remboursé par l’API)', async () => {
    const all = new Set(['getTokenAccountsByOwner']);
    const { svc, owner } = simulatedService({ tokens: 1, failHelius: all, failPublic: all });
    await expect(svc.listWalletHoldings(owner)).rejects.toBeInstanceOf(UpstreamError);
  });

  it('nature illisible : le scan continue', async () => {
    const all = new Set(['getAccountInfo']);
    const { svc, owner, logger } = simulatedService({ tokens: 1, failHelius: all, failPublic: all });
    const holdings = await svc.listWalletHoldings(owner);
    expect(holdings.tokens).toHaveLength(1);
    expect(logger.lines.some((line) => line.includes('wallet_nature_unavailable'))).toBe(true);
  });

  it('réponses de plus de 2 Mo : liste → WALLET_TOO_LARGE, nature → WALLET_INVALID, lot de mints coupé jusqu’au mint fautif', async () => {
    const owner = fixtureAddress('sim:wallet-owner');
    const chain = simulatedChain(owner, { tokens: 2 });
    const huge = (method: string, onlyFirst?: string) =>
      (async (url: string, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { method?: string; params?: unknown[] };
        const first = (payload.params?.[0] as string[] | undefined)?.[0];
        if (payload.method === method && (onlyFirst === undefined || (Array.isArray(payload.params?.[0]) && first === onlyFirst))) {
          return new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': '9000000' } });
        }
        return chain.fetch(url, init);
      }) as FetchLike;
    const make = (fetchFn: FetchLike) => new SolanaDataService({ clock, heliusApiKey: KEY, config: testConfig, fetch: fetchFn });

    await expect(make(huge('getTokenAccountsByOwner')).listWalletHoldings(owner)).rejects.toEqual(expect.objectContaining({ code: 'WALLET_TOO_LARGE', accountCount: null }));
    await expect(make(huge('getAccountInfo')).listWalletHoldings(owner)).rejects.toEqual(expect.objectContaining({ code: 'WALLET_INVALID', reason: 'oversized_account' }));
    const sorted = [...chain.mints].sort();
    const batch = await make(huge('getMultipleAccounts', sorted[0])).collectFactsLightBatch(chain.mints);
    const byMint = Object.fromEntries(batch.entries.map((entry) => [entry.mint, entry.status === 'unavailable' ? entry.reason : entry.status]));
    expect(byMint).toEqual({ [sorted[0] as string]: 'unanalyzable', [sorted[1] as string]: 'ok' });
  });

  it('clé Helius absente des journaux, des résultats et des erreurs du scan', async () => {
    const { svc, owner, logger } = simulatedService({ tokens: 2, failHelius: new Set(['getAccountInfo']) });
    const holdings = await svc.listWalletHoldings(owner);
    const batch = await svc.collectFactsLightBatch(holdings.tokens.map((token) => token.mint));
    const failing = new SolanaDataService({ heliusApiKey: KEY, config: testConfig, fetch: async (url) => Promise.reject(new TypeError(`fetch failed ${url}`)) });
    const error = (await failing.listWalletHoldings(owner).catch((e: unknown) => e)) as Error;
    const everything = [JSON.stringify(holdings), JSON.stringify(batch), ...logger.lines, error.message, String(error.stack), JSON.stringify(error)].join('\n');
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain('api-key');
    // Les journaux du scan ne citent ni l'adresse du wallet ni les mints.
    expect(logger.lines.join('\n')).not.toContain(owner);
  });
});

describe('budget mémoire : voie wallet plafonnée', () => {
  it('plafond propre, compté aussi dans le global', async () => {
    const budget = new MemoryCreditBudget(10, clock, { wallet: 4 });
    await expect(budget.tryConsume(4, 'wallet')).resolves.toBe(true);
    await expect(budget.tryConsume(1, 'wallet')).resolves.toBe(false);
    await expect(budget.tryConsume(6, 'interactive')).resolves.toBe(true);
    await expect(budget.tryConsume(1, 'interactive')).resolves.toBe(false);
  });

});
