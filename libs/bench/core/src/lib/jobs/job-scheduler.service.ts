import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { BENCH_JOB_NAMES, benchJobNameSchema } from '@raijin/bench-contracts';
import { Queue, Worker, type Job } from 'bullmq';
import Redis from 'ioredis';
import type { BenchConfig } from '../config/bench-config';
import { BENCH_CLOCK, BENCH_CONFIG, type BenchClock } from '../config/tokens';
import { errorCodeOf } from '../security/redact';
import { BenchJobRegistry } from './job-registry';
import { BenchJobRunner } from './job-runner.service';
import { JobRunStore } from './job-runs.store';
import { BENCH_JOB_SCHEDULES } from './schedules';

/** File unique des jobs du banc (clés `raijin-bench:bench-jobs:*`). */
export const BENCH_JOBS_QUEUE = 'bench-jobs';
/** Jobs simultanés au plus (le verrou interdit déjà deux exécutions du même job). */
export const BENCH_JOBS_CONCURRENCY = 4;

/**
 * Planification BullMQ (préfixe `raijin-bench`, fuseau UTC, motifs de `BENCH_JOB_SCHEDULES`). Au démarrage :
 * les lignes `running` d'un processus précédent passent en `failed` (interrompues), puis seuls les jobs
 * enregistrés par les modules sont planifiés ; les autres planifications sont retirées. Sans Redis ou avec
 * `BENCH_JOBS_ENABLED=0`, rien n'est planifié (déclenchement manuel par `trigger` seulement).
 * Les reprises BullMQ sont coupées (`attempts: 1`) : un échec attend le créneau suivant, comme pg_cron.
 */
@Injectable()
export class BenchJobScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('BenchJobs');
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private readonly connections: Redis[] = [];

  constructor(
    @Inject(BENCH_CONFIG) private readonly config: BenchConfig,
    @Inject(BENCH_CLOCK) private readonly clock: BenchClock,
    private readonly registry: BenchJobRegistry,
    private readonly runner: BenchJobRunner,
    private readonly runs: JobRunStore,
  ) {}

  private connection(worker: boolean): Redis {
    // BullMQ refuse `keyPrefix` : il préfixe lui-même (`prefix: raijin-bench`).
    const redis = new Redis(this.config.redisUrl as string, { maxRetriesPerRequest: worker ? null : 1, enableOfflineQueue: worker, connectTimeout: 2_000 });
    let lastWarning = 0;
    redis.on('error', (error: Error) => {
      if (Date.now() - lastWarning > 60_000) {
        lastWarning = Date.now();
        this.logger.warn(`Redis des jobs indisponible (${errorCodeOf(error)})`);
      }
    });
    this.connections.push(redis);
    return redis;
  }

  async onApplicationBootstrap(): Promise<void> {
    const bootAt = this.clock();
    try {
      const interrupted = await this.runs.markInterrupted(bootAt, bootAt);
      if (interrupted > 0) this.logger.warn(`${interrupted} exécution(s) interrompue(s) marquée(s) en échec`);
    } catch (error) {
      this.logger.warn(`Nettoyage de job_runs impossible (${errorCodeOf(error)})`);
    }
    if (!this.config.jobsEnabled || !this.config.redisUrl) {
      this.logger.log('Planification des jobs désactivée (BENCH_JOBS_ENABLED=0 ou Redis absent)');
      return;
    }
    const prefix = this.config.bullmqPrefix;
    this.queue = new Queue(BENCH_JOBS_QUEUE, {
      connection: this.connection(false),
      prefix,
      defaultJobOptions: { attempts: 1, removeOnComplete: { age: 86_400, count: 500 }, removeOnFail: { age: 7 * 86_400, count: 1_000 } },
    });
    this.worker = new Worker(BENCH_JOBS_QUEUE, (job: Job) => this.process(job), { connection: this.connection(true), prefix, concurrency: BENCH_JOBS_CONCURRENCY });
    this.worker.on('error', (error) => this.logger.warn(`Worker en erreur (${errorCodeOf(error)})`));
    const registered = new Set(this.registry.names());
    try {
      for (const name of BENCH_JOB_NAMES) {
        if (registered.has(name)) {
          await this.queue.upsertJobScheduler(name, { pattern: BENCH_JOB_SCHEDULES[name].pattern, tz: 'UTC' }, { name, data: { trigger: 'schedule' } });
        } else {
          await this.queue.removeJobScheduler(name);
        }
      }
      this.logger.log(`Jobs planifiés : ${[...registered].join(', ') || 'aucun (modules métier non branchés)'}`);
    } catch (error) {
      this.logger.error(`Planification des jobs impossible (${errorCodeOf(error)})`);
    }
  }

  private async process(job: Job): Promise<{ status: string }> {
    const name = benchJobNameSchema.safeParse(job.name);
    if (!name.success) return { status: 'ignored' };
    const trigger = (job.data as { trigger?: unknown } | undefined)?.trigger === 'manual' ? 'manual' : 'schedule';
    const outcome = await this.runner.run(name.data, trigger);
    return { status: outcome.status };
  }

  /** Met un job en file pour une exécution immédiate (verrou et journal identiques) ; faux sans file. */
  async trigger(name: (typeof BENCH_JOB_NAMES)[number]): Promise<boolean> {
    if (!this.queue) return false;
    try {
      await this.queue.add(name, { trigger: 'manual' });
      return true;
    } catch (error) {
      this.logger.warn(`Job ${name} non mis en file (${errorCodeOf(error)})`);
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
    for (const connection of this.connections) connection.disconnect();
  }
}
