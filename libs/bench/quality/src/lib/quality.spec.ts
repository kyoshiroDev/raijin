import type { BenchConfig, BenchJobRegistry, BenchNotifier, BenchStatusService } from '@raijin/bench-core';
import type { BenchJobHandler } from '@raijin/bench-core';
import { RISK_ENGINE_VERSION } from '@raijin/shared-risk-engine';
import {
  FOLLOW_UP_WINDOWS,
  simulateHistory,
  type EngineVariant,
  type FollowUpHorizon,
  type FollowUpObservation,
  type OutcomeClassification,
  type StorageLevel,
  type VerdictRecord,
} from '@raijin/bench-verdicts';
import type { RiskFacts } from '@raijin/shared-contracts';
import { readingFromPair, BenchMarketReader, MarketReader } from './market-reader';
import { BenchQualityJobs, FactsSource, verdictsPerRun } from './quality-jobs';
import { PURGE_STEPS, PURGE_SQL, QualityStore, type PurgeStep } from './quality-store';
import { shadowDayRow } from './quality.controllers';
import { aggregateDaily, buildObservation, buildVerdictRow, dueWindow, toVerdictRecord, UNKNOWN_MARKET, type DailyMetricRow, type MarketReading, type VerdictRow } from './verdict-model';

/** Historique simulé déterministe (`@raijin/bench-verdicts`) : faits réalistes du moteur, aucune source réelle. */
const history = simulateHistory(20_261_124, 40);
const NOW = new Date('2026-12-01T12:00:00.000Z');

class MemoryQualityStore extends QualityStore {
  detections: string[] = [];
  verdicts: (VerdictRow & { id: string })[] = [];
  records: VerdictRecord[] = [];
  observations: { observation: FollowUpObservation; classification: OutcomeClassification | null }[] = [];
  metrics: DailyMetricRow[] = [];
  replays: object[] = [];
  purged: PurgeStep[] = [];
  level: StorageLevel | null = null;
  variants: EngineVariant[] = [];
  failStep: PurgeStep | null = null;

  async recentDetections(): Promise<string[]> {
    return this.detections;
  }
  async recordedMints(mints: readonly string[]): Promise<Set<string>> {
    return new Set(this.verdicts.map((v) => v.mint).filter((m) => mints.includes(m)));
  }
  async insertVerdict(row: VerdictRow): Promise<boolean> {
    this.verdicts.push({ ...row, id: `v${this.verdicts.length}` });
    return true;
  }
  async dueRecords(horizon: FollowUpHorizon, from: string, to: string): Promise<VerdictRecord[]> {
    return this.records.filter(
      (r) => r.verdictAt >= from && r.verdictAt <= to && !this.observations.some((o) => o.observation.recordId === r.id && o.observation.horizon === horizon),
    );
  }
  async insertObservation(observation: FollowUpObservation, classification: OutcomeClassification | null): Promise<void> {
    this.observations.push({ observation, classification });
  }
  async loadMeasured(): Promise<{ records: VerdictRecord[]; observations: FollowUpObservation[] }> {
    return { records: [...history.records], observations: [...history.observations] };
  }
  async upsertDailyMetrics(rows: readonly DailyMetricRow[]): Promise<number> {
    this.metrics = [...rows];
    return rows.length;
  }
  async enabledVariants(): Promise<EngineVariant[]> {
    return this.variants;
  }
  async insertReplay(row: object): Promise<void> {
    this.replays.push(row);
  }
  async purge(step: PurgeStep): Promise<number> {
    if (step === this.failStep) throw Object.assign(new Error('x'), { code: '57014' });
    this.purged.push(step);
    return 1;
  }
  async pushTargets() {
    return [{ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: 'k', auth: 'a' }];
  }
  async storageLevel(): Promise<StorageLevel | null> {
    return this.level;
  }
  async setStorageLevel(level: StorageLevel): Promise<void> {
    this.level = level;
  }
}

class FixedMarket extends MarketReader {
  constructor(
    private readonly reading: MarketReading,
    private readonly supply: string | null = null,
  ) {
    super();
  }
  async markets(mints: readonly string[]) {
    return new Map(mints.map((m) => [m, this.reading]));
  }
  async supplies(mints: readonly string[]) {
    const supply = this.supply;
    return new Map(supply === null ? [] : mints.map((m) => [m, supply]));
  }
}

class MapFacts extends FactsSource {
  constructor(private readonly byMint: Map<string, RiskFacts | null>) {
    super();
  }
  async collect(mint: string) {
    return this.byMint.get(mint) ?? null;
  }
}

function setup(options: { mode?: 'shadow' | 'primary'; mail?: boolean; push?: boolean; facts?: Map<string, RiskFacts | null>; market?: MarketReading; used?: number } = {}) {
  const store = new MemoryQualityStore();
  const handlers = new Map<string, BenchJobHandler>();
  const registry = { register: (name: string, h: BenchJobHandler) => handlers.set(name, h) } as unknown as BenchJobRegistry;
  const shadow = (options.mode ?? 'shadow') === 'shadow';
  const sent = { mail: 0, push: 0 };
  const notifier = {
    pushConfigured: options.push ?? true,
    sendMail: jest.fn(async () => (shadow ? { status: 'suppressed' } : (sent.mail++, { status: 'sent' }))),
    sendBenchPush: jest.fn(async () => (shadow ? { status: 'suppressed' } : (sent.push++, { status: 'sent' }))),
  } as unknown as BenchNotifier;
  const allocated = 1_000;
  const status = {
    storage: async () => ({ used_bytes: options.used ?? 100, allocated_bytes: allocated, ratio: (options.used ?? 100) / allocated, level: (options.used ?? 100) / allocated >= 0.95 ? 'critical' : (options.used ?? 100) / allocated >= 0.8 ? 'warn' : 'ok', measured_at: NOW.toISOString() }),
  } as unknown as BenchStatusService;
  const config = {
    solanaEnv: {},
    mail: options.mail === false ? { transport: 'none' } : { transport: 'smtp', url: 'smtp://localhost:1026', from: 'Banc <banc@exemple.invalid>', to: 'proprietaire@banc.invalid' },
  } as unknown as BenchConfig;
  const jobs = new BenchQualityJobs(config, () => NOW, registry, store, new MapFacts(options.facts ?? new Map()), new FixedMarket(options.market ?? UNKNOWN_MARKET), status, notifier);
  jobs.onModuleInit();
  return { jobs, store, handlers, notifier, sent };
}

describe('enregistrement des verdicts (moteur publié)', () => {
  const facts = history.records[0]!.facts;

  it('buildVerdictRow : verdict, raisons et contrôles du moteur, base de comparaison', () => {
    const row = buildVerdictRow(facts, { poolFound: true, priceUsd: 0.002, liquidityUsd: 50_000, volume24hUsd: 9_000 }, '123');
    expect(row).not.toBeNull();
    expect(row!.engine_version).toBe(RISK_ENGINE_VERSION);
    expect(row!.verdict_at).toBe(new Date(facts.observedAt).toISOString());
    expect(row!.baseline_price_usd).toBe(0.002);
    expect(row!.baseline_supply_raw).toBe('123');
    expect(buildVerdictRow({ ...facts, mintAccount: null }, UNKNOWN_MARKET, null)).toBeNull();
  });

  it('job verdict-follow-up : nouvelles détections seulement, plafond par passage, faits indisponibles comptés', async () => {
    const mints = history.records.slice(0, 9).map((r) => r.mint);
    const byMint = new Map<string, RiskFacts | null>(history.records.slice(0, 9).map((r) => [r.mint, r.facts]));
    byMint.set(mints[1]!, null);
    const { handlers, store } = setup({ facts: byMint });
    store.detections = mints;
    store.verdicts.push({ ...buildVerdictRow(history.records[0]!.facts, UNKNOWN_MARKET, null)!, id: 'old' });
    const details = await handlers.get('verdict-follow-up')!({ runId: 'r', startedAt: NOW, mode: 'shadow', trigger: 'manual' });
    expect(details).toMatchObject({ candidates: 6, unavailable: 1 });
    expect(store.verdicts.filter((v) => v.id !== 'old')).toHaveLength(5);
    expect(store.verdicts.filter((v) => v.mint === mints[0])).toHaveLength(1);
  });

  it('BENCH_VERDICTS_PER_RUN borné à 20 (budget Helius du banc)', () => {
    expect(verdictsPerRun({ solanaEnv: {} })).toBe(6);
    expect(verdictsPerRun({ solanaEnv: { BENCH_VERDICTS_PER_RUN: '3' } })).toBe(3);
    expect(verdictsPerRun({ solanaEnv: { BENCH_VERDICTS_PER_RUN: '999' } })).toBe(20);
  });
});

describe('relève 24 h / 72 h / 7 j', () => {
  const record = history.records[0]!;

  it('fenêtre ouverte = [verdict + délai ; + tolérance] ; observation classée (chute ≥ 90 % → rug)', () => {
    const w = dueWindow('24h', NOW);
    expect(Date.parse(w.to)).toBe(NOW.getTime() - FOLLOW_UP_WINDOWS['24h'].afterMs);
    const at = new Date(Date.parse(record.verdictAt) + 25 * 3_600_000);
    const crash = buildObservation(record, '24h', { poolFound: true, priceUsd: (record.baseline.priceUsd ?? 1) * 0.05, liquidityUsd: 50_000, volume24hUsd: 5_000 }, record.baseline.supplyRaw, at);
    expect(crash.classification?.status).toBe('rug');
    expect(crash.classification?.events).toContain('PRICE_CRASH_90');
    const late = buildObservation(record, '24h', UNKNOWN_MARKET, null, new Date(Date.parse(record.verdictAt) + 40 * 3_600_000));
    expect(late.classification).toBeNull();
  });

  it('job : une seule observation par verdict et horizon, source muette → issue inconnue', async () => {
    const { handlers, store } = setup({ market: UNKNOWN_MARKET });
    store.records = [{ ...record, id: 'r1', verdictAt: new Date(NOW.getTime() - 26 * 3_600_000).toISOString() }];
    await handlers.get('verdict-follow-up')!({ runId: 'a', startedAt: NOW, mode: 'shadow', trigger: 'manual' });
    await handlers.get('verdict-follow-up')!({ runId: 'b', startedAt: NOW, mode: 'shadow', trigger: 'manual' });
    expect(store.observations).toHaveLength(1);
    expect(store.observations[0]!.classification?.status).toBe('unknown');
  });

  it('lecture DexScreener : sans réponse → inconnu ; réponse sans paire → aucun pool', async () => {
    expect(readingFromPair(undefined, false)).toEqual(UNKNOWN_MARKET);
    expect(readingFromPair(undefined, true).poolFound).toBe(false);
    const reader = new BenchMarketReader({ collectAuthoritiesBatch: async () => [] }, async () => null);
    expect((await reader.markets(['So11111111111111111111111111111111111111112'])).get('So11111111111111111111111111111111111111112')).toEqual(UNKNOWN_MARKET);
  });

  it('ligne SQL → VerdictRecord (horodatage +00:00 normalisé, offre en texte)', () => {
    const r = history.records[1]!;
    const row = {
      id: 'b2c3d4e5-0000-4000-8000-000000000001',
      mint: r.mint,
      verdict_at: r.verdictAt.replace('Z', '+00:00'),
      engine_version: r.engineVersion,
      verdict: r.verdict,
      reason_codes: r.reasonCodes,
      flagged_checks: r.flaggedChecks,
      baseline_price_usd: r.baseline.priceUsd,
      baseline_liquidity_usd: r.baseline.liquidityUsd,
      baseline_supply_raw: r.baseline.supplyRaw === null ? null : Number(r.baseline.supplyRaw),
      facts: r.facts,
    };
    expect(toVerdictRecord(row)?.verdictAt).toBe(new Date(r.verdictAt).toISOString());
  });
});

describe('agrégats et variantes (rejeu derrière le drapeau enabled)', () => {
  it('aggregateDaily : n par jour × horizon × verdict × issue, signaux comptés', () => {
    const rows = aggregateDaily(history.records, history.observations);
    const total7d = rows.filter((r) => r.horizon === '7d').reduce((s, r) => s + r.n, 0);
    expect(total7d).toBe(history.records.length);
    expect(rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.day))).toBe(true);
  });

  it('job verdict-aggregate : aucune variante activée → aucun rejeu ; une variante → un rejeu stocké', async () => {
    const a = setup();
    expect(await a.handlers.get('verdict-aggregate')!({ runId: 'a', startedAt: NOW, mode: 'shadow', trigger: 'manual' })).toMatchObject({ variants: 0 });
    expect(a.store.replays).toHaveLength(0);
    const b = setup();
    b.store.variants = [{ id: 'top10-40', label: 'Top 10 à 40 %', overrides: {} }];
    await b.handlers.get('verdict-aggregate')!({ runId: 'b', startedAt: NOW, mode: 'shadow', trigger: 'manual' });
    expect(b.store.metrics.length).toBeGreaterThan(0);
    expect(b.store.replays.length).toBeLessThanOrEqual(1);
  });
});

describe('retention-purge et storage-check', () => {
  it('étapes dans l’ordre des anciens crons ; SQL de pg_cron repris tel quel', async () => {
    const { handlers, store } = setup();
    await handlers.get('retention-purge')!({ runId: 'p', startedAt: NOW, mode: 'shadow', trigger: 'manual' });
    expect(store.purged).toEqual([...PURGE_STEPS]);
    expect(PURGE_SQL.snapshots[0]).toContain("s.captured_at < now() - interval '3 days'");
    expect(PURGE_SQL.lab).toHaveLength(3);
  });

  it('une étape en échec n’arrête pas les suivantes, le job est en échec', async () => {
    const { handlers, store } = setup();
    store.failStep = 'candles';
    await expect(handlers.get('retention-purge')!({ runId: 'p', startedAt: NOW, mode: 'shadow', trigger: 'manual' })).rejects.toThrow('candles');
    expect(store.purged).toContain('lab');
  });

  it('alerte 80 % / 95 % seulement à la hausse (e-mail + push), jamais en mode ombre', async () => {
    const primary = setup({ mode: 'primary', used: 850 });
    expect(await primary.handlers.get('storage-check')!({ runId: 's', startedAt: NOW, mode: 'primary', trigger: 'manual' })).toMatchObject({ level: 'warn', notified: true });
    expect(primary.sent).toEqual({ mail: 1, push: 1 });
    await primary.handlers.get('storage-check')!({ runId: 's2', startedAt: NOW, mode: 'primary', trigger: 'manual' });
    expect(primary.sent).toEqual({ mail: 1, push: 1 });

    const shadow = setup({ mode: 'shadow', used: 990 });
    expect(await shadow.handlers.get('storage-check')!({ runId: 's', startedAt: NOW, mode: 'shadow', trigger: 'manual' })).toMatchObject({ level: 'critical', notified: false });
    expect(shadow.sent).toEqual({ mail: 0, push: 0 });
    expect(shadow.store.level).toBe('critical');
  });
});

describe('comparaison ombre', () => {
  it('écart en %, mints d’un seul côté (échantillon trié, 20 au plus), null sans référence', () => {
    const row = shadowDayRow('tokens', '2026-11-25', 110, 100, { onlyVps: ['b', 'a'], onlyRef: [] });
    expect(row).toMatchObject({ diff_pct: 10, only_vps_count: 2, only_vps_sample: ['a', 'b'] });
    expect(shadowDayRow('scan_runs', '2026-11-25', 3, 0, null)).toMatchObject({ diff_pct: null, only_vps_count: null });
  });
});
