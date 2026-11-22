import * as z from 'zod';

/** Jobs BullMQ (docs/ARCHITECTURE.md §11.3) et file qui les traite. */
export const JOB_NAMES = [
  'watch-planner',
  'watch-fast',
  'watch-holders',
  'watch-full',
  'alert-push',
  'alert-email',
  'weekly-digest',
  'purge',
] as const;
export const jobNameSchema = z.enum(JOB_NAMES);
export type JobName = z.infer<typeof jobNameSchema>;

/**
 * Files : planificateur et passe rapide en concurrence 1 (`watch`), holders en concurrence 2,
 * passes complètes en concurrence 1, envois (`notify`), maintenance (purges, résumé hebdomadaire).
 */
export const QUEUE_OF: Readonly<Record<JobName, QueueName>> = {
  'watch-planner': 'watch',
  'watch-fast': 'watch',
  'watch-holders': 'watch-holders',
  'watch-full': 'watch-full',
  'alert-push': 'notify',
  'alert-email': 'notify',
  'weekly-digest': 'maintenance',
  purge: 'maintenance',
};
export const QUEUE_NAMES = ['watch', 'watch-holders', 'watch-full', 'notify', 'maintenance'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];
export const QUEUE_CONCURRENCY: Readonly<Record<QueueName, number>> = {
  watch: 1,
  'watch-holders': 2,
  'watch-full': 1,
  notify: 4,
  maintenance: 1,
};

export interface EnqueueOptions {
  /** Identifiant déterministe : un doublon (même créneau, même mint) est ignoré par BullMQ. Sans `:`. */
  readonly jobId?: string;
  readonly delayMs?: number;
  /** 1 = le plus prioritaire (mints suivis par un Pro ou l'essai). */
  readonly priority?: number;
}

/** Charge utile d'un job (JSON). */
export type JobData = Readonly<Record<string, unknown>>;

/** Mise en file d'un job. Implémentations : BullMQ (Redis) ; enregistrement en mémoire (tests). */
export abstract class JobQueue {
  abstract add(name: JobName, data: JobData, options?: EnqueueOptions): Promise<void>;
}

/** Jobs désactivés (`JOBS_ENABLED=false` ou pas de Redis) : rien n'est mis en file. */
export class DisabledJobQueue extends JobQueue {
  async add(): Promise<void> {
    return undefined;
  }
}

/** File en mémoire des tests : jobs enregistrés, rien n'est exécuté. */
export class RecordingJobQueue extends JobQueue {
  readonly jobs: { name: JobName; data: JobData; options: EnqueueOptions }[] = [];

  async add(name: JobName, data: JobData, options: EnqueueOptions = {}): Promise<void> {
    if (options.jobId && this.jobs.some((job) => job.options.jobId === options.jobId)) return;
    this.jobs.push({ name, data, options });
  }
}

/** Identifiant de job sûr pour BullMQ (`:` interdit) : segments joints par `-`. */
export function jobId(...parts: readonly (string | number)[]): string {
  return parts.map((part) => String(part).replace(/[^A-Za-z0-9_.]/g, '_')).join('-');
}
