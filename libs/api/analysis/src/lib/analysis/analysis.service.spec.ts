import { testConfig, type AppConfig } from '@raijin/api-core';
import { ANALYSIS_CHECK_IDS, analysisResultSchema, type AnalysisResult } from '@raijin/shared-contracts';
import { RISK_ENGINE_VERSION } from '@raijin/shared-risk-engine';
import { FIXTURE_MINTS, FixtureFactsCollector } from '../fixtures/fixture-facts-collector';
import { AnalysisClock, FactsCollector, type CollectedFacts } from '../ports/facts-collector';
import type { QuotaPolicy, QuotaReservation, QuotaService } from '../quota/quota.service';
import { KeyValueStore, MemoryKeyValueStore } from '../store/key-value-store';
import type { AnalysisRepository } from './analysis.repository';
import { AnalysisService } from './analysis.service';
import { DefaultRiskEngine } from './risk-engine.provider';

const NOW = new Date('2026-11-22T12:00:00.000Z');
const clock: AnalysisClock = { now: () => NOW };
const ANON = { kind: 'anonymous', ip: '203.0.113.7' } as const;

const policy: QuotaPolicy = { kind: 'analysis', subject: 'anonymous', userId: null, ipHash: 'h', plan: null, limit: 3 };

function fakeQuota() {
  let used = 0;
  return {
    resolvePolicy: jest.fn(async () => policy),
    reserve: jest.fn(async (): Promise<QuotaReservation> => {
      used += 1;
      return { policy, day: '2026-11-22', counted: true, used, seenKey: null };
    }),
    settleFailure: jest.fn(async () => {
      used -= 1;
    }),
    info: jest.fn(async (_policy: QuotaPolicy, count?: number) => ({
      kind: 'analysis' as const,
      subject: 'anonymous' as const,
      plan: null,
      limit: 3,
      used: count ?? used,
      remaining: 3 - (count ?? used),
      resetsAt: '2026-11-23T00:00:00.000Z',
    })),
    get used() {
      return used;
    },
  };
}

function fakeRepository() {
  return {
    save: jest.fn(async () => undefined),
    findLatest: jest.fn(async (): Promise<AnalysisResult | null> => null),
    recordEvent: jest.fn(async () => undefined),
  };
}

function setup(options: { config?: AppConfig; collector?: FactsCollector; store?: KeyValueStore } = {}) {
  const collector = options.collector ?? new FixtureFactsCollector(clock);
  const store = options.store ?? new MemoryKeyValueStore();
  const quota = fakeQuota();
  const repository = fakeRepository();
  const service = new AnalysisService(
    collector,
    new DefaultRiskEngine(),
    store,
    quota as unknown as QuotaService,
    repository as unknown as AnalysisRepository,
    clock,
    options.config ?? testConfig(),
  );
  service.waitPollMs = 5;
  service.waitMaxMs = 200;
  return { service, collector, store, quota, repository };
}

describe('AnalysisService : orchestration', () => {
  it('analyse fraîche : résultat contractuel, persistance, événement, quota décompté', async () => {
    const { service, quota, repository, collector } = setup();
    const { response, durationMs } = await service.analyze(FIXTURE_MINTS.safe, ANON);
    expect(analysisResultSchema.safeParse(response.analysis).success).toBe(true);
    expect(response.analysis).toMatchObject({ mint: FIXTURE_MINTS.safe, verdict: 'safe', cached: false, degraded: false });
    expect(response.analysis.engineVersion).toBe(RISK_ENGINE_VERSION);
    expect(response.analysis.checks.map((check) => check.id)).toEqual([...ANALYSIS_CHECK_IDS]);
    expect(response.analysis.token).toMatchObject({ name: 'Raijin Demo', symbol: 'RJDEMO', untrusted: true });
    expect(response.quota).toMatchObject({ used: 1, remaining: 2 });
    expect(durationMs).toBeGreaterThanOrEqual(0);
    expect((collector as FixtureFactsCollector).calls).toBe(1);
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(repository.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ mint: FIXTURE_MINTS.safe, verdict: 'safe', cached: false, subject: 'anonymous', userId: null }),
    );
    expect(quota.settleFailure).not.toHaveBeenCalled();
  });

  it('liens de sources construits par Raijin (https, liste blanche), jamais fournis par une source', async () => {
    const { service } = setup();
    const { response } = await service.analyze(FIXTURE_MINTS.safe, ANON);
    const urls = response.analysis.checks.flatMap((check) => check.sources.map((source) => source.url)).filter(Boolean);
    expect(urls).toContain(`https://dexscreener.com/solana/${FIXTURE_MINTS.safe}`);
    expect(urls).toContain(`https://rugcheck.xyz/tokens/${FIXTURE_MINTS.safe}`);
    for (const url of urls) expect(url).toMatch(/^https:\/\//);
  });

  it('deuxième analyse dans le délai : servie depuis le cache, sans nouvelle collecte ni persistance', async () => {
    const { service, collector, repository } = setup();
    await service.analyze(FIXTURE_MINTS.safe, ANON);
    const second = await service.analyze(FIXTURE_MINTS.safe, ANON);
    expect(second.response.analysis.cached).toBe(true);
    expect((collector as FixtureFactsCollector).calls).toBe(1);
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(repository.recordEvent).toHaveBeenLastCalledWith(expect.objectContaining({ cached: true }));
  });

  it('cache de 300 s sans clé Helius, 60 s avec', async () => {
    const store = new MemoryKeyValueStore();
    const set = jest.spyOn(store, 'set');
    const noKey = setup({ store });
    await noKey.service.analyze(FIXTURE_MINTS.safe, ANON);
    expect(set).toHaveBeenCalledWith(`analysis:result:${RISK_ENGINE_VERSION}:${FIXTURE_MINTS.safe}`, expect.any(String), 300_000);
    const withKey = setup({ config: testConfig({ HELIUS_API_KEY: 'cle-helius-reelle-de-test' }) });
    expect(withKey.service.cacheTtlMs).toBe(60_000);
  });

  it('cache expiré : nouvelle collecte', async () => {
    let now = 0;
    const store = new MemoryKeyValueStore(() => now);
    const { service, collector } = setup({ store });
    await service.analyze(FIXTURE_MINTS.safe, ANON);
    now += 301_000;
    const again = await service.analyze(FIXTURE_MINTS.safe, ANON);
    expect(again.response.analysis.cached).toBe(false);
    expect((collector as FixtureFactsCollector).calls).toBe(2);
  });

  it('déduplication : analyses concurrentes du même mint → une seule collecte', async () => {
    const collector = new FixtureFactsCollector(clock, 30);
    const { service } = setup({ collector });
    const results = await Promise.all([1, 2, 3, 4].map(() => service.analyze(FIXTURE_MINTS.warn, ANON)));
    expect(collector.calls).toBe(1);
    expect(results.filter((result) => !result.response.analysis.cached)).toHaveLength(1);
    expect(new Set(results.map((result) => result.response.analysis.verdict)).size).toBe(1);
  });

  it('verrou tenu par une autre instance : relit le cache au lieu de collecter', async () => {
    const reference = (await setup().service.analyze(FIXTURE_MINTS.safe, ANON)).response.analysis;
    const store = new MemoryKeyValueStore();
    const { service, collector } = setup({ store });
    await store.set(`analysis:lock:${FIXTURE_MINTS.safe}`, 'autre-instance', 15_000);
    // L'autre instance publie son résultat dans le cache partagé pendant l'attente.
    setTimeout(() => {
      void store.set(`analysis:result:${RISK_ENGINE_VERSION}:${FIXTURE_MINTS.safe}`, JSON.stringify(reference), 60_000);
    }, 20);
    const { response } = await service.analyze(FIXTURE_MINTS.safe, ANON);
    expect(response.analysis.cached).toBe(true);
    expect((collector as FixtureFactsCollector).calls).toBe(0);
  });

  it('verrou jamais libéré : calcule soi-même après le délai d’attente', async () => {
    const store = new MemoryKeyValueStore();
    const { service, collector } = setup({ store });
    await store.set(`analysis:lock:${FIXTURE_MINTS.safe}`, 'instance-plantée', 15_000);
    const { response } = await service.analyze(FIXTURE_MINTS.safe, ANON);
    expect(response.analysis.cached).toBe(false);
    expect((collector as FixtureFactsCollector).calls).toBe(1);
    // Le verrou d'autrui n'est pas supprimé.
    await expect(store.get(`analysis:lock:${FIXTURE_MINTS.safe}`)).resolves.toBe('instance-plantée');
  });

  it('libère son propre verrou après l’analyse', async () => {
    const store = new MemoryKeyValueStore();
    const { service } = setup({ store });
    await service.analyze(FIXTURE_MINTS.safe, ANON);
    await expect(store.get(`analysis:lock:${FIXTURE_MINTS.safe}`)).resolves.toBeNull();
  });

  it('lien DexScreener d’une paire : résolu vers le mint du token', async () => {
    const { service } = setup();
    const { response } = await service.analyze(`https://dexscreener.com/solana/${FIXTURE_MINTS.pair}`, ANON);
    expect(response.analysis.mint).toBe(FIXTURE_MINTS.safe);
  });

  it('résolution de paire en échec : l’adresse est analysée comme un mint', async () => {
    const collector = new FixtureFactsCollector(clock);
    jest.spyOn(collector, 'resolveMint').mockRejectedValue(new Error('panne'));
    const { service } = setup({ collector });
    const { response } = await service.analyze(`https://dexscreener.com/solana/${FIXTURE_MINTS.warn}`, ANON);
    expect(response.analysis.mint).toBe(FIXTURE_MINTS.warn);
  });

  it('résultat partiel : sources en panne → contrôles indisponibles, degraded, jamais d’erreur', async () => {
    const { service } = setup();
    const { response } = await service.analyze(FIXTURE_MINTS.degraded, ANON);
    expect(response.analysis.degraded).toBe(true);
    const unavailable = response.analysis.checks.filter((check) => check.status === 'unavailable').map((check) => check.id);
    expect(unavailable).toEqual(expect.arrayContaining(['sell_simulation', 'creator_history', 'rugcheck']));
    expect(response.analysis.verdict).not.toBe('safe');
  });

  it('verdict Danger sur signal critique', async () => {
    const { service } = setup();
    const { response } = await service.analyze(FIXTURE_MINTS.danger, ANON);
    expect(response.analysis.verdict).toBe('danger');
    expect(response.analysis.checks[0]?.status).toBe('danger');
  });

  it('nom hostile : nettoyé par le contrat (invisibles et bidi retirés, borné)', async () => {
    const { service } = setup();
    const { response } = await service.analyze(FIXTURE_MINTS.hostile, ANON);
    expect(response.analysis.token.name).not.toMatch(/[\u202E\u200B]/);
    expect(Array.from(response.analysis.token.name ?? '').length).toBeLessThanOrEqual(64);
  });
});

describe('AnalysisService : erreurs et remboursement du quota', () => {
  it('saisie sans adresse : MINT_INVALID, aucun quota réservé', async () => {
    const { service, quota } = setup();
    await expect(service.analyze('pas une adresse', ANON)).rejects.toMatchObject({ code: 'MINT_INVALID', status: 400 });
    expect(quota.reserve).not.toHaveBeenCalled();
  });

  it('mint inexistant : TOKEN_NOT_FOUND, quota remboursé, cache négatif', async () => {
    const { service, quota, collector } = setup();
    await expect(service.analyze(FIXTURE_MINTS.notFound, ANON)).rejects.toMatchObject({ code: 'TOKEN_NOT_FOUND', status: 404 });
    expect(quota.settleFailure).toHaveBeenCalledTimes(1);
    expect(quota.used).toBe(0);
    await expect(service.analyze(FIXTURE_MINTS.notFound, ANON)).rejects.toMatchObject({ code: 'TOKEN_NOT_FOUND' });
    expect((collector as FixtureFactsCollector).calls).toBe(1);
  });

  it('sources indispensables en panne : UPSTREAM_UNAVAILABLE (503), quota remboursé', async () => {
    const { service, quota, repository } = setup();
    await expect(service.analyze(FIXTURE_MINTS.down, ANON)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', status: 503 });
    expect(quota.settleFailure).toHaveBeenCalledTimes(1);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('autorités inconnues (mintAccount null) : pas de verdict, UPSTREAM_UNAVAILABLE', async () => {
    const fixtures = new FixtureFactsCollector(clock);
    const collector = {
      resolveMint: async () => null,
      collectFacts: async (mint: string): Promise<CollectedFacts | null> => {
        const collected = await fixtures.collectFacts(FIXTURE_MINTS.safe);
        return collected && { ...collected, facts: { ...collected.facts, mint, mintAccount: null } };
      },
    } as unknown as FactsCollector;
    const { service, quota } = setup({ collector });
    await expect(service.analyze(FIXTURE_MINTS.warn, ANON)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(quota.settleFailure).toHaveBeenCalled();
  });

  it('erreur inattendue du collecteur : propagée, quota remboursé', async () => {
    const collector = { resolveMint: async () => null, collectFacts: async () => Promise.reject(new Error('bug')) } as unknown as FactsCollector;
    const { service, quota } = setup({ collector });
    await expect(service.analyze(FIXTURE_MINTS.safe, ANON)).rejects.toThrow('bug');
    expect(quota.settleFailure).toHaveBeenCalled();
  });

  it('quota épuisé : erreur propagée, aucune collecte', async () => {
    const { service, quota, collector } = setup();
    quota.reserve.mockRejectedValueOnce(Object.assign(new Error('quota'), { code: 'QUOTA_EXCEEDED' }));
    await expect(service.analyze(FIXTURE_MINTS.safe, ANON)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect((collector as FixtureFactsCollector).calls).toBe(0);
  });

  it('Redis en panne : l’analyse fonctionne sans cache partagé', async () => {
    const broken = new MemoryKeyValueStore();
    jest.spyOn(broken, 'get').mockResolvedValue(null);
    jest.spyOn(broken, 'set').mockResolvedValue(false);
    jest.spyOn(broken, 'setIfAbsent').mockResolvedValue(null);
    const { service } = setup({ store: broken });
    const { response } = await service.analyze(FIXTURE_MINTS.safe, ANON);
    expect(response.analysis.verdict).toBe('safe');
  });
});

describe('AnalysisService : résultat publié', () => {
  it('lit le cache, sinon la dernière analyse enregistrée, sinon ANALYSIS_NOT_FOUND', async () => {
    const { service, repository } = setup();
    await expect(service.latest(FIXTURE_MINTS.safe)).rejects.toMatchObject({ code: 'ANALYSIS_NOT_FOUND', status: 404 });
    const fresh = (await service.analyze(FIXTURE_MINTS.safe, ANON)).response.analysis;
    await expect(service.latest(FIXTURE_MINTS.safe)).resolves.toMatchObject({ mint: fresh.mint, cached: true });

    repository.findLatest.mockResolvedValueOnce({ ...fresh, mint: FIXTURE_MINTS.warn, token: { ...fresh.token, mint: FIXTURE_MINTS.warn } });
    await expect(service.latest(FIXTURE_MINTS.warn)).resolves.toMatchObject({ mint: FIXTURE_MINTS.warn });
    expect(repository.findLatest).toHaveBeenLastCalledWith(FIXTURE_MINTS.warn, NOW);
  });

  it('ignore un cache corrompu ou hors contrat', async () => {
    const store = new MemoryKeyValueStore();
    const { service } = setup({ store });
    await store.set(`analysis:result:${RISK_ENGINE_VERSION}:${FIXTURE_MINTS.safe}`, '{pas du json', 60_000);
    await expect(service.findLatest(FIXTURE_MINTS.safe)).resolves.toBeNull();
    await store.set(`analysis:result:${RISK_ENGINE_VERSION}:${FIXTURE_MINTS.safe}`, JSON.stringify({ verdict: 'safe' }), 60_000);
    await expect(service.findLatest(FIXTURE_MINTS.safe)).resolves.toBeNull();
  });
});
