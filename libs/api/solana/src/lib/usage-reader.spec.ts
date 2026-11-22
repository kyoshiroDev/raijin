import { adminQuotaUsageSchema, QUOTA_SERVICES } from '@raijin/shared-contracts';
import { UPSTREAM_IDS } from './core/errors';
import { CounterUsageRecorder, MemoryUsageCounterStore, type UsageCounterStore } from './core/usage';
import { SolanaDataService } from './solana-data.service';
import { DEFAULT_SOLANA_DATA_CONFIG } from './config';
import { CounterUpstreamUsageReader } from './usage-reader';

const DAY = '2026-11-22';
const T0 = Date.parse(`${DAY}T10:00:00Z`);
const clock = { now: () => T0 };
const limits = { heliusDailyCreditBudget: 100, watchDailyCreditBudget: 50, walletDailyCreditBudget: 200 };
const flush = () => new Promise((resolve) => setImmediate(resolve));

function reader(store: UsageCounterStore = new MemoryUsageCounterStore(clock)) {
  const recorder = new CounterUsageRecorder(store, UPSTREAM_IDS, clock);
  return { recorder, reader: new CounterUpstreamUsageReader(recorder, () => ({ jupiter: 'open' }), limits, clock) };
}

describe('CounterUpstreamUsageReader', () => {
  it('instantané : taux d’erreur, latence, refus, disjoncteur, crédits, quotas conformes au contrat', async () => {
    const { recorder, reader: usage } = reader();
    recorder.recordCall('jupiter', 'success', 100);
    recorder.recordCall('jupiter', 'success', 200);
    recorder.recordCall('jupiter', 'rate_limited', 300);
    recorder.recordCall('jupiter', 'cancelled', 400);
    recorder.recordRejection('jupiter', 'circuit_open');
    recorder.recordCall('helius_rpc', 'success', 10);
    recorder.recordCall('helius_das', 'validation', 10);
    recorder.recordCredits('interactive', 30);
    recorder.recordCredits('watch', 45);
    recorder.recordCredits('wallet', 10);
    recorder.recordCreditRefusal('watch');
    await flush();

    const snap = await usage.snapshot();
    expect(snap).toMatchObject({ day: DAY, generatedAt: '2026-11-22T10:00:00.000Z', status: 'ok' });
    expect(snap.sources.map((s) => s.source)).toEqual([...UPSTREAM_IDS]);
    expect(snap.sources.find((s) => s.source === 'jupiter')).toEqual({
      source: 'jupiter',
      calls: 4,
      successes: 2,
      failures: 1,
      failuresByCategory: { timeout: 0, rate_limited: 1, server_error: 0, validation: 0, network: 0, other: 0 },
      cancelled: 1,
      oversized: 0,
      rejections: { circuit_open: 1, queue_full: 0, budget_exhausted: 0, aborted: 0, not_configured: 0 },
      errorRate: 1 / 3,
      avgLatencyMs: 250,
      breaker: 'open',
    });
    expect(snap.sources.find((s) => s.source === 'rugcheck')).toMatchObject({ calls: 0, errorRate: null, avgLatencyMs: null, breaker: 'closed' });
    expect(snap.credits).toEqual({
      used: 85,
      limit: 100,
      refused: 1,
      lanes: [
        { lane: 'interactive', used: 30, limit: null, refused: 0 },
        { lane: 'watch', used: 45, limit: 50, refused: 1 },
        { lane: 'wallet', used: 10, limit: 100, refused: 0 },
      ],
    });
    expect(snap.quotas.map((q) => q.service)).toEqual([...QUOTA_SERVICES]);
    for (const quota of snap.quotas) expect(adminQuotaUsageSchema.parse(quota)).toEqual(quota);
    expect(snap.quotas.find((q) => q.service === 'helius')).toMatchObject({ used: 85, limit: 100, ratio: 0.85, level: 'warning' });
    expect(snap.quotas.find((q) => q.service === 'helius_watch')).toMatchObject({ used: 45, ratio: 0.9, level: 'warning' });
    expect(snap.quotas.find((q) => q.service === 'jupiter')).toEqual({ service: 'jupiter', period: 'day', used: 4, limit: null, ratio: null, level: 'ok' });
    expect(snap.dailyMetrics).toEqual({
      'upstream_calls.helius': 2,
      'upstream_calls.solana_rpc': 0,
      'upstream_calls.dexscreener': 0,
      'upstream_calls.geckoterminal': 0,
      'upstream_calls.jupiter': 4,
      'upstream_calls.rugcheck': 0,
    });
  });

  it('jour passé explicite, jour invalide refusé, plafond nul → limite inconnue, stockage en panne', async () => {
    const { reader: usage } = reader();
    expect((await usage.snapshot('2026-11-20')).day).toBe('2026-11-20');
    await expect(usage.snapshot('2026-11-20:*')).rejects.toThrow(RangeError);

    const recorder = new CounterUsageRecorder({ increment: async () => undefined, read: () => Promise.reject(new Error('down')) }, UPSTREAM_IDS, clock);
    const zero = new CounterUpstreamUsageReader(recorder, () => ({}), { heliusDailyCreditBudget: 0, watchDailyCreditBudget: 0, walletDailyCreditBudget: 0 }, clock);
    const snap = await zero.snapshot(DAY);
    expect(snap.status).toBe('unavailable');
    expect(snap.quotas.find((q) => q.service === 'helius')).toMatchObject({ used: 0, limit: null, ratio: null, level: 'ok' });
  });
});

describe('SolanaDataService.usage', () => {
  const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

  it('compte les requêtes réelles (succès et réponse hors schéma) sans URL ni mint dans les clés', async () => {
    const keys: string[] = [];
    const memory = new MemoryUsageCounterStore();
    const store: UsageCounterStore = {
      increment: (key, fields, ttl) => {
        keys.push(key, ...Object.keys(fields));
        return memory.increment(key, fields, ttl);
      },
      read: (k) => memory.read(k),
    };
    let body: unknown = { pairs: null };
    const solana = new SolanaDataService({
      heliusApiKey: null,
      usageStore: store,
      config: { ...DEFAULT_SOLANA_DATA_CONFIG, maxAttempts: 1 },
      fetch: async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    await expect(solana.resolveToken(MINT)).resolves.toMatchObject({ resolvedFromPair: false });
    body = { pairs: 'hostile' };
    await expect(solana.resolveToken(MINT)).resolves.toMatchObject({ resolvedFromPair: false });
    await flush();

    const dex = (await solana.usage.snapshot()).sources.find((s) => s.source === 'dexscreener');
    expect(dex).toMatchObject({ calls: 2, successes: 1, failures: 1, failuresByCategory: expect.objectContaining({ validation: 1 }) });
    expect(keys.join(' ')).not.toContain(MINT);
    expect(keys.join(' ')).not.toMatch(/https?:/);
  });

  it('crédits Helius comptés par voie via le budget (stockage mémoire par défaut)', async () => {
    const solana = new SolanaDataService({
      heliusApiKey: 'test-key-not-secret',
      config: { ...DEFAULT_SOLANA_DATA_CONFIG, maxAttempts: 1 },
      fetch: async () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: [null] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await solana.collectAuthoritiesBatch([MINT]);
    await flush();
    const snap = await solana.usage.snapshot();
    expect(snap.credits.lanes.find((l) => l.lane === 'watch')?.used).toBe(1);
    expect(snap.sources.find((s) => s.source === 'helius_rpc')?.calls).toBe(1);
    expect(snap.quotas.find((q) => q.service === 'helius')?.limit).toBe(DEFAULT_SOLANA_DATA_CONFIG.heliusDailyCreditBudget);
  });
});
