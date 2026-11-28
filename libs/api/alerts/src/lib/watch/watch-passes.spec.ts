import type { WatchAnalysis } from '@raijin/api-analysis';
import { MemoryKeyValueStore, type AnalysisClock } from '@raijin/api-analysis';
import { testConfig } from '@raijin/api-core';
import type { PrismaService } from '@raijin/api-prisma';
import { MemoryCacheStore, SolanaDataService, resolveSolanaDataConfig } from '@raijin/api-solana';
import { createFixtureSequence, loadFixtureSequence, type Fixture, type FixtureSequence } from '@raijin/api-solana/testing';
import { mergeWatchSnapshot } from '@raijin/shared-risk-engine';
import { MemoryPrisma } from '../../testing/memory-prisma';
import { RecordingJobQueue } from '../jobs/job-queue';
import { EventRecorderService } from './event-recorder.service';
import { WatchPassesService } from './watch-passes.service';
import type { WatchAnalyzer } from './watch-sources';

const W_LP = '3G8wFjRxfaPpi9t3CXrZY1JAd4CZFfZoPuZU1ggYif6i';
const W_MINT = '6kA3B4uMv3vuePwmUcH5ca3xWtV3KnfHzBfzTtWziG83';
const W_HOLD = '7kyyXC5ZbjLDGucQA2ucEHb6wrq8fiWxDRCcf2HWzQu4';
const T0 = Date.parse('2026-11-22T03:30:00.000Z');
const U1 = '01968b3a-7c2e-7d4a-9f00-000000000001';
const U2 = '01968b3a-7c2e-7d4a-9f00-000000000002';
const U3 = '01968b3a-7c2e-7d4a-9f00-000000000003';
const ANALYSIS_ID = '01968b3a-7c2e-7d4a-9f00-0000000000aa';
const FAST = { ratePerSecond: 1_000, maxQueue: 100 };
const LIMITS = Object.fromEntries(['helius_rpc', 'helius_das', 'solana_rpc', 'dexscreener', 'geckoterminal', 'jupiter', 'rugcheck'].map((id) => [id, FAST]));

/** Mint du scénario « holder vendeur » lu par Helius (offre sans passe rapide préalable). */
function holdMintFixture(): Fixture {
  const mintAccount = loadFixtureSequence('watch-mint-reactivated')[0]?.find((fixture) => fixture.request.rpcMethod === 'getAccountInfo') as Fixture;
  // Offre alignée sur le scénario (1 000 000 000 en unités brutes).
  const body = JSON.parse(JSON.stringify(mintAccount.body).replace(/"supply":"\d+"/g, '"supply":"1000000000"')) as unknown;
  return { ...mintAccount, body, source: 'helius', request: { ...mintAccount.request, params: [W_HOLD, { encoding: 'jsonParsed', commitment: 'confirmed' }] } };
}

function setup(scenario: string, options: { cooldown?: string; verdicts?: ('safe' | 'warn' | 'danger')[] } = {}) {
  let now = T0;
  const clock = { now: () => now };
  const appClock: AnalysisClock = { now: () => new Date(now) };
  const config = resolveSolanaDataConfig({ maxAttempts: 1, backoffBaseMs: 0, limits: LIMITS });
  const sequence: FixtureSequence = createFixtureSequence(scenario, { config, base: [holdMintFixture()] });
  const solana = new SolanaDataService({
    clock,
    random: () => 0,
    cache: new MemoryCacheStore(clock),
    heliusApiKey: 'test-helius-key-0000',
    creditBudget: { tryConsume: async () => true },
    config: { maxAttempts: 1, backoffBaseMs: 0, limits: LIMITS },
    fetch: sequence.fetch,
  });
  const prisma = new MemoryPrisma();
  const queue = new RecordingJobQueue();
  const appConfig = testConfig({ ALERT_COOLDOWN_MINUTES: options.cooldown ?? '0', ALERT_EMAIL_BATCH_DELAY_S: '120' });
  const recorder = new EventRecorderService(prisma as unknown as PrismaService, queue, appClock, appConfig);
  const verdicts = [...(options.verdicts ?? [])];
  let analyses = 0;
  const analyzer = {
    analyzeForWatch: jest.fn(async (mint: string): Promise<WatchAnalysis> => {
      const verdict = verdicts.shift() ?? 'safe';
      analyses += 1;
      return {
        analysisId: `${ANALYSIS_ID.slice(0, -2)}${String(analyses).padStart(2, '0')}`,
        result: {
          mint,
          token: { mint, name: 'Démo', symbol: 'DEMO', decimals: 6, tokenProgram: 'spl-token', untrusted: true },
          verdict,
          explanation: 'Explication.',
          checks: [],
          engineVersion: '1.0.0',
          analyzedAt: new Date(now).toISOString(),
          cached: false,
          degraded: false,
        } as unknown as WatchAnalysis['result'],
      };
    }),
  };
  const store = new MemoryKeyValueStore(() => now);
  const passes = new WatchPassesService(prisma as unknown as PrismaService, solana, analyzer as unknown as WatchAnalyzer, recorder, store, appClock);
  const later = (minutes = 5) => {
    now += minutes * 60_000;
  };
  const watch = (userId: string, mint: string, status = 'active') => {
    prisma.tables['watch']?.push({ id: `${userId}-${mint}`, userId, mint, status, createdAt: new Date(now - 60_000) });
  };
  const state = (mint: string) => {
    prisma.tables['mintWatchState']?.push({
      mint,
      snapshot: null,
      token: null,
      revision: 0,
      unanalyzable: false,
      lastEarlyFullAt: null,
      nextFastAt: new Date(now),
      nextHoldersAt: new Date(now),
      nextFullAt: new Date(now),
    });
  };
  return { passes, prisma, queue, sequence, later, watch, state, store, analyzer, now: () => now };
}

describe('WatchPassesService : détection → événement → alertes, sans doublon', () => {
  it('mint réactivé : 1re passe = référence, transition → 1 événement, alertes des suivis actifs seulement', async () => {
    const t = setup('watch-mint-reactivated');
    t.state(W_MINT);
    t.watch(U1, W_MINT);
    t.watch(U2, W_MINT, 'paused');
    expect(await t.passes.fast([W_MINT])).toMatchObject({ mints: 1, events: 0, alerts: 0 });
    t.later();
    t.sequence.goTo(1);
    const detected = await t.passes.fast([W_MINT]);
    expect(detected).toMatchObject({ mints: 1, events: 1, alerts: 1 });
    const alerts = t.prisma.tables['alert'] ?? [];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ userId: U1, mint: W_MINT, type: 'mint_reactivated', severity: 'danger' });
    expect(t.queue.jobs.map((job) => job.name).sort()).toEqual(['alert-email', 'alert-push']);

    // Rejouer la même passe (reprise BullMQ) : rien de plus, aucun nouvel envoi.
    t.later(1);
    expect(await t.passes.fast([W_MINT])).toMatchObject({ events: 0, alerts: 0 });
    expect(t.prisma.tables['alert']).toHaveLength(1);
    expect(t.prisma.tables['watchEvent']).toHaveLength(1);

    // Événement critique : passe complète anticipée.
    const stored = t.prisma.tables['mintWatchState']?.[0];
    expect(stored?.['lastEarlyFullAt']).toBeInstanceOf(Date);
    expect(stored?.['revision']).toBe(3);
  });

  it('suivi créé après l’événement : aucune alerte ; événement déjà inséré → alertes idempotentes', async () => {
    const t = setup('watch-mint-reactivated');
    t.state(W_MINT);
    await t.passes.fast([W_MINT]);
    t.later();
    t.sequence.goTo(1);
    const result = await t.passes.fast([W_MINT]);
    expect(result).toMatchObject({ events: 1, alerts: 0 });
    expect(t.queue.jobs).toHaveLength(0);
  });

  it('LP retirée : swap ignoré, retrait > 30 % → lp_removed', async () => {
    const t = setup('watch-lp-removed');
    t.state(W_LP);
    t.watch(U1, W_LP);
    await t.passes.fast([W_LP]);
    for (let step = 1; step < t.sequence.steps; step += 1) {
      t.later();
      t.sequence.goTo(step);
      await t.passes.fast([W_LP]);
    }
    const types = (t.prisma.tables['alert'] ?? []).map((alert) => alert['type']);
    expect(types).toEqual(['lp_removed']);
  });

  it('holder vendeur : passe holders → holder_sold (warn)', async () => {
    const t = setup('watch-holder-sold');
    t.state(W_HOLD);
    t.watch(U1, W_HOLD);
    expect(await t.passes.holders(W_HOLD)).toMatchObject({ events: 0 });
    t.later(30);
    t.sequence.goTo(1);
    const result = await t.passes.holders(W_HOLD);
    expect(result.events).toBe(1);
    expect(t.prisma.tables['alert']?.[0]).toMatchObject({ type: 'holder_sold', severity: 'warn' });
  });

  it('passe complète : verdict dégradé (Sain → Danger) recopié sur les suivis, alerte unique', async () => {
    const t = setup('watch-mint-reactivated', { verdicts: ['safe', 'danger', 'danger'] });
    t.state(W_MINT);
    t.watch(U1, W_MINT);
    await t.passes.full(W_MINT);
    t.later(60);
    expect(await t.passes.full(W_MINT)).toMatchObject({ events: 1, alerts: 1 });
    t.later(60);
    expect(await t.passes.full(W_MINT)).toMatchObject({ events: 0 });
    expect(t.prisma.tables['alert']?.[0]).toMatchObject({ type: 'verdict_degraded', severity: 'danger' });
    expect(t.prisma.tables['watch']?.[0]).toMatchObject({ lastVerdict: 'danger' });
  });

  it('délai de grâce : même type dans le délai sans aggravation → pas d’alerte, aggravation → alerte', async () => {
    const t = setup('watch-mint-reactivated', { cooldown: '360', verdicts: ['safe', 'warn', 'safe', 'warn', 'danger'] });
    t.state(W_MINT);
    t.watch(U1, W_MINT);
    await t.passes.full(W_MINT); // référence Sain
    t.later(10);
    expect(await t.passes.full(W_MINT)).toMatchObject({ events: 1 }); // Sain → Prudence
    t.later(10);
    await t.passes.full(W_MINT); // retour Sain
    t.later(10);
    expect(await t.passes.full(W_MINT)).toMatchObject({ events: 0, skipped: 1 }); // Sain → Prudence (délai)
    t.later(10);
    expect(await t.passes.full(W_MINT)).toMatchObject({ events: 1 }); // Prudence → Danger : aggravation
    expect((t.prisma.tables['alert'] ?? []).map((alert) => alert['severity'])).toEqual(['warn', 'danger']);
  });

  it('passe complète en échec : compte non analysable marqué, autre échec compté (code seulement)', async () => {
    const t = setup('watch-mint-reactivated');
    t.state(W_MINT);
    t.analyzer.analyzeForWatch.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'UPSTREAM_UNAVAILABLE' }));
    expect(await t.passes.full(W_MINT)).toMatchObject({ failures: 1 });
    expect(t.prisma.tables['mintWatchState']?.[0]).toMatchObject({ consecutiveFailures: 1, lastErrorCode: 'UPSTREAM_UNAVAILABLE' });
    t.analyzer.analyzeForWatch.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'TOKEN_UNANALYZABLE' }));
    await t.passes.full(W_MINT);
    expect(t.prisma.tables['mintWatchState']?.[0]).toMatchObject({ unanalyzable: true });
    expect(await t.passes.full(W_MINT)).toMatchObject({ mints: 0, failures: 0 });
    expect(await t.passes.fast([W_MINT])).toMatchObject({ mints: 0 });
  });

  it('verrou du mint tenu par une autre instance : passe ignorée ; état absent : rien', async () => {
    const t = setup('watch-mint-reactivated');
    t.state(W_MINT);
    await t.store.set(`lock:watch:mint:${W_MINT}`, 'autre', 60_000);
    expect(await t.passes.fast([W_MINT])).toMatchObject({ mints: 0, skipped: 1 });
    expect(await t.passes.holders(W_LP)).toMatchObject({ mints: 0 });
    expect(await t.passes.fast([W_LP])).toMatchObject({ mints: 0 });
  });

  it('révision concurrente : l’écriture perdante est rejouée sur l’état à jour', async () => {
    const t = setup('watch-mint-reactivated');
    t.state(W_MINT);
    const original = t.prisma.mintWatchState.updateMany;
    let first = true;
    t.prisma.mintWatchState.updateMany = (async (args: Parameters<typeof original>[0]) => {
      if (first && args.where && 'revision' in args.where) {
        first = false;
        const row = t.prisma.tables['mintWatchState']?.[0];
        if (row) {
          row['revision'] = 5;
          row['snapshot'] = mergeWatchSnapshot(null, { mint: W_MINT });
        }
      }
      return original(args);
    }) as typeof original;
    expect(await t.passes.fast([W_MINT])).toMatchObject({ mints: 1 });
    expect(t.prisma.tables['mintWatchState']?.[0]?.['revision']).toBe(6);
  });
});

describe('EventRecorderService : regroupement des e-mails', () => {
  it('un job d’e-mail par utilisateur et par fenêtre, déclenché à la fin de la fenêtre', async () => {
    const queue = new RecordingJobQueue();
    const recorder = new EventRecorderService({} as PrismaService, queue, { now: () => new Date(T0) }, testConfig({ ALERT_EMAIL_BATCH_DELAY_S: '120' }));
    await recorder.enqueueEmail(U3, new Date(T0 + 10_000));
    await recorder.enqueueEmail(U3, new Date(T0 + 50_000));
    expect(queue.jobs).toHaveLength(1);
    const delay = queue.jobs[0]?.options.delayMs ?? 0;
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(120_000);
    await recorder.enqueueEmail(U3, new Date(T0 + 10_000 + 240_000));
    expect(queue.jobs).toHaveLength(2);
    expect(queue.jobs[0]?.options.jobId).not.toContain(':');
  });
});
