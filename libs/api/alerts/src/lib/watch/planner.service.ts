import { Inject, Injectable } from '@nestjs/common';
import { AnalysisClock, KeyValueStore, RedisCreditBudget } from '@raijin/api-analysis';
import { APP_CONFIG, randomToken, type AppConfig } from '@raijin/api-core';
import { PrismaService } from '@raijin/api-prisma';
import { JobQueue, jobId } from '../jobs/job-queue';
import { JobRunService } from '../jobs/job-run.service';
import { FAST_BATCH_SIZE, PASS_CREDITS, spreadOffsetMs, stretchFactor, tomorrowWithSpread } from './schedule';

export interface PlannedState {
  readonly mint: string;
  readonly priority: number;
  readonly unanalyzable: boolean;
  readonly nextFastAt: Date;
  readonly nextHoldersAt: Date;
  readonly nextFullAt: Date;
}

export interface PlanSettings {
  readonly fastIntervalMin: number;
  readonly holdersIntervalMin: number;
  readonly fullIntervalMin: number;
  readonly remainingCredits: number;
}

export interface PassPlan {
  readonly factor: number;
  /** Lots de la passe rapide (≤ 100 mints). */
  readonly fast: string[][];
  readonly holders: string[];
  readonly full: string[];
  /** Prochaines échéances à écrire. */
  readonly next: Map<string, { nextFastAt?: Date; nextHoldersAt?: Date; nextFullAt?: Date }>;
  /** Passes reportées faute de crédits (au prochain tour, ou au lendemain si le budget est épuisé). */
  readonly deferred: number;
  readonly estimatedCredits: number;
}

const MIN = 60_000;

/** Pro et essai d'abord, puis le plus en retard. */
function byPriority(key: 'nextHoldersAt' | 'nextFullAt') {
  return (a: PlannedState, b: PlannedState) => b.priority - a.priority || a[key].getTime() - b[key].getTime();
}

/**
 * Plan pur d'un tour du planificateur (docs/ARCHITECTURE.md §11.4) : passes échues, intervalles
 * holders et complète étirés par `f`, budget restant de la voie `watch` respecté (priorité Pro),
 * budget épuisé → report au lendemain. Testé sans Redis ni base.
 */
export function planPasses(states: readonly PlannedState[], now: Date, settings: PlanSettings): PassPlan {
  const active = states.filter((state) => !state.unanalyzable);
  const factor = stretchFactor({ mints: active.length, ...settings, now });
  const next = new Map<string, { nextFastAt?: Date; nextHoldersAt?: Date; nextFullAt?: Date }>();
  const set = (mint: string, patch: { nextFastAt?: Date; nextHoldersAt?: Date; nextFullAt?: Date }) => next.set(mint, { ...next.get(mint), ...patch });
  let remaining = settings.remainingCredits;
  let deferred = 0;
  let estimated = 0;
  const exhausted = !Number.isFinite(factor);

  const fastDue = active.filter((state) => state.nextFastAt <= now).map((state) => state.mint).sort();
  const fast: string[][] = [];
  for (let index = 0; index < fastDue.length; index += FAST_BATCH_SIZE) {
    const lot = fastDue.slice(index, index + FAST_BATCH_SIZE);
    if (exhausted || remaining < PASS_CREDITS.fastPerBatch) {
      deferred += lot.length;
      for (const mint of lot) set(mint, { nextFastAt: exhausted ? tomorrowWithSpread(now, mint, settings.fastIntervalMin * MIN) : new Date(now.getTime() + settings.fastIntervalMin * MIN) });
      continue;
    }
    remaining -= PASS_CREDITS.fastPerBatch;
    estimated += PASS_CREDITS.fastPerBatch;
    fast.push(lot);
    for (const mint of lot) set(mint, { nextFastAt: new Date(now.getTime() + settings.fastIntervalMin * MIN) });
  }

  const pick = (key: 'nextHoldersAt' | 'nextFullAt', cost: number, intervalMin: number): string[] => {
    const picked: string[] = [];
    const interval = intervalMin * MIN * (exhausted ? 1 : factor);
    for (const state of active.filter((candidate) => candidate[key] <= now).sort(byPriority(key))) {
      if (exhausted) {
        deferred += 1;
        set(state.mint, { [key]: tomorrowWithSpread(now, state.mint, intervalMin * MIN) });
        continue;
      }
      if (remaining < cost) {
        // Report au prochain tour : les plus prioritaires passent d'abord.
        deferred += 1;
        continue;
      }
      remaining -= cost;
      estimated += cost;
      picked.push(state.mint);
      set(state.mint, { [key]: new Date(now.getTime() + interval) });
    }
    return picked;
  };
  const holders = pick('nextHoldersAt', PASS_CREDITS.holders, settings.holdersIntervalMin);
  const full = pick('nextFullAt', PASS_CREDITS.full, settings.fullIntervalMin);
  return { factor, fast, holders, full, next, deferred, estimatedCredits: Math.round(estimated * 10) / 10 };
}

/** Première échéance d'un nouveau mint suivi : maintenant + décalage stable (étalement). */
export function initialSchedule(mint: string, now: Date, config: AppConfig): { nextFastAt: Date; nextHoldersAt: Date; nextFullAt: Date } {
  const { holdersIntervalMin, fullIntervalMin } = config.watch;
  return {
    nextFastAt: now,
    nextHoldersAt: new Date(now.getTime() + spreadOffsetMs(mint, holdersIntervalMin * MIN, 'holders')),
    nextFullAt: new Date(now.getTime() + fullIntervalMin * MIN + spreadOffsetMs(mint, fullIntervalMin * MIN, 'full')),
  };
}

/** Verrou du planificateur (une seule instance planifie à la fois). */
export const PLANNER_LOCK_KEY = 'lock:watch-planner';

/**
 * Planificateur unique (`watch-planner`, toutes les `WATCH_TICK_SECONDS`) : verrou Redis
 * `SET NX PX`, passes mises en file avec un `jobId` déterministe (doublon ignoré), échéances
 * avancées, `JobRun` avec les compteurs (mints, crédits estimés, facteur, reports).
 */
@Injectable()
export class WatchPlannerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: JobQueue,
    private readonly budget: RedisCreditBudget,
    private readonly store: KeyValueStore,
    private readonly runs: JobRunService,
    private readonly clock: AnalysisClock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async tick(): Promise<Record<string, number | boolean>> {
    const owner = randomToken(12);
    const ttl = Math.max(10_000, this.config.jobs.tickSeconds * 1000);
    if ((await this.store.setIfAbsent(PLANNER_LOCK_KEY, owner, ttl)) === false) return { locked: true };
    try {
      return await this.runs.track('watch-planner', () => this.plan());
    } finally {
      await this.store.deleteIfEquals(PLANNER_LOCK_KEY, owner);
    }
  }

  private async plan(): Promise<Record<string, number | boolean>> {
    const now = this.clock.now();
    const states = await this.prisma.mintWatchState.findMany({
      select: { mint: true, priority: true, unanalyzable: true, nextFastAt: true, nextHoldersAt: true, nextFullAt: true },
    });
    const used = await this.budget.used('watch');
    const remainingCredits = Math.max(0, this.budget.limit('watch') - used);
    const { fastIntervalMin, holdersIntervalMin, fullIntervalMin } = this.config.watch;
    const plan = planPasses(states, now, { fastIntervalMin, holdersIntervalMin, fullIntervalMin, remainingCredits });
    const slot = Math.floor(now.getTime() / (this.config.jobs.tickSeconds * 1000));
    const priorities = new Map(states.map((state) => [state.mint, state.priority > 0 ? 1 : 2]));

    for (const [index, lot] of plan.fast.entries()) await this.queue.add('watch-fast', { mints: lot }, { jobId: jobId('fast', slot, index) });
    for (const mint of plan.holders) await this.queue.add('watch-holders', { mint }, { jobId: jobId('holders', mint, slot), priority: priorities.get(mint) });
    for (const mint of plan.full) await this.queue.add('watch-full', { mint }, { jobId: jobId('full', mint, slot), priority: priorities.get(mint) });
    for (const [mint, patch] of plan.next) await this.prisma.mintWatchState.updateMany({ where: { mint }, data: patch });

    return {
      mints: states.length,
      fastBatches: plan.fast.length,
      holders: plan.holders.length,
      full: plan.full.length,
      deferred: plan.deferred,
      estimatedCredits: plan.estimatedCredits,
      creditsUsedToday: used,
      factor: Number.isFinite(plan.factor) ? Math.round(plan.factor * 100) / 100 : -1,
    };
  }
}
