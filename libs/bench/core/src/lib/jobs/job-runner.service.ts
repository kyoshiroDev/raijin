import { Inject, Injectable, Logger } from '@nestjs/common';
import { JOB_ERROR_MAX_LENGTH, type BenchJobName, type JobRun } from '@raijin/bench-contracts';
import type { BenchConfig } from '../config/bench-config';
import { BENCH_CLOCK, BENCH_CONFIG, type BenchClock } from '../config/tokens';
import { errorCodeOf, safeErrorMessage } from '../security/redact';
import { BenchEventBus } from '../sse/event-bus';
import { BenchJobLock } from './job-lock';
import { BenchJobRegistry, type BenchJobDetails } from './job-registry';
import { JobRunStore } from './job-runs.store';
import { BENCH_JOB_SCHEDULES } from './schedules';

export type JobRunOutcome =
  | { readonly status: 'success' | 'failed' | 'skipped'; readonly run: JobRun }
  | { readonly status: 'not_recorded'; readonly reason: string };

/** Détails JSON bornés (contrainte `job_runs_details_check` : 8 Kio). */
function boundedDetails(details: BenchJobDetails | void): BenchJobDetails | null {
  if (!details) return null;
  const clean: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(details).slice(0, 40)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/i.test(key)) continue;
    clean[key] = typeof value === 'string' ? safeErrorMessage(value, 200) : typeof value === 'number' && !Number.isFinite(value) ? null : value;
  }
  return clean;
}

/**
 * Exécute un job du banc : verrou anti-chevauchement (une exécution à la fois ; la suivante est journalisée
 * `skipped`), ligne `job_runs` (`running` → `success` | `failed`, durée, erreur tronquée à 500 caractères et
 * nettoyée de tout secret), verrou prolongé tant que le job tourne, événement SSE `job.finished`.
 */
@Injectable()
export class BenchJobRunner {
  private readonly logger = new Logger('BenchJobs');

  constructor(
    private readonly registry: BenchJobRegistry,
    private readonly lock: BenchJobLock,
    private readonly runs: JobRunStore,
    private readonly events: BenchEventBus,
    @Inject(BENCH_CONFIG) private readonly config: BenchConfig,
    @Inject(BENCH_CLOCK) private readonly clock: BenchClock,
  ) {}

  async run(job: BenchJobName, trigger: 'schedule' | 'manual' = 'schedule'): Promise<JobRunOutcome> {
    const handler = this.registry.get(job);
    if (!handler) return this.skip(job, 'not_registered');
    const ttl = BENCH_JOB_SCHEDULES[job].lockTtlMs;
    const token = await this.lock.acquire(job, ttl);
    if (!token) return this.skip(job, 'overlap');

    const heartbeat = setInterval(() => void this.lock.extend(job, token, ttl), Math.max(1_000, Math.floor(ttl / 3)));
    heartbeat.unref();
    try {
      const startedAt = this.clock();
      let runId: string;
      try {
        runId = await this.runs.start(job, startedAt);
      } catch (error) {
        this.logger.error(`Job ${job} non lancé : journal job_runs indisponible (${errorCodeOf(error)})`);
        return { status: 'not_recorded', reason: 'job_runs_unavailable' };
      }
      let status: 'success' | 'failed' = 'success';
      let message: string | null = null;
      let details: BenchJobDetails | null = null;
      try {
        details = boundedDetails(await handler({ runId, startedAt, mode: this.config.mode, trigger }));
      } catch (error) {
        status = 'failed';
        message = safeErrorMessage(error, JOB_ERROR_MAX_LENGTH);
        this.logger.warn(`Job ${job} en échec (${errorCodeOf(error)})`);
      }
      const finishedAt = this.clock();
      let run: JobRun;
      try {
        run = await this.runs.finish(runId, status, finishedAt, Math.max(0, finishedAt.getTime() - startedAt.getTime()), message, details);
      } catch (error) {
        // La ligne reste `running` : elle sera marquée interrompue au prochain démarrage.
        this.logger.error(`Fin du job ${job} non journalisée (${errorCodeOf(error)})`);
        return { status: 'not_recorded', reason: 'job_runs_unavailable' };
      }
      this.events.publish({ type: 'job.finished', run });
      return { status, run };
    } finally {
      clearInterval(heartbeat);
      await this.lock.release(job, token);
    }
  }

  private async skip(job: BenchJobName, reason: string): Promise<JobRunOutcome> {
    try {
      const run = await this.runs.recordSkipped(job, this.clock(), reason);
      this.events.publish({ type: 'job.finished', run });
      return { status: 'skipped', run };
    } catch (error) {
      this.logger.warn(`Saut du job ${job} non journalisé (${errorCodeOf(error)})`);
      return { status: 'not_recorded', reason };
    }
  }
}
