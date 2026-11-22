import { MemoryKeyValueStore, type RedisCreditBudget } from '@raijin/api-analysis';
import { testConfig } from '@raijin/api-core';
import type { PrismaService } from '@raijin/api-prisma';
import { MemoryPrisma } from '../../testing/memory-prisma';
import { RecordingJobQueue } from '../jobs/job-queue';
import type { JobRunService } from '../jobs/job-run.service';
import { initialSchedule, planPasses, PLANNER_LOCK_KEY, WatchPlannerService, type PlannedState } from './planner.service';
import { spreadOffsetMs, stretchFactor, tomorrowWithSpread } from './schedule';

const NOW = new Date('2026-11-22T00:00:00.000Z');
const settings = { fastIntervalMin: 5, holdersIntervalMin: 30, fullIntervalMin: 360 };
const mint = (index: number) => `Mint${String(index).padStart(40, '1')}`;

function states(count: number, overrides: Partial<PlannedState> = {}): PlannedState[] {
  return Array.from({ length: count }, (_, index) => ({
    mint: mint(index),
    priority: 0,
    unanalyzable: false,
    nextFastAt: NOW,
    nextHoldersAt: NOW,
    nextFullAt: NOW,
    ...overrides,
  }));
}

describe('budget et étalement (docs/ARCHITECTURE.md §11.4)', () => {
  it('≈ 99 mints tiennent dans 12 000 crédits/jour à la cadence par défaut (f = 1)', () => {
    expect(stretchFactor({ mints: 99, ...settings, remainingCredits: 12_000, now: NOW })).toBe(1);
    expect(stretchFactor({ mints: 0, ...settings, remainingCredits: 0, now: NOW })).toBe(1);
  });

  it('300 mints : f ≈ 3 (holders toutes les 1 h 30, verdict toutes les 18 h)', () => {
    const f = stretchFactor({ mints: 300, ...settings, remainingCredits: 12_000, now: NOW });
    expect(f).toBeGreaterThan(2.8);
    expect(f).toBeLessThan(3.2);
  });

  it('budget épuisé : Infinity ; part de journée restante prise en compte', () => {
    expect(stretchFactor({ mints: 10, ...settings, remainingCredits: 0, now: NOW })).toBe(Number.POSITIVE_INFINITY);
    const evening = new Date('2026-11-22T18:00:00.000Z');
    expect(stretchFactor({ mints: 300, ...settings, remainingCredits: 3_000, now: evening })).toBeCloseTo(stretchFactor({ mints: 300, ...settings, remainingCredits: 12_000, now: NOW }), 1);
  });

  it('décalage stable par mint, borné par l’intervalle ; première échéance étalée', () => {
    expect(spreadOffsetMs('A', 1_000)).toBe(spreadOffsetMs('A', 1_000));
    expect(spreadOffsetMs('A', 0)).toBe(0);
    const offsets = new Set(Array.from({ length: 50 }, (_, index) => spreadOffsetMs(mint(index), 1_800_000)));
    expect(offsets.size).toBeGreaterThanOrEqual(30);
    const schedule = initialSchedule(mint(1), NOW, testConfig());
    expect(schedule.nextFastAt).toEqual(NOW);
    expect(schedule.nextHoldersAt.getTime() - NOW.getTime()).toBeLessThan(30 * 60_000);
    expect(schedule.nextFullAt.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 360 * 60_000);
    expect(tomorrowWithSpread(NOW, 'A', 60_000).getTime()).toBeGreaterThanOrEqual(Date.parse('2026-11-23T00:00:00.000Z'));
  });
});

describe('planPasses (pur)', () => {
  it('sous le budget : toutes les passes échues, lots de 100, échéances avancées', () => {
    const plan = planPasses(states(150), NOW, { ...settings, remainingCredits: 100_000 });
    expect(plan.factor).toBe(1);
    expect(plan.fast.map((lot) => lot.length)).toEqual([100, 50]);
    expect(plan.holders).toHaveLength(150);
    expect(plan.full).toHaveLength(150);
    expect(plan.deferred).toBe(0);
    expect(plan.next.get(mint(0))?.nextHoldersAt?.getTime()).toBe(NOW.getTime() + 30 * 60_000);
  });

  it('passes non échues et mints non analysables ignorés', () => {
    const later = new Date(NOW.getTime() + 60_000);
    const plan = planPasses([...states(2, { nextFastAt: later, nextHoldersAt: later, nextFullAt: later }), ...states(1, { unanalyzable: true })], NOW, {
      ...settings,
      remainingCredits: 12_000,
    });
    expect(plan).toMatchObject({ fast: [], holders: [], full: [], deferred: 0 });
  });

  it('au-delà du budget : intervalles étirés, Pro d’abord, le reste reporté au prochain tour', () => {
    const list = [...states(5), { ...states(1)[0], mint: 'ProMint1111111111111111111111111111111111', priority: 1 } as PlannedState];
    const plan = planPasses(list, NOW, { ...settings, remainingCredits: 30 });
    expect(plan.factor).toBeGreaterThan(1);
    expect(plan.full[0]).toBe('ProMint1111111111111111111111111111111111');
    expect(plan.full).toHaveLength(1);
    expect(plan.estimatedCredits).toBeLessThanOrEqual(30);
    expect(plan.deferred).toBeGreaterThan(0);
    const holdersNext = plan.next.get(plan.holders[0] as string)?.nextHoldersAt?.getTime() ?? 0;
    expect(holdersNext - NOW.getTime()).toBeGreaterThan(30 * 60_000);
  });

  it('budget de la voie épuisé : tout est reporté au lendemain, jamais d’erreur', () => {
    const plan = planPasses(states(3), NOW, { ...settings, remainingCredits: 0 });
    expect(plan).toMatchObject({ fast: [], holders: [], full: [], deferred: 9 });
    expect(plan.next.get(mint(0))?.nextFullAt?.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-11-23T00:00:00.000Z'));
  });
});

describe('WatchPlannerService', () => {
  function setup(used = 0) {
    const prisma = new MemoryPrisma();
    for (const state of states(3)) prisma.tables['mintWatchState']?.push({ ...state });
    const queue = new RecordingJobQueue();
    const store = new MemoryKeyValueStore();
    const budget = { used: jest.fn(async () => used), limit: () => 12_000 } as unknown as RedisCreditBudget;
    const runs = { track: jest.fn((_job: string, task: () => Promise<unknown>) => task()) } as unknown as JobRunService;
    const planner = new WatchPlannerService(prisma as unknown as PrismaService, queue, budget, store, runs, { now: () => NOW }, testConfig());
    return { planner, queue, store, prisma, runs };
  }

  it('met les passes en file avec des jobId déterministes et journalise le tour', async () => {
    const { planner, queue, prisma, runs } = setup();
    const details = await planner.tick();
    expect(details).toMatchObject({ mints: 3, fastBatches: 1, holders: 3, full: 3, deferred: 0, factor: 1 });
    expect(queue.jobs.filter((job) => job.name === 'watch-full')).toHaveLength(3);
    expect(queue.jobs.every((job) => job.options.jobId && !job.options.jobId.includes(':'))).toBe(true);
    expect(runs.track).toHaveBeenCalledWith('watch-planner', expect.any(Function));
    expect((prisma.tables['mintWatchState']?.[0]?.['nextFullAt'] as Date).getTime()).toBeGreaterThan(NOW.getTime());
    // Second tour au même instant : rien n'est échu, rien n'est remis en file.
    await planner.tick();
    expect(queue.jobs.filter((job) => job.name === 'watch-full')).toHaveLength(3);
  });

  it('verrou tenu (autre instance) : aucun tour', async () => {
    const { planner, store, queue } = setup();
    await store.set(PLANNER_LOCK_KEY, 'autre', 60_000);
    await expect(planner.tick()).resolves.toEqual({ locked: true });
    expect(queue.jobs).toHaveLength(0);
  });

  it('crédits de la voie épuisés : passes reportées (visibles dans le journal)', async () => {
    const { planner, queue } = setup(12_000);
    expect(await planner.tick()).toMatchObject({ deferred: 9, factor: -1 });
    expect(queue.jobs).toHaveLength(0);
  });
});
