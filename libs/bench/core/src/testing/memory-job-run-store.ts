import { randomUUID } from 'node:crypto';
import type { BenchJobName, BenchJobStatus, JobHealth, JobRun, JobRunsQuery, JobRunsResponse } from '@raijin/bench-contracts';
import type { BenchJobDetails } from '../lib/jobs/job-registry';
import { INTERRUPTED_ERROR, JobRunStore, jobHealthFrom, toJobRun, type FinishedStatus } from '../lib/jobs/job-runs.store';

interface Row {
  id: string;
  job: string;
  status: BenchJobStatus;
  started_at: Date;
  finished_at: Date | null;
  duration_ms: number | null;
  error: string | null;
  details: BenchJobDetails | null;
}

/** Journal `job_runs` en mémoire (tests), mêmes contraintes utiles que la table (erreur ≤ 500). */
export class MemoryJobRunStore extends JobRunStore {
  readonly rows: Row[] = [];

  async start(job: BenchJobName, at: Date): Promise<string> {
    const id = randomUUID();
    this.rows.push({ id, job, status: 'running', started_at: at, finished_at: null, duration_ms: null, error: null, details: null });
    return id;
  }

  async finish(id: string, status: FinishedStatus, at: Date, durationMs: number, error: string | null, details: BenchJobDetails | null): Promise<JobRun> {
    const row = this.rows.find((item) => item.id === id);
    if (!row) throw new Error('not found');
    if (error !== null && error.length > 500) throw new Error('job_runs_error_check');
    Object.assign(row, { status, finished_at: at, duration_ms: durationMs, error, details });
    return toJobRun(row) as JobRun;
  }

  async recordSkipped(job: BenchJobName, at: Date, reason: string): Promise<JobRun> {
    const row: Row = { id: randomUUID(), job, status: 'skipped', started_at: at, finished_at: at, duration_ms: 0, error: null, details: { reason } };
    this.rows.push(row);
    return toJobRun(row) as JobRun;
  }

  async markInterrupted(before: Date, at: Date): Promise<number> {
    let count = 0;
    for (const row of this.rows) {
      if (row.status === 'running' && row.started_at < before) {
        Object.assign(row, { status: 'failed', finished_at: at, error: INTERRUPTED_ERROR });
        count += 1;
      }
    }
    return count;
  }

  async list(query: JobRunsQuery): Promise<JobRunsResponse> {
    const rows = this.rows
      .filter((row) => (!query.job || row.job === query.job) && (!query.status || row.status === query.status))
      .sort((a, b) => b.started_at.getTime() - a.started_at.getTime());
    return { items: rows.slice(0, query.limit).map((row) => toJobRun(row) as JobRun), truncated: rows.length > query.limit };
  }

  async health(): Promise<JobHealth[]> {
    return jobHealthFrom(this.rows);
  }

  async purgeOlderThan(before: Date): Promise<number> {
    const keep = this.rows.filter((row) => row.status === 'running' || row.started_at >= before);
    const removed = this.rows.length - keep.length;
    this.rows.splice(0, this.rows.length, ...keep);
    return removed;
  }
}
