import { ANALYSIS_CHECK_IDS, riskFactsSchema } from '@raijin/shared-contracts';
import { evaluateRisk } from '@raijin/shared-risk-engine';
import { resolveSolanaDataConfig } from '../config';
import { TokenNotFoundError, TokenUnanalyzableError, UpstreamError } from '../core/errors';
import { MemoryCacheStore } from '../core/memory';
import type { CacheStore, Clock, LogFields, SolanaLogger } from '../core/ports';
import { SolanaDataService, type SolanaDataOptions } from '../solana-data.service';
import { createFixtureFetch, loadAllFixtures, type Fixture } from '../testing/fixture-fetch';

const MINTS = {
  bonk: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  pyusd: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
  freshPump: '9rA3rJrcFJeQwWaLaHgJLi4LaF6wvRoae9ybwcYApump',
  mintActive: 'BL7yQWfMeLesszudGL6TqnfWbieFMDTT1TFXzQWBazTi',
  honeypot: '3Ss6A75uZG9cSRt4feyhcmJVGT38USeygDfwi1tBGQVa',
  missing: 'Y3Pg4fGfK1jz4exHgF2duMUhZvjAa1FdBuJYMsyZfWD',
  transferFee: 'dTREtmKNeJQVoQ5vz1wUXHNYfZ1y9KQjXcB8FF53LR4',
  lpRemoved: 'cnUfXtVipDb1Kg1R6XM4Unk5tEwoZAinRPUfuPh1vSw',
};

/** Horloge figée à l'heure des enregistrements (22/11/2026 03:30 UTC). */
const NOW = Date.parse('2026-11-22T03:30:00.000Z');
const clock: Clock = { now: () => NOW };
const TEST_KEY = 'test-helius-key-0000-SECRET-abcdef';

/** Configuration de test : débits élevés (aucune attente), rejeux immédiats. */
const testConfig = {
  maxAttempts: 1,
  backoffBaseMs: 0,
  signaturePageLimit: 1_000,
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
  debug(event: string, fields: LogFields): void {
    this.lines.push(JSON.stringify({ event, ...fields }));
  }
  warn(event: string, fields: LogFields): void {
    this.lines.push(JSON.stringify({ event, ...fields }));
  }
}

function service(
  options: Partial<SolanaDataOptions> & { fixtures?: Fixture[]; signaturePageLimit?: number; overrides?: Parameters<typeof createFixtureFetch>[2] } = {},
) {
  const config = resolveSolanaDataConfig({ ...testConfig, signaturePageLimit: options.signaturePageLimit ?? 1_000, ...options.config });
  const fixtureFetch = createFixtureFetch(options.fixtures ?? loadAllFixtures(), config, options.overrides);
  const logger = new CapturingLogger();
  const svc = new SolanaDataService({
    clock,
    logger,
    random: () => 0,
    cache: options.cache ?? new MemoryCacheStore(clock),
    heliusApiKey: options.heliusApiKey ?? null,
    ...options,
    config: { ...testConfig, signaturePageLimit: options.signaturePageLimit ?? 1_000, ...options.config },
    fetch: fixtureFetch.fetch,
  });
  return { svc, ...fixtureFetch, logger };
}

describe('collectFacts : tokens réels enregistrés (sans clé Helius)', () => {
  it('BONK, token établi : autorités révoquées, liquidité médiane, devis de vente, rapport RugCheck résumé', async () => {
    const { svc, calls } = service({ signaturePageLimit: 100, config: { maxSignaturePages: 1 } });
    const result = await svc.collectFacts(MINTS.bonk);
    const { facts } = result;

    expect(riskFactsSchema.parse(facts)).toEqual(facts);
    expect(facts.observedAt).toBe('2026-11-22T03:30:00.000Z');
    expect(facts.mintAccount).toEqual({
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
      tokenProgram: 'spl-token',
      extensions: { transferFeeBps: null, permanentDelegate: false, transferHook: false, nonTransferable: false },
    });
    expect(facts.liquidity?.samples.map((s) => s.source)).toEqual(['dexscreener', 'geckoterminal']);
    expect(facts.liquidity?.usd).toBeGreaterThan(100_000);
    // Rapport complet > 2 Mo : repli sur le résumé (LP, score, risques ; pas de créateur).
    expect(facts.liquidity?.lpBurnedOrLockedPct).toBeCloseTo(22.48, 1);
    expect(facts.liquidity?.lpRemoved).toBe(false);
    expect(facts.rugcheck).toEqual({ scoreNormalised: 7, rugged: null, risks: [{ name: 'Mutable metadata', level: 'warn' }] });
    expect(facts.creator).toBeNull();
    // Token SPL classique sans DAS (pas de clé) et rapport RugCheck résumé : métadonnées indisponibles.
    expect(facts.metadata).toBeNull();
    expect(result.checkSources.metadata_mutable[0]?.id).toBe('rugcheck');
    expect(facts.sellSimulation?.routeFound).toBe(true);
    expect(facts.sellSimulation?.testAmountUsd).toBe(100);
    expect(facts.sellSimulation?.priceImpactPct).toBeCloseTo(0.0818, 3);
    expect(facts.sellSimulation?.implicitTaxPct).toBeLessThan(3);
    // Historique de signatures plein : date de création inconnue, âge du pool connu (2022).
    expect(facts.age?.tokenCreatedAt).toBeNull();
    expect(facts.age?.poolCreatedAt?.startsWith('2022-12')).toBe(true);
    // RPC public : getTokenLargestAccounts → 429 enregistré ; pas de repli RugCheck (résumé seulement).
    expect(facts.holders).toBeNull();
    expect(result.degraded).toBe(true);
    expect(result.token).toMatchObject({ mint: MINTS.bonk, name: 'Bonk', symbol: 'Bonk', decimals: 5, untrusted: true });
    expect(result.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'solana_rpc', status: 'error', errorKind: 'rate_limited' }),
        expect.objectContaining({ id: 'dexscreener', status: 'ok' }),
        expect.objectContaining({ id: 'jupiter', status: 'ok' }),
        expect.objectContaining({ id: 'helius', status: 'skipped' }),
      ]),
    );
    expect(calls.filter((c) => c.source === 'rugcheck').map((c) => c.route)).toEqual([
      `/tokens/${MINTS.bonk}/report`,
      `/tokens/${MINTS.bonk}/report/summary`,
    ]);
    expect(Object.keys(result.checkSources)).toEqual([...ANALYSIS_CHECK_IDS]);
    expect(result.checkSources.mint_authority).toEqual([{ id: 'solana_rpc', name: 'RPC Solana public', url: `https://explorer.solana.com/address/${MINTS.bonk}` }]);
    expect(result.checkSources.liquidity.map((s) => s.id)).toEqual(['dexscreener', 'geckoterminal', 'rugcheck']);
    // 3 contrôles indisponibles sans clé Helius (concentration, métadonnées, créateur) : jamais Sain (D2).
    const assessment = evaluateRisk(facts);
    expect(assessment.verdict).toBe('warn');
    expect(assessment.reasons.filter((r) => r.status === 'warn').map((r) => r.code)).toEqual(['RUGCHECK_WARN']);
  });

  it('USDC : émetteur connu (mint et freeze actifs), vente vers SOL sans taxe calculée', async () => {
    const { svc } = service({ signaturePageLimit: 100, config: { maxSignaturePages: 1 } });
    const { facts } = await svc.collectFacts(MINTS.usdc);
    expect(facts.mintAccount).toMatchObject({ mintAuthorityActive: true, freezeAuthorityActive: true });
    expect(facts.sellSimulation).toMatchObject({ routeFound: true, implicitTaxPct: null });
    expect(evaluateRisk(facts).checks.find((c) => c.id === 'freeze_authority')?.reasonCodes).toEqual(['FREEZE_AUTHORITY_KNOWN_ISSUER']);
  });

  it('PYUSD : Token-2022 (délégué permanent, frais 0 bps, hook sans programme), métadonnées embarquées', async () => {
    const { svc } = service({ signaturePageLimit: 100, config: { maxSignaturePages: 1 } });
    const result = await svc.collectFacts(MINTS.pyusd);
    expect(result.facts.mintAccount).toEqual({
      mintAuthorityActive: true,
      freezeAuthorityActive: true,
      tokenProgram: 'token-2022',
      extensions: { transferFeeBps: 0, permanentDelegate: true, transferHook: false, nonTransferable: false },
    });
    expect(result.facts.metadata).toEqual({ mutable: true });
    expect(result.checkSources.metadata_mutable[0]?.id).toBe('solana_rpc');
    expect(result.token).toMatchObject({ name: 'PayPal USD', symbol: 'PYUSD', tokenProgram: 'token-2022' });
    expect(evaluateRisk(result.facts).verdict).toBe('warn');
  });

  it('token à mint actif sans marché : Danger (mint actif, aucune route)', async () => {
    const { svc } = service();
    const { facts } = await svc.collectFacts(MINTS.mintActive);
    expect(facts.mintAccount?.mintAuthorityActive).toBe(true);
    expect(facts.sellSimulation).toEqual({ routeFound: false, priceImpactPct: null, implicitTaxPct: null, testAmountUsd: 0 });
    expect(facts.liquidity?.usd).toBe(0);
    expect(facts.age?.tokenCreatedAt).toBe(new Date(1795317477 * 1000).toISOString());
    const assessment = evaluateRisk(facts);
    expect(assessment.verdict).toBe('danger');
    expect(assessment.reasons.filter((r) => r.critical).map((r) => r.code)).toEqual(['MINT_AUTHORITY_ACTIVE', 'SELL_NO_ROUTE']);
  });

  it('honeypot : freeze actif et « token non échangeable » chez Jupiter', async () => {
    const { svc } = service();
    const { facts } = await svc.collectFacts(MINTS.honeypot);
    expect(facts.mintAccount?.freezeAuthorityActive).toBe(true);
    expect(facts.sellSimulation?.routeFound).toBe(false);
    expect(evaluateRisk(facts).verdict).toBe('danger');
  });

  it('mint inexistant : TokenNotFoundError, aucune autre source attendue', async () => {
    const { svc, calls } = service();
    await expect(svc.collectFacts(MINTS.missing)).rejects.toBeInstanceOf(TokenNotFoundError);
    expect(calls).toEqual([{ source: 'solana_rpc', route: 'getAccountInfo' }]);
  });

  it('mint inexistant avec clé Helius : 1 seul crédit, aucun appel DAS ni tiers', async () => {
    const credits: number[] = [];
    const { svc, calls } = service({
      heliusApiKey: TEST_KEY,
      creditBudget: { tryConsume: async (n: number) => (credits.push(n), true) },
    });
    await expect(svc.collectFacts(MINTS.missing)).rejects.toBeInstanceOf(TokenNotFoundError);
    expect(calls).toEqual([{ source: 'helius_rpc', route: 'getAccountInfo' }]);
    expect(credits).toEqual([1]);
  });

  it('compte qui n’est pas un mint (programme système) : TokenNotFoundError', async () => {
    const notMint: Fixture = {
      recordedAt: '2026-11-22T03:30:00.000Z',
      source: 'solana-rpc',
      request: { method: 'POST', rpcMethod: 'getAccountInfo', params: [MINTS.missing, { encoding: 'jsonParsed', commitment: 'confirmed' }] },
      status: 200,
      body: { jsonrpc: '2.0', id: 1, result: { value: { owner: '11111111111111111111111111111111', data: ['', 'base64'] } } },
    };
    const { svc } = service({ fixtures: [notMint] });
    await expect(svc.collectFacts(MINTS.missing)).rejects.toBeInstanceOf(TokenNotFoundError);
  });
});

describe('collectFacts : avec clé Helius (fixtures construites d’après la doc)', () => {
  it('token pump.fun récent : DAS, holders hors courbe de liaison, créateur lanceur en série, nom nettoyé', async () => {
    const { svc, calls } = service({ heliusApiKey: TEST_KEY });
    const result = await svc.collectFacts(MINTS.freshPump);
    const { facts } = result;
    expect(facts.metadata).toEqual({ mutable: false });
    expect(result.token.name).toBe('Bearmas <script>alert(1)</script>');
    expect(result.token.symbol).toBe('Bearmas');
    expect(facts.holders).toEqual({ top10Pct: 0.0208, maxSingleHolderPct: 0.0208, excludedAccounts: 1 });
    expect(result.checkSources.holder_concentration[0]?.id).toBe('helius');
    expect(facts.creator).toEqual({ address: 'HbPR3bpDR8WxsqgBu6QUAZcEXhUJrdChvBt7UWyz8M82', tokensLaunched: 5, tokensDeadOrRugged: expect.any(Number) });
    expect(facts.age?.tokenCreatedAt).toBe(new Date(1795316904 * 1000).toISOString());
    // Jupiter ne route pas la courbe de liaison pump.fun : contrôle indisponible, pas un faux honeypot.
    expect(facts.sellSimulation).toBeNull();
    expect(facts.liquidity?.lpBurnedOrLockedPct).toBe(100);
    expect(facts.rugcheck?.risks.map((r) => r.level)[0]).toBe('danger');
    expect(calls.some((c) => c.source === 'helius_das' && c.route === 'getAsset')).toBe(true);
    const assessment = evaluateRisk(facts);
    expect(assessment.verdict).toBe('warn');
    expect(assessment.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(['TOKEN_VERY_NEW', 'POOL_VERY_NEW', 'LIQUIDITY_LOW', 'RUGCHECK_DANGER']));
  });

  it('Helius en échec : bascule sur le RPC public (servi par solana_rpc)', async () => {
    const { svc, logger } = service({
      heliusApiKey: TEST_KEY,
      signaturePageLimit: 100,
      config: { maxSignaturePages: 1 },
      overrides: (url) => (url.includes('helius') ? new Response('', { status: 503 }) : undefined),
    });
    const result = await svc.collectFacts(MINTS.bonk);
    expect(result.facts.mintAccount).not.toBeNull();
    expect(result.checkSources.mint_authority[0]?.id).toBe('solana_rpc');
    expect(logger.lines.some((line) => line.includes('helius_fallback_public_rpc'))).toBe(true);
  });

  it('budget Helius épuisé : RPC public, DAS indisponible (repli RugCheck/Token-2022)', async () => {
    const { svc, calls } = service({
      heliusApiKey: TEST_KEY,
      creditBudget: { tryConsume: async () => false },
    });
    const result = await svc.collectFacts(MINTS.freshPump);
    expect(calls.some((c) => c.source.startsWith('helius'))).toBe(false);
    expect(result.facts.metadata).toEqual({ mutable: false });
    expect(result.sources).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'helius', status: 'error', errorKind: 'budget_exhausted' })]));
    // Repli concentration : top holders RugCheck (le RPC public refuse getTokenLargestAccounts).
    expect(result.facts.holders?.excludedAccounts).toBe(1);
    expect(result.checkSources.holder_concentration[0]?.id).toBe('rugcheck');
  });
});

describe('collectFacts : scénarios synthétiques', () => {
  it('LP retirée : pool listé mais vidé → critique', async () => {
    const { svc } = service();
    const { facts } = await svc.collectFacts(MINTS.lpRemoved);
    expect(facts.liquidity).toMatchObject({ usd: 12.4, lpRemoved: true });
    expect(facts.sellSimulation).toBeNull();
    expect(evaluateRisk(facts).reasons.find((r) => r.critical)?.code).toBe('LIQUIDITY_REMOVED');
  });

  it('Token-2022 à frais de transfert : barème le plus élevé retenu (5 %)', async () => {
    const { svc } = service();
    const result = await svc.collectFacts(MINTS.transferFee);
    expect(result.facts.mintAccount?.extensions.transferFeeBps).toBe(500);
    expect(result.token.symbol).toBe('TAX');
    expect(evaluateRisk(result.facts).checks.find((c) => c.id === 'sell_simulation')?.reasonCodes).toContain('TOKEN2022_TRANSFER_FEE');
  });

  it('toutes les sources secondaires en panne : faits partiels, jamais d’exception', async () => {
    const fixtures = loadAllFixtures().filter((f) => f.source === 'solana-rpc' && f.request.rpcMethod === 'getAccountInfo');
    const { svc } = service({ fixtures });
    const result = await svc.collectFacts(MINTS.bonk);
    expect(result.facts.mintAccount).not.toBeNull();
    expect(result.facts.liquidity).toBeNull();
    expect(result.facts.sellSimulation).toBeNull();
    expect(result.facts.age).toBeNull();
    expect(result.degraded).toBe(true);
    expect(result.sources.every((s) => s.status !== 'ok' || s.id === 'solana_rpc')).toBe(true);
  });

  it('RPC en panne (réseau) : UpstreamError immédiate, aucun autre appel facturé', async () => {
    const fixtures = loadAllFixtures().filter((f) => f.source !== 'solana-rpc');
    const { svc, calls } = service({ fixtures, signaturePageLimit: 100 });
    const error = await svc.collectFacts(MINTS.bonk).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ source: 'solana_rpc', kind: 'network' });
    expect(calls).toEqual([{ source: 'solana_rpc', route: 'getAccountInfo' }]);
  });

  it('compte de plus de 2 Mo (Token-2022 volumineux, file d’événements…) : TokenUnanalyzable, un seul appel même avec Helius', async () => {
    const credits: number[] = [];
    const { svc, calls } = service({
      heliusApiKey: TEST_KEY,
      creditBudget: { tryConsume: async (n: number) => (credits.push(n), true) },
      overrides: (url) =>
        url.includes('helius-rpc')
          ? new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '3000000' } })
          : undefined,
    });
    const error = await svc.collectFacts(MINTS.bonk).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TokenUnanalyzableError);
    expect(error).toMatchObject({ code: 'TOKEN_UNANALYZABLE' });
    expect(calls).toEqual([{ source: 'helius_rpc', route: 'getAccountInfo' }]);
    expect(credits).toEqual([1]);
    // m1 : une réponse trop volumineuse n'est pas une panne du fournisseur.
    expect(svc.breakerStates()['helius_rpc']).toBe('closed');
  });

  it('autre erreur inattendue du RPC : réemballée en UpstreamError', async () => {
    const { svc } = service();
    const rpc = (svc as unknown as { collector: { deps: { rpc: { getMint: () => Promise<never> } } } }).collector.deps.rpc;
    rpc.getMint = () => Promise.reject(new Error('https://secret'));
    await expect(svc.collectFacts(MINTS.bonk)).rejects.toMatchObject({ name: 'UpstreamError', kind: 'network' });
  });

  it('échéance globale : les appels trop lents sont abandonnés, résultat partiel', async () => {
    const { svc } = service({
      signaturePageLimit: 100,
      config: { collectDeadlineMs: 50, maxSignaturePages: 1 },
      overrides: (url, init) =>
        url.includes('geckoterminal')
          ? new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error(`aborted ${url}`))))
          : undefined,
    });
    const result = await svc.collectFacts(MINTS.bonk);
    expect(result.sources).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'geckoterminal', status: 'error', errorKind: 'aborted' })]));
    expect(result.facts.liquidity?.samples.map((s) => s.source)).toEqual(['dexscreener']);
  });

  it('Jupiter 500 : contrôle de revente indisponible', async () => {
    const { svc } = service({
      signaturePageLimit: 100,
      config: { maxSignaturePages: 1 },
      overrides: (url) => (url.includes('/quote') ? new Response('', { status: 500 }) : undefined),
    });
    const result = await svc.collectFacts(MINTS.bonk);
    expect(result.facts.sellSimulation).toBeNull();
    expect(result.sources).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'jupiter', status: 'error', errorKind: 'http_error' })]));
  });

  it('devis : taxe implicite estimée, et sans prix de marché', async () => {
    const quote = (outAmount: string) =>
      new Response(JSON.stringify({ inAmount: '1', outAmount, priceImpactPct: '0.02', routePlan: [{}] }), {
        headers: { 'content-type': 'application/json' },
      });
    const taxed = service({ signaturePageLimit: 100, config: { maxSignaturePages: 1 }, overrides: (url) => (url.includes('/quote') ? quote('49000000') : undefined) });
    const taxedFacts = (await taxed.svc.collectFacts(MINTS.bonk)).facts;
    expect(taxedFacts.sellSimulation?.priceImpactPct).toBeCloseTo(2, 5);
    expect(taxedFacts.sellSimulation?.implicitTaxPct).toBeCloseTo(50, 0);

    const fixtures = loadAllFixtures().filter((f) => f.source === 'solana-rpc');
    const unpriced = service({ fixtures, overrides: (url) => (url.includes('/quote') ? quote('2500000') : undefined) });
    const facts = (await unpriced.svc.collectFacts(MINTS.honeypot)).facts;
    expect(facts.sellSimulation).toEqual({ routeFound: true, priceImpactPct: 2, implicitTaxPct: null, testAmountUsd: 2.5 });
  });

  it('profil light : ni GeckoTerminal, ni RugCheck, ni Jupiter, ni signatures', async () => {
    const { svc, calls } = service();
    const result = await svc.collectFacts(MINTS.mintActive, { profile: 'light' });
    expect(calls.map((c) => c.source)).not.toEqual(expect.arrayContaining(['geckoterminal']));
    expect(calls.some((c) => ['rugcheck', 'jupiter'].includes(c.source))).toBe(false);
    expect(calls.some((c) => c.route === 'getSignaturesForAddress')).toBe(false);
    expect(result.facts.sellSimulation).toBeNull();
    expect(result.facts.creator).toBeNull();
    expect(result.facts.rugcheck).toBeNull();
    expect(result.checkSources.liquidity.map((s) => s.id)).toEqual(['dexscreener']);
    expect(result.sources).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'jupiter', status: 'skipped' })]));
  });
});

describe('cache par source', () => {
  it('âge du token, RugCheck et créateur relus depuis le cache', async () => {
    const cache = new MemoryCacheStore(clock);
    const first = service({ cache, heliusApiKey: TEST_KEY });
    await first.svc.collectFacts(MINTS.freshPump);
    const second = service({ cache, heliusApiKey: TEST_KEY });
    const result = await second.svc.collectFacts(MINTS.freshPump);
    expect(second.calls.some((c) => c.source === 'rugcheck')).toBe(false);
    expect(second.calls.some((c) => c.route === 'getSignaturesForAddress')).toBe(false);
    expect(result.facts.creator?.tokensLaunched).toBe(5);
  });

  it('cache en panne : collecte normale, avertissement sans valeur', async () => {
    const broken: CacheStore = {
      get: async () => {
        throw new Error('redis down');
      },
      set: async () => {
        throw new Error('redis down');
      },
    };
    const { svc, logger } = service({ cache: broken });
    const result = await svc.collectFacts(MINTS.mintActive);
    expect(result.facts.mintAccount).not.toBeNull();
    expect(logger.lines.some((line) => line.includes('solana_cache_read_failed'))).toBe(true);
    expect(logger.lines.join('\n')).not.toContain(MINTS.mintActive);
  });
});

describe('résolution paire → mint', () => {
  it('paire DexScreener connue → mint du token ; inconnue ou source en panne → adresse telle quelle', async () => {
    const { svc } = service();
    await expect(svc.resolveToken('5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9')).resolves.toEqual({ mint: MINTS.bonk, resolvedFromPair: true });
    await expect(svc.resolveToken(MINTS.bonk)).resolves.toEqual({ mint: MINTS.bonk, resolvedFromPair: false });

    const reversed = service({
      overrides: (url) =>
        url.includes('/latest/dex/pairs/')
          ? new Response(
              JSON.stringify({
                pairs: [
                  {
                    chainId: 'solana',
                    dexId: 'raydium',
                    pairAddress: MINTS.lpRemoved,
                    baseToken: { address: 'So11111111111111111111111111111111111111112' },
                    quoteToken: { address: MINTS.freshPump },
                  },
                ],
              }),
              { headers: { 'content-type': 'application/json' } },
            )
          : new Response('', { status: 404, headers: { 'content-type': 'application/json' } }),
    });
    await expect(reversed.svc.resolveToken(MINTS.lpRemoved)).resolves.toEqual({ mint: MINTS.freshPump, resolvedFromPair: true });
    await expect(reversed.svc.resolveToken(MINTS.missing)).resolves.toEqual({ mint: MINTS.missing, resolvedFromPair: false });
  });

  it('mint résolu qui n’est pas une vraie clé base58 (donnée hostile) → adresse telle quelle', async () => {
    const hostile = service({
      overrides: (url) =>
        url.includes('/latest/dex/pairs/')
          ? new Response(
              JSON.stringify({
                pairs: [
                  {
                    chainId: 'solana',
                    dexId: 'raydium',
                    pairAddress: MINTS.lpRemoved,
                    // 44 caractères base58 mais 33 octets décodés : pas une clé publique.
                    baseToken: { address: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' },
                    quoteToken: { address: 'So11111111111111111111111111111111111111112' },
                  },
                ],
              }),
              { headers: { 'content-type': 'application/json' } },
            )
          : undefined,
    });
    await expect(hostile.svc.resolveToken(MINTS.lpRemoved)).resolves.toEqual({ mint: MINTS.lpRemoved, resolvedFromPair: false });
  });
});
