import { watchSnapshotSchema, type VerdictSnapshot, type WatchEvent, type WatchSnapshot } from '@raijin/shared-contracts';
import { detectWatchEvents, evaluateRisk, mergeWatchSnapshot, type WatchObservation } from '@raijin/shared-risk-engine';
import { loadSolanaDataConfig, resolveSolanaDataConfig } from '../config';
import { MemoryCacheStore, MemoryCreditBudget } from '../core/memory';
import type { CacheStore, Clock, CreditLane, LogFields, SolanaLogger } from '../core/ports';
import { SolanaDataService, type SolanaDataOptions } from '../solana-data.service';
import {
  createFixtureFetch,
  createFixtureSequence,
  fixtureSequenceNames,
  loadAllFixtures,
  loadFixtureSequence,
  type Fixture,
} from '../testing/fixture-fetch';
import { poolReading, sanitizeDexId } from './watch-collector';

const W_LP = '3G8wFjRxfaPpi9t3CXrZY1JAd4CZFfZoPuZU1ggYif6i';
const POOL = '4FGEXFU34RFsd9PStZFAoezXMVHujobgZ8h6fdhTzQMx';
const POOL2 = '2ha8hWYYnGsUfJwMDjPJ92nKJzr6gvjveRUtZuYnLbPf';
const W_MINT = '6kA3B4uMv3vuePwmUcH5ca3xWtV3KnfHzBfzTtWziG83';
const W_HOLD = '7kyyXC5ZbjLDGucQA2ucEHb6wrq8fiWxDRCcf2HWzQu4';
const BIG = 'CsBNSmQKyspDfazEAWNTxVxbC4a1mf9damEWeGLQv59V';
const H1 = '4dmbSBLrLWApA5gSequ9BEjq5hfojCSLHku9pc1CDY6B';
const H2 = 'C6uxwopMh9D9gmWqFzL9rEXEns5vUckjP3JSmRuhtyXC';
const WSOL = 'So11111111111111111111111111111111111111112';
const TEST_KEY = 'test-helius-key-0000-SECRET-abcdef';
const T0 = Date.parse('2026-11-22T03:30:00.000Z');

const testConfig = {
  maxAttempts: 1,
  backoffBaseMs: 0,
  limits: {
    helius_rpc: { ratePerSecond: 1_000, maxQueue: 100 },
    helius_das: { ratePerSecond: 1_000, maxQueue: 100 },
    solana_rpc: { ratePerSecond: 1_000, maxQueue: 100 },
    dexscreener: { ratePerSecond: 1_000, maxQueue: 100 },
    geckoterminal: { ratePerSecond: 1_000, maxQueue: 100 },
    jupiter: { ratePerSecond: 1_000, maxQueue: 100 },
    rugcheck: { ratePerSecond: 1_000, maxQueue: 100 },
  },
};

class CapturingLogger implements SolanaLogger {
  readonly lines: string[] = [];
  debug(): void {
    /* appels amont : non vérifiés ici */
  }
  warn(event: string, fields: LogFields): void {
    this.lines.push(JSON.stringify({ event, ...fields }));
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

type Overrides = Parameters<typeof createFixtureFetch>[2];

/** Service sur un scénario en séquence (horloge avançant de 5 min par étape) ou sur des fixtures fixes. */
function setup(
  scenario: string | null,
  options: Partial<SolanaDataOptions> & { overrides?: Overrides; fixtures?: Fixture[]; config?: Record<string, unknown> } = {},
) {
  let now = T0;
  const clock: Clock = { now: () => now };
  const config = resolveSolanaDataConfig({ ...testConfig, ...options.config });
  const credits: Array<[number, CreditLane]> = [];
  const sequence = scenario === null ? null : createFixtureSequence(scenario, { config, overrides: options.overrides, base: options.fixtures ?? [] });
  const fixtureFetch = sequence ?? createFixtureFetch(options.fixtures ?? [], config, options.overrides);
  const logger = new CapturingLogger();
  const cache: CacheStore = options.cache ?? new MemoryCacheStore(clock);
  const svc = new SolanaDataService({
    clock,
    logger,
    random: () => 0,
    cache,
    heliusApiKey: options.heliusApiKey ?? null,
    creditBudget: options.creditBudget ?? { tryConsume: async (n, lane) => (credits.push([n, lane]), true) },
    config: { ...testConfig, ...options.config },
    fetch: fixtureFetch.fetch,
  });
  const next = () => {
    sequence?.advance();
    now += 5 * 60_000;
  };
  return { svc, calls: fixtureFetch.calls, urls: fixtureFetch.urls, credits, logger, next, sequence };
}

/** Rejoue une suite d'observations comme l'API : fusion puis détection. */
class WatchReplay {
  snapshot: WatchSnapshot | null = null;
  apply(observation: WatchObservation): WatchEvent[] {
    const next = mergeWatchSnapshot(this.snapshot, observation);
    watchSnapshotSchema.parse(next);
    const events = detectWatchEvents(this.snapshot, next);
    this.snapshot = next;
    return events;
  }
}

describe('fixtures en séquence', () => {
  it('scénarios disponibles, étapes ordonnées, exclues des fixtures de base', () => {
    expect(fixtureSequenceNames()).toEqual(['watch-holder-sold', 'watch-lp-removed', 'watch-mint-reactivated']);
    expect(loadFixtureSequence('watch-lp-removed')).toHaveLength(3);
    // Les lots `tokens/v1` des séquences ne sont pas dans les fixtures de base (celles du scan de wallet, si).
    expect(loadAllFixtures().some((fixture) => fixture.request.path === '/tokens/v1/solana/3G8wFjRxfaPpi9t3CXrZY1JAd4CZFfZoPuZU1ggYif6i')).toBe(false);
    expect(() => loadFixtureSequence('inconnu')).toThrow('Scénario de fixtures inconnu');
  });

  it('advance s’arrête à la dernière étape ; goTo valide l’étape', () => {
    const sequence = createFixtureSequence('watch-lp-removed');
    expect(sequence.steps).toBe(3);
    sequence.advance();
    sequence.advance();
    sequence.advance();
    expect(sequence.step).toBe(2);
    sequence.goTo(0);
    expect(sequence.step).toBe(0);
    expect(() => sequence.goTo(3)).toThrow(RangeError);
    expect(() => sequence.goTo(-1)).toThrow(RangeError);
  });
});

describe('collectAuthoritiesBatch (passe rapide, getMultipleAccounts jsonParsed)', () => {
  it('séquence « mint réactivé » : mint puis freeze de nouveau actifs, un événement à chaque étape', async () => {
    const { svc, calls, next } = setup('watch-mint-reactivated');
    const replay = new WatchReplay();
    const types: string[][] = [];
    for (let step = 0; step < 3; step += 1) {
      const [entry] = await svc.collectAuthoritiesBatch([W_MINT]);
      expect(entry?.status).toBe('ok');
      if (entry?.status !== 'ok') return;
      expect(entry).toMatchObject({ supply: '1000000000000', decimals: 6, tokenProgram: 'spl-token' });
      types.push(replay.apply({ mint: W_MINT, authorities: entry.authorities }).map((event) => event.type));
      next();
    }
    expect(types).toEqual([[], ['mint_reactivated'], ['freeze_reactivated']]);
    expect(calls).toEqual(Array(3).fill({ source: 'solana_rpc', route: 'getMultipleAccounts' }));
  });

  it('avec Helius : 1 crédit par lot, voie watch', async () => {
    const { svc, credits, calls } = setup('watch-mint-reactivated', { heliusApiKey: TEST_KEY });
    await svc.collectAuthoritiesBatch([W_MINT, W_MINT]);
    expect(calls).toEqual([{ source: 'helius_rpc', route: 'getMultipleAccounts' }]);
    expect(credits).toEqual([[1, 'watch']]);
  });

  it('réponse > 2 Mo : lot coupé en deux, mint fautif « non analysable », disjoncteur fermé (m1)', async () => {
    const overrides: Overrides = (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as { params: [string[]] };
      return payload.params[0].includes(BIG)
        ? new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '3000000' } })
        : undefined;
    };
    const { svc, calls, credits } = setup('watch-mint-reactivated', { heliusApiKey: TEST_KEY, overrides, config: { breakerThreshold: 1 } });
    const result = await svc.collectAuthoritiesBatch([W_MINT, BIG]);
    expect(result.map((entry) => [entry.mint, entry.status])).toEqual([
      [W_MINT, 'ok'],
      [BIG, 'unanalyzable'],
    ]);
    expect(calls).toHaveLength(3);
    expect(credits).toEqual([
      [1, 'watch'],
      [1, 'watch'],
      [1, 'watch'],
    ]);
    expect(svc.breakerStates()['helius_rpc']).toBe('closed');
  });

  it('mint absent ou pas un mint : not_found ; panne : unavailable (aucune erreur levée)', async () => {
    const notFound = setup(null, {
      overrides: () => json({ jsonrpc: '2.0', id: 1, result: { value: [null, { owner: '11111111111111111111111111111111', data: ['', 'base64'] }] } }),
    });
    expect((await notFound.svc.collectAuthoritiesBatch([W_MINT, BIG])).map((entry) => entry.status)).toEqual(['not_found', 'not_found']);

    const down = setup(null);
    const result = await down.svc.collectAuthoritiesBatch([W_MINT]);
    expect(result).toEqual([{ mint: W_MINT, status: 'unavailable', errorKind: 'network' }]);
    expect(down.logger.lines.join('\n')).toContain('watch_authorities_unavailable');

    const shortAnswer = setup(null, { overrides: () => json({ jsonrpc: '2.0', id: 1, result: { value: [] } }) });
    expect(await shortAnswer.svc.collectAuthoritiesBatch([W_MINT])).toEqual([{ mint: W_MINT, status: 'unavailable', errorKind: 'invalid_response' }]);
  });

  it('plus de 100 mints : lots de 100', async () => {
    const sizes: number[] = [];
    const { svc } = setup(null, {
      overrides: (_url, init) => {
        const payload = JSON.parse(String(init?.body)) as { params: [string[]] };
        sizes.push(payload.params[0].length);
        return json({ jsonrpc: '2.0', id: 1, result: { value: payload.params[0].map(() => null) } });
      },
    });
    const mints = Array.from({ length: 150 }, (_, index) => `${W_MINT.slice(0, 40)}${String(index).padStart(4, '0')}`);
    expect(await svc.collectAuthoritiesBatch(mints)).toHaveLength(150);
    expect(sizes).toEqual([100, 50]);
  });

  it('budget de la voie watch épuisé : RPC public, sans erreur', async () => {
    const budget = new MemoryCreditBudget(22_000, { now: () => T0 }, { watch: 0 });
    const { svc, calls, logger } = setup('watch-mint-reactivated', { heliusApiKey: TEST_KEY, creditBudget: budget });
    const [entry] = await svc.collectAuthoritiesBatch([W_MINT]);
    expect(entry?.status).toBe('ok');
    expect(calls.map((call) => call.source)).toEqual(['solana_rpc']);
    expect(logger.lines.join('\n')).toContain('"lane":"watch"');
    // La voie interactive n'est pas touchée.
    expect(await budget.tryConsume(1, 'interactive')).toBe(true);
  });
});

describe('collectPoolsBatch (DexScreener tokens/v1)', () => {
  it('séquence « LP retirée » : swap sans alerte, retrait de 75 % → lp_removed', async () => {
    const { svc, calls, next } = setup('watch-lp-removed');
    const replay = new WatchReplay();
    const events: WatchEvent[][] = [];
    for (let step = 0; step < 3; step += 1) {
      const [entry] = await svc.collectPoolsBatch([W_LP], { [W_LP]: replay.snapshot?.pool?.address });
      expect(entry?.pool).not.toBeNull();
      events.push(replay.apply({ mint: W_LP, pool: entry?.pool ?? null }));
      next();
    }
    expect(replay.snapshot?.pool).toMatchObject({ address: POOL, dex: 'raydium', base: 200_000, quote: 156.25 });
    expect(events[0]).toEqual([]);
    expect(events[1]).toEqual([]);
    expect(events[2]).toEqual([
      expect.objectContaining({
        type: 'lp_removed',
        severity: 'danger',
        payload: expect.objectContaining({ poolAddress: POOL, dropPct: 75, liquidityUsdBefore: 150_000, liquidityUsdAfter: 37_500 }),
        dedupeKey: `lp_removed:${POOL}:2026-11-22T03:35:00.000Z`,
      }),
    ]);
    // Le pool suivi est le principal : aucune relecture par adresse.
    expect(calls.every((call) => call.route.startsWith('/tokens/v1/solana/'))).toBe(true);
  });

  const pair = (address: string, mint: string, liquidity: Record<string, number> | null, dexId = 'raydium', asQuote = false) => ({
    chainId: 'solana',
    dexId,
    pairAddress: address,
    baseToken: { address: asQuote ? WSOL : mint },
    quoteToken: { address: asQuote ? mint : WSOL },
    liquidity,
  });

  it('pool suivi qui n’est plus le principal : relu par adresse (latest/dex/pairs)', async () => {
    const { svc, calls } = setup(null, {
      overrides: (url) => {
        if (url.includes('/tokens/v1/')) return json([pair(POOL2, W_LP, { usd: 900_000, base: 4e6, quote: 3e3 }, 'orca')]);
        if (url.includes('/latest/dex/pairs/')) return json({ pairs: [pair(POOL, W_LP, { usd: 1_000, base: 1e4, quote: 5 })] });
        return undefined;
      },
    });
    const [entry] = await svc.collectPoolsBatch([W_LP], { [W_LP]: POOL });
    expect(entry?.pool?.main).toMatchObject({ address: POOL2, dex: 'orca' });
    expect(entry?.pool?.tracked).toMatchObject({ address: POOL, sqrtK: Math.sqrt(5e4) });
    expect(calls.map((call) => call.route)).toEqual([`/tokens/v1/solana/${W_LP}`, `/latest/dex/pairs/solana/${POOL}`]);
  });

  it('pool suivi introuvable : tracked null ; relecture en panne : pool indisponible', async () => {
    const gone = setup(null, {
      overrides: (url) => (url.includes('/tokens/v1/') ? json([]) : url.includes('/latest/') ? json({ pairs: null }) : undefined),
    });
    expect(await gone.svc.collectPoolsBatch([W_LP], { [W_LP]: POOL })).toEqual([{ mint: W_LP, pool: { main: null, tracked: null } }]);

    const failing = setup(null, { overrides: (url) => (url.includes('/tokens/v1/') ? json([]) : url.includes('/latest/') ? json({}, 500) : undefined) });
    expect(await failing.svc.collectPoolsBatch([W_LP], { [W_LP]: POOL })).toEqual([{ mint: W_LP, pool: null }]);
    expect(failing.logger.lines.join('\n')).toContain('watch_tracked_pools_unavailable');
  });

  it('DexScreener en panne : pool null pour tout le lot ; adresse suivie invalide ignorée', async () => {
    const { svc, logger, calls } = setup(null, { overrides: (url) => (url.includes('/tokens/v1/') ? json({}, 503) : undefined) });
    expect(await svc.collectPoolsBatch([W_LP, W_MINT], { [W_LP]: 'pas-une-adresse' })).toEqual([
      { mint: W_LP, pool: null },
      { mint: W_MINT, pool: null },
    ]);
    expect(logger.lines.join('\n')).toContain('watch_pools_unavailable');
    expect(calls).toHaveLength(1);
  });

  it('réponses 404 et invalides', async () => {
    const notFound = setup(null, { overrides: () => json({}, 404) });
    expect(await notFound.svc.collectPoolsBatch([W_LP], { [W_LP]: POOL })).toEqual([{ mint: W_LP, pool: { main: null, tracked: null } }]);
    const invalid = setup(null, { overrides: () => json({ unexpected: true }) });
    expect(await invalid.svc.collectPoolsBatch([W_LP])).toEqual([{ mint: W_LP, pool: null }]);
    const invalidPairs = setup(null, { overrides: (url) => (url.includes('/tokens/v1/') ? json([]) : json('x')) });
    expect(await invalidPairs.svc.collectPoolsBatch([W_LP], { [W_LP]: POOL })).toEqual([{ mint: W_LP, pool: null }]);
  });

  it('plus de 30 mints : lots de 30 ; pool principal = plus forte liquidité USD', async () => {
    const paths: string[] = [];
    const mints = Array.from({ length: 31 }, (_, index) => (index === 0 ? W_LP : `${W_MINT.slice(0, 40)}${String(index).padStart(4, '0')}`));
    const { svc } = setup(null, {
      overrides: (url) => {
        paths.push(url);
        return json([pair(POOL, W_LP, { usd: 10, base: 1, quote: 1 }), pair(POOL2, W_LP, { usd: 20, base: 4, quote: 4 }, 'orca')]);
      },
    });
    const result = await svc.collectPoolsBatch(mints);
    expect(paths).toHaveLength(2);
    expect(result[0]?.pool?.main?.address).toBe(POOL2);
    expect(result[1]?.pool).toEqual({ main: null });
  });

  it('lecture orientée (token en quote), réserves absentes ignorées, identifiant de DEX nettoyé', () => {
    const observedAt = new Date(T0).toISOString();
    const asQuote = pair(POOL, W_LP, { usd: 100, base: 2, quote: 50 }, 'Raydium CLMM!', true);
    expect(poolReading(asQuote as never, W_LP, observedAt)).toMatchObject({ base: 50, quote: 2, sqrtK: 10, dex: 'raydium-clmm-', liquidityUsd: 100 });
    expect(poolReading(pair(POOL, W_LP, null) as never, W_LP, observedAt)).toBeNull();
    expect(poolReading(pair(POOL, W_LP, { usd: -1, base: 1, quote: 1 }) as never, W_LP, observedAt)?.liquidityUsd).toBeNull();
    expect(poolReading(pair(POOL, H1, { base: 1, quote: 1 }) as never, W_LP, observedAt)).toBeNull();
    expect(poolReading(pair(POOL, W_LP, { base: Number.MAX_VALUE, quote: Number.MAX_VALUE }) as never, W_LP, observedAt)).toBeNull();
    expect(sanitizeDexId('')).toBe('unknown');
  });

  it('lot vide ou trop grand pour le client : refusé', async () => {
    const { svc } = setup(null);
    const dexscreener = (svc as unknown as { dexscreener: { getTokensPairs: (m: string[]) => Promise<unknown> } }).dexscreener;
    await expect(dexscreener.getTokensPairs([])).rejects.toThrow(RangeError);
    await expect(dexscreener.getTokensPairs(Array(31).fill(W_LP))).rejects.toThrow(RangeError);
    expect(await svc.collectPoolsBatch([])).toEqual([]);
  });
});

describe('collectHolders (top 20, exclusions de la concentration)', () => {
  it('séquence « holder vendeur » : coffre et compte AMM exclus, propriétaires en cache, holder_sold', async () => {
    const { svc, calls, credits, next } = setup('watch-holder-sold', { heliusApiKey: TEST_KEY });
    const replay = new WatchReplay();
    const first = await svc.collectHolders(W_HOLD, { supply: '1000000000' });
    expect(first?.top.map((entry) => [entry.owner, entry.pct])).toEqual([
      [H1, 10],
      [H2, 6],
    ]);
    expect(replay.apply({ mint: W_HOLD, holders: first })).toEqual([]);
    expect(credits).toEqual([
      [1, 'watch'],
      [1, 'watch'],
      [1, 'watch'],
    ]);

    next();
    const second = await svc.collectHolders(W_HOLD, { supply: '1000000000' });
    const events = replay.apply({ mint: W_HOLD, holders: second });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'holder_sold',
        severity: 'warn',
        payload: { owner: H1, beforePct: 10, afterPct: 6, soldPctOfPosition: 40 },
        dedupeKey: `holder_sold:${H1}:2026-11-22T03:30:00.000Z`,
      }),
    ]);
    // 2e passe : seul getTokenLargestAccounts (propriétaires et programmes en cache 24 h).
    expect(calls.map((call) => call.route)).toEqual(['getTokenLargestAccounts', 'getMultipleAccounts', 'getMultipleAccounts', 'getTokenLargestAccounts']);
    expect(credits).toHaveLength(4);
  });

  it('adresses exclues en plus (pool suivi) ; offre lue sur le mint si absente', async () => {
    const mintAccount = loadFixtureSequence('watch-mint-reactivated')[0]?.find((fixture) => fixture.request.rpcMethod === 'getAccountInfo') as Fixture;
    const asHoldMint: Fixture = {
      ...mintAccount,
      source: 'helius',
      request: { ...mintAccount.request, params: [W_HOLD, { encoding: 'jsonParsed', commitment: 'confirmed' }] },
    };
    const { svc } = setup('watch-holder-sold', { heliusApiKey: TEST_KEY, fixtures: [asHoldMint] });
    const result = await svc.collectHolders(W_HOLD, { excludeAddresses: [H2] });
    expect(result?.supply).toBe('1000000000000');
    expect(result?.top.map((entry) => entry.owner)).toEqual([H1]);
  });

  it('sans clé Helius : null sans aucun appel ; panne ou mint introuvable : null', async () => {
    const noKey = setup('watch-holder-sold');
    expect(await noKey.svc.collectHolders(W_HOLD, { supply: '1' })).toBeNull();
    expect(noKey.calls).toEqual([]);

    const down = setup(null, { heliusApiKey: TEST_KEY });
    expect(await down.svc.collectHolders(W_HOLD, { supply: '1000' })).toBeNull();
    expect(down.logger.lines.join('\n')).toContain('watch_holders_unavailable');

    const missing = setup(null, { heliusApiKey: TEST_KEY, overrides: () => json({ jsonrpc: '2.0', id: 1, result: { value: null } }) });
    expect(await missing.svc.collectHolders(W_HOLD)).toBeNull();
  });

  it('offre nulle : top vide ; offre invalide : null', async () => {
    const { svc, calls } = setup('watch-holder-sold', { heliusApiKey: TEST_KEY });
    expect(await svc.collectHolders(W_HOLD, { supply: '0' })).toEqual({ supply: '0', top: [], observedAt: '2026-11-22T03:30:00.000Z' });
    expect(await svc.collectHolders(W_HOLD, { supply: '-1' })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('cache illisible ou en panne : relu sur la chaîne, sans erreur', async () => {
    const broken: CacheStore = {
      get: async (key) => (key.includes('token-owner') ? '{invalide' : JSON.stringify(42)),
      set: async () => {
        throw new Error('redis down');
      },
    };
    const { svc, logger } = setup('watch-holder-sold', { heliusApiKey: TEST_KEY, cache: broken });
    const result = await svc.collectHolders(W_HOLD, { supply: '1000000000' });
    expect(result?.top).toHaveLength(2);
    expect(logger.lines.join('\n')).toContain('solana_cache_read_failed');
    expect(logger.lines.join('\n')).toContain('solana_cache_write_failed');
  });

  it('programme en cache vide (compte inexistant) ou propriétaire inconnu', async () => {
    const cache = new MemoryCacheStore({ now: () => T0 });
    await cache.set(`solana:account-program:${H1}`, JSON.stringify(''), 60);
    const { svc } = setup('watch-holder-sold', {
      heliusApiKey: TEST_KEY,
      cache,
      overrides: (_url, init) => {
        const payload = JSON.parse(String(init?.body)) as { method: string; params: [string[], { encoding: string }] };
        if (payload.method === 'getMultipleAccounts' && payload.params[1].encoding === 'jsonParsed') {
          return json({ jsonrpc: '2.0', id: 1, result: { value: payload.params[0].map(() => null) } });
        }
        if (payload.method === 'getMultipleAccounts') {
          return json({ jsonrpc: '2.0', id: 1, result: { value: payload.params[0].map(() => null) } });
        }
        return undefined;
      },
    });
    const result = await svc.collectHolders(W_HOLD, { supply: '1000000000' });
    // Propriétaires inconnus : clé = compte de token (4 comptes, aucun exclu).
    expect(result?.top).toHaveLength(4);
  });
});

describe('passe complète des suivis (collectFacts, voie watch) → verdict dégradé', () => {
  it('séquence « mint réactivé » : Prudence puis Danger', async () => {
    const { svc, credits, next } = setup('watch-mint-reactivated', { heliusApiKey: TEST_KEY, config: { maxSignaturePages: 1 } });
    const replay = new WatchReplay();
    const verdicts: string[] = [];
    const events: WatchEvent[][] = [];
    for (let step = 0; step < 2; step += 1) {
      const collected = await svc.collectFacts(W_MINT, { profile: 'full', lane: 'watch' });
      const assessment = evaluateRisk(collected.facts);
      verdicts.push(assessment.verdict);
      const verdict: VerdictSnapshot = {
        verdict: assessment.verdict,
        engineVersion: assessment.engineVersion,
        analysisId: null,
        reasonCodes: assessment.reasons.map((reason) => reason.code),
        observedAt: collected.facts.observedAt,
      };
      events.push(replay.apply({ mint: W_MINT, verdict }));
      next();
    }
    expect(verdicts).toEqual(['warn', 'danger']);
    expect(events[1]?.map((event) => [event.type, event.severity])).toEqual([['verdict_degraded', 'danger']]);
    expect(credits.length).toBeGreaterThan(0);
    expect(credits.every(([, lane]) => lane === 'watch')).toBe(true);
  });

  it('analyse à la demande : voie interactive', async () => {
    const { svc, credits } = setup('watch-mint-reactivated', { heliusApiKey: TEST_KEY, config: { maxSignaturePages: 1 } });
    await svc.collectFacts(W_MINT);
    expect(credits.every(([, lane]) => lane === 'interactive')).toBe(true);
  });
});

describe('budget Helius par tentative (m2) et par voie', () => {
  it('rejeu après une erreur 503 : 1 crédit par tentative', async () => {
    let attempts = 0;
    const { svc, credits } = setup('watch-mint-reactivated', {
      heliusApiKey: TEST_KEY,
      config: { maxAttempts: 2 },
      overrides: (url) => {
        if (!url.includes('helius-rpc')) return undefined;
        attempts += 1;
        return attempts === 1 ? json({}, 503) : undefined;
      },
    });
    const [entry] = await svc.collectAuthoritiesBatch([W_MINT]);
    expect(entry?.status).toBe('ok');
    expect(credits).toEqual([
      [1, 'watch'],
      [1, 'watch'],
    ]);
  });

  it('MemoryCreditBudget : plafond global et plafond de voie, remis à zéro chaque jour UTC', async () => {
    let now = T0;
    const budget = new MemoryCreditBudget(10, { now: () => now }, { watch: 4 });
    expect(await budget.tryConsume(3, 'watch')).toBe(true);
    expect(await budget.tryConsume(2, 'watch')).toBe(false);
    expect(await budget.tryConsume(7, 'interactive')).toBe(true);
    expect(await budget.tryConsume(1, 'watch')).toBe(false);
    expect(await budget.tryConsume(1)).toBe(false);
    now += 86_400_000;
    expect(await budget.tryConsume(4, 'watch')).toBe(true);
  });

  it('WATCH_DAILY_CREDIT_BUDGET lu dans l’environnement (défaut 12 000)', () => {
    expect(loadSolanaDataConfig({}).config.watchDailyCreditBudget).toBe(12_000);
    expect(loadSolanaDataConfig({ WATCH_DAILY_CREDIT_BUDGET: '5000' }).config.watchDailyCreditBudget).toBe(5_000);
    expect(() => loadSolanaDataConfig({ WATCH_DAILY_CREDIT_BUDGET: '-1' })).toThrow('WATCH_DAILY_CREDIT_BUDGET');
  });
});
