import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { APP_CONFIG, errorCode, type AppConfig } from '@raijin/api-core';
import { Queue, Worker, type Job } from 'bullmq';
import Redis from 'ioredis';
import { JobHandlers } from './job-handlers.service';
import {
  JobQueue,
  jobNameSchema,
  QUEUE_CONCURRENCY,
  QUEUE_NAMES,
  QUEUE_OF,
  type EnqueueOptions,
  type JobData,
  type JobName,
  type QueueName,
} from './job-queue';

/** Reprises : envois 5 tentatives (backoff exponentiel), passes 3. */
const ATTEMPTS: Readonly<Record<QueueName, number>> = { watch: 3, 'watch-holders': 3, 'watch-full': 3, notify: 5, maintenance: 3 };
/** Résumé hebdomadaire : lundi 08:00 heure de Paris. */
export const WEEKLY_DIGEST_CRON = '0 8 * * 1';

/**
 * Files et workers BullMQ sur le Redis existant (docs/ARCHITECTURE.md §11.3). Planifications
 * persistantes (Job Schedulers) : planificateur toutes les `WATCH_TICK_SECONDS`, purge `PURGE_CRON`
 * (UTC), résumé hebdomadaire. Avec `JOBS_TEST_TRIGGER=1`, les planifications automatiques sont
 * retirées (les tests e2e déclenchent les jobs eux-mêmes) ; les workers restent actifs.
 */
@Injectable()
export class BullJobQueue extends JobQueue implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Jobs');
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers: Worker[] = [];
  private readonly connections: Redis[] = [];
  /** Résolu au démarrage (les services des jobs dépendent eux-mêmes de `JobQueue`). */
  private handlers: JobHandlers | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly moduleRef: ModuleRef,
  ) {
    super();
  }

  private connection(worker: boolean): Redis {
    const redis = new Redis(this.config.redisUrl as string, {
      // Exigé par BullMQ pour les workers (commandes bloquantes) ; les files échouent vite.
      maxRetriesPerRequest: worker ? null : 1,
      enableOfflineQueue: worker,
      connectTimeout: 2_000,
    });
    let lastWarning = 0;
    redis.on('error', (error: Error) => {
      if (Date.now() - lastWarning > 60_000) {
        lastWarning = Date.now();
        this.logger.warn(`Redis des jobs indisponible (${errorCode(error)})`);
      }
    });
    this.connections.push(redis);
    return redis;
  }

  async onModuleInit(): Promise<void> {
    this.handlers = this.moduleRef.get(JobHandlers, { strict: false });
    const prefix = this.config.jobs.prefix;
    const queueConnection = this.connection(false);
    for (const name of QUEUE_NAMES) {
      this.queues.set(
        name,
        new Queue(name, {
          connection: queueConnection,
          prefix,
          defaultJobOptions: {
            attempts: ATTEMPTS[name],
            backoff: { type: 'exponential', delay: name === 'notify' ? 10_000 : 30_000 },
            removeOnComplete: { age: 86_400, count: 1_000 },
            removeOnFail: { age: 7 * 86_400, count: 5_000 },
          },
        }),
      );
      const worker = new Worker(name, (job: Job) => this.process(job), { connection: this.connection(true), prefix, concurrency: QUEUE_CONCURRENCY[name] });
      worker.on('failed', (job, error) => this.logger.warn(`Job ${job?.name ?? '?'} en échec (${errorCode(error)})`));
      worker.on('error', (error) => this.logger.warn(`Worker en erreur (${errorCode(error)})`));
      this.workers.push(worker);
    }
    await this.schedule();
  }

  private async schedule(): Promise<void> {
    const watch = this.queues.get('watch');
    const maintenance = this.queues.get('maintenance');
    if (!watch || !maintenance) return;
    try {
      if (this.config.jobs.testTrigger) {
        await watch.removeJobScheduler('watch-planner');
        await maintenance.removeJobScheduler('purge');
        await maintenance.removeJobScheduler('weekly-digest');
        this.logger.log('Planifications automatiques désactivées (JOBS_TEST_TRIGGER=1)');
        return;
      }
      await watch.upsertJobScheduler('watch-planner', { every: this.config.jobs.tickSeconds * 1000 }, { name: 'watch-planner', data: {} });
      await maintenance.upsertJobScheduler('purge', { pattern: this.config.jobs.purgeCron, tz: 'UTC' }, { name: 'purge', data: {} });
      await maintenance.upsertJobScheduler('weekly-digest', { pattern: WEEKLY_DIGEST_CRON, tz: 'Europe/Paris' }, { name: 'weekly-digest', data: {} });
    } catch (error) {
      this.logger.error(`Planification des jobs impossible (${errorCode(error)})`);
    }
  }

  private async process(job: Job): Promise<unknown> {
    const name = jobNameSchema.safeParse(job.name);
    if (!name.success || !this.handlers) return { ignored: true };
    return this.handlers.run(name.data, (job.data ?? {}) as JobData);
  }

  async add(name: JobName, data: JobData, options: EnqueueOptions = {}): Promise<void> {
    const queue = this.queues.get(QUEUE_OF[name]);
    if (!queue) return;
    try {
      await queue.add(name, data, {
        ...(options.jobId ? { jobId: options.jobId } : {}),
        ...(options.delayMs ? { delay: options.delayMs } : {}),
        ...(options.priority ? { priority: options.priority } : {}),
      });
    } catch (error) {
      // Redis indisponible : le planificateur et les rattrapages reprendront.
      this.logger.warn(`Job ${name} non mis en file (${errorCode(error)})`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.workers.map((worker) => worker.close()));
    await Promise.allSettled([...this.queues.values()].map((queue) => queue.close()));
    for (const connection of this.connections) connection.disconnect();
  }
}
