import { Injectable } from '@nestjs/common';
import { JOB_NAMES, type JobData, type QueueName } from './job-queue';

/** Résultat d'un job (compteurs JSON). */
export type ExtraJobResult = Readonly<Record<string, unknown>>;

/**
 * Job déclaré par un autre module (essai, abonnement…) sans dépendance circulaire : `api-alerts`
 * possède les files BullMQ, le module appelant fournit le traitement. Nom en minuscules, distinct
 * des jobs de base (`JOB_NAMES`).
 */
export interface ExtraJob {
  readonly name: string;
  readonly queue: QueueName;
  /** Données revalidées par le traitement lui-même (un job altéré dans Redis ne fait rien d'imprévu). */
  readonly handler: (data: JobData) => Promise<ExtraJobResult>;
  /** Planification persistante (Job Scheduler BullMQ), retirée avec `JOBS_TEST_TRIGGER=1`. */
  readonly scheduler?: { readonly pattern: string; readonly tz: string };
  /** Déclenchable par `POST internal/jobs/:name/run` (tests e2e, jamais en production). */
  readonly manualRun?: boolean;
}

const NAME = /^[a-z][a-z0-9-]{1,40}$/;

/** Registre des jobs externes, rempli à l'initialisation des modules (avant le démarrage des workers et planifications). */
@Injectable()
export class JobRegistry {
  private readonly jobs = new Map<string, ExtraJob>();

  register(job: ExtraJob): void {
    if (!NAME.test(job.name) || (JOB_NAMES as readonly string[]).includes(job.name)) throw new Error(`Nom de job refusé : ${job.name}`);
    if (this.jobs.has(job.name)) throw new Error(`Job déjà déclaré : ${job.name}`);
    this.jobs.set(job.name, job);
  }

  get(name: string): ExtraJob | undefined {
    return this.jobs.get(name);
  }

  all(): readonly ExtraJob[] {
    return [...this.jobs.values()];
  }
}
