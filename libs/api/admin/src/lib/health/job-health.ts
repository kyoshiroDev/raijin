import { Injectable } from '@nestjs/common';
import { PrismaService } from '@raijin/api-prisma';
import { ADMIN_JOB_LABELS, type AdminJobHealth } from '@raijin/shared-contracts';

/** Exécutions lues par job (série d'échecs et dernier passage). */
const RUNS_PER_JOB = 50;
const JOB_NAME = /^[a-z0-9:_-]{1,64}$/;
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

export interface JobRunRow {
  readonly id: string;
  readonly job: string;
  readonly status: 'RUNNING' | 'SUCCESS' | 'FAILED';
  readonly startedAt: Date;
  readonly durationMs: number | null;
  readonly error: string | null;
}

export interface JobState extends AdminJobHealth {
  /** Identifiant du premier échec de la série en cours (déduplication des alertes), `null` sans série. */
  readonly firstFailureId: string | null;
  /** Dernier succès (résolution des alertes). */
  readonly lastSuccessAt: Date | null;
}

/** État d'un job à partir de ses exécutions, de la plus récente à la plus ancienne. */
export function jobState(name: string, runs: readonly JobRunRow[]): JobState {
  const latest = runs[0];
  let consecutiveFailures = 0;
  let firstFailureId: string | null = null;
  let lastErrorCode: string | null = null;
  for (const run of runs) {
    if (run.status === 'RUNNING') continue;
    if (run.status === 'SUCCESS') break;
    consecutiveFailures += 1;
    firstFailureId = run.id;
    lastErrorCode ??= run.error && ERROR_CODE.test(run.error) ? run.error : 'UNKNOWN';
  }
  const lastSuccess = runs.find((run) => run.status === 'SUCCESS');
  return {
    name,
    lastRunAt: latest ? latest.startedAt.toISOString() : null,
    lastStatus: latest ? (latest.status.toLowerCase() as AdminJobHealth['lastStatus']) : null,
    lastDurationMs: latest?.durationMs ?? null,
    consecutiveFailures,
    lastErrorCode: latest?.status === 'FAILED' ? (latest.error && ERROR_CODE.test(latest.error) ? latest.error : 'UNKNOWN') : consecutiveFailures > 0 ? lastErrorCode : null,
    nextRunAt: null,
    firstFailureId,
    lastSuccessAt: lastSuccess?.startedAt ?? null,
  };
}

/** Lecture de `JobRun` (30 derniers jours, conservés par la purge) : état de chaque job connu ou exécuté. */
@Injectable()
export class JobHealthReader {
  constructor(private readonly prisma: PrismaService) {}

  async states(now: Date): Promise<JobState[]> {
    const since = new Date(now.getTime() - 30 * 86_400_000);
    const rows = await this.prisma.$queryRaw<JobRunRow[]>`
      SELECT "id", "job", "status"::text AS "status", "startedAt", "durationMs", "error" FROM (
        SELECT *, row_number() OVER (PARTITION BY "job" ORDER BY "startedAt" DESC) AS "rn"
        FROM "JobRun" WHERE "startedAt" >= ${since}
      ) r WHERE r."rn" <= ${RUNS_PER_JOB}
      ORDER BY "job" ASC, "startedAt" DESC`;
    const byJob = new Map<string, JobRunRow[]>(Object.keys(ADMIN_JOB_LABELS).map((name) => [name, []]));
    for (const row of rows) {
      if (!JOB_NAME.test(row.job)) continue;
      if (!byJob.has(row.job)) byJob.set(row.job, []);
      byJob.get(row.job)?.push(row);
    }
    return [...byJob.entries()].slice(0, 50).map(([name, runs]) => jobState(name, runs));
  }
}
