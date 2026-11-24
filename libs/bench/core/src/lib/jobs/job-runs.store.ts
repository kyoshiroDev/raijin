import { Injectable } from '@nestjs/common';
import {
  BENCH_JOB_NAMES,
  benchJobNameSchema,
  type BenchJobName,
  type BenchJobStatus,
  type JobHealth,
  type JobRun,
  type JobRunsQuery,
  type JobRunsResponse,
} from '@raijin/bench-contracts';
import { BenchPrismaService, Prisma } from '@raijin/bench-prisma';
import type { BenchJobDetails } from './job-registry';

export type FinishedStatus = Exclude<BenchJobStatus, 'running'>;

/** Journal des exécutions (`job_runs`). Implémentations : Prisma, mémoire (tests). */
export abstract class JobRunStore {
  abstract start(job: BenchJobName, at: Date): Promise<string>;
  abstract finish(id: string, status: FinishedStatus, at: Date, durationMs: number, error: string | null, details: BenchJobDetails | null): Promise<JobRun>;
  /** Exécution sautée (chevauchement, job non branché) : ligne terminée immédiatement. */
  abstract recordSkipped(job: BenchJobName, at: Date, reason: string): Promise<JobRun>;
  /** Lignes `running` laissées par un processus arrêté : passées en `failed` au démarrage. */
  abstract markInterrupted(before: Date, at: Date): Promise<number>;
  abstract list(query: JobRunsQuery): Promise<JobRunsResponse>;
  abstract health(): Promise<JobHealth[]>;
  abstract purgeOlderThan(before: Date): Promise<number>;
}

export const INTERRUPTED_ERROR = 'Interrompu (redémarrage de l’API du banc).';

interface JobRunRow {
  id: string;
  job: string;
  status: BenchJobStatus;
  started_at: Date;
  finished_at: Date | null;
  duration_ms: number | null;
  error: string | null;
}

export function toJobRun(row: JobRunRow): JobRun | null {
  const job = benchJobNameSchema.safeParse(row.job);
  if (!job.success) return null;
  return {
    id: row.id,
    job: job.data,
    status: row.status,
    started_at: row.started_at.toISOString(),
    finished_at: row.finished_at?.toISOString() ?? null,
    duration_ms: row.duration_ms,
    error: row.error,
  };
}

/** Santé par job à partir des lignes (dernier statut, dernier succès, échecs consécutifs depuis). */
export function jobHealthFrom(rows: readonly { job: string; status: BenchJobStatus; started_at: Date }[]): JobHealth[] {
  return BENCH_JOB_NAMES.map((job) => {
    const runs = rows.filter((row) => row.job === job && row.status !== 'skipped').sort((a, b) => b.started_at.getTime() - a.started_at.getTime());
    const last = rows.filter((row) => row.job === job).sort((a, b) => b.started_at.getTime() - a.started_at.getTime())[0];
    const lastSuccess = runs.find((row) => row.status === 'success');
    let failures = 0;
    for (const row of runs) {
      if (row.status === 'success') break;
      if (row.status === 'failed') failures += 1;
    }
    return {
      job,
      last_status: last?.status ?? null,
      last_started_at: last?.started_at.toISOString() ?? null,
      last_success_at: lastSuccess?.started_at.toISOString() ?? null,
      consecutive_failures: failures,
    };
  });
}

@Injectable()
export class PrismaJobRunStore extends JobRunStore {
  constructor(private readonly prisma: BenchPrismaService) {
    super();
  }

  async start(job: BenchJobName, at: Date): Promise<string> {
    const row = await this.prisma.job_runs.create({ data: { job, status: 'running', started_at: at }, select: { id: true } });
    return row.id;
  }

  async finish(id: string, status: FinishedStatus, at: Date, durationMs: number, error: string | null, details: BenchJobDetails | null): Promise<JobRun> {
    const row = await this.prisma.job_runs.update({
      where: { id },
      data: { status, finished_at: at, duration_ms: Math.max(0, Math.round(durationMs)), error, details: details ?? Prisma.DbNull },
    });
    return toJobRun(row) as JobRun;
  }

  async recordSkipped(job: BenchJobName, at: Date, reason: string): Promise<JobRun> {
    const row = await this.prisma.job_runs.create({ data: { job, status: 'skipped', started_at: at, finished_at: at, duration_ms: 0, details: { reason } } });
    return toJobRun(row) as JobRun;
  }

  async markInterrupted(before: Date, at: Date): Promise<number> {
    // `finished_at >= started_at` (contrainte) : `at` est postérieur au démarrage des lignes visées.
    const result = await this.prisma.job_runs.updateMany({
      where: { status: 'running', started_at: { lt: before } },
      data: { status: 'failed', finished_at: at, error: INTERRUPTED_ERROR },
    });
    return result.count;
  }

  async list(query: JobRunsQuery): Promise<JobRunsResponse> {
    const rows = await this.prisma.job_runs.findMany({
      where: { ...(query.job ? { job: query.job } : {}), ...(query.status ? { status: query.status } : {}) },
      orderBy: { started_at: 'desc' },
      take: query.limit + 1,
    });
    const items = rows.slice(0, query.limit).map(toJobRun).filter((run): run is JobRun => run !== null);
    return { items, truncated: rows.length > query.limit };
  }

  async health(): Promise<JobHealth[]> {
    // Par job : lignes postérieures au dernier succès (échecs consécutifs), dernier succès et dernière ligne.
    const rows = await this.prisma.$queryRaw<{ job: string; status: BenchJobStatus; started_at: Date }[]>`
      WITH last_success AS (
        SELECT job, max(started_at) AS at FROM public.job_runs WHERE status = 'success' GROUP BY job
      ), latest AS (
        SELECT DISTINCT ON (job) job, status, started_at FROM public.job_runs ORDER BY job, started_at DESC
      )
      SELECT r.job, r.status, r.started_at FROM public.job_runs r
        LEFT JOIN last_success s ON s.job = r.job
       WHERE r.status = 'failed' AND (s.at IS NULL OR r.started_at > s.at)
      UNION
      SELECT s.job, 'success'::public.job_run_status, s.at FROM last_success s
      UNION
      SELECT l.job, l.status, l.started_at FROM latest l`;
    return jobHealthFrom(rows);
  }

  async purgeOlderThan(before: Date): Promise<number> {
    const result = await this.prisma.job_runs.deleteMany({ where: { started_at: { lt: before }, status: { not: 'running' } } });
    return result.count;
  }
}
