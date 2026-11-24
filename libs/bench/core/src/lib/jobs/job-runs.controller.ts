import { Controller, Get, Query } from '@nestjs/common';
import { BENCH_ROUTES, jobRunsQuerySchema, type JobRunsQuery, type JobRunsResponse } from '@raijin/bench-contracts';
import { BenchZodPipe } from '../http/zod.pipe';
import { JobRunStore } from './job-runs.store';

/** `GET /api/jobs/runs?job=&status=&limit=` : journal des exécutions (session requise). */
@Controller(BENCH_ROUTES.jobRuns)
export class BenchJobRunsController {
  constructor(private readonly runs: JobRunStore) {}

  @Get()
  list(@Query(new BenchZodPipe(jobRunsQuerySchema)) query: JobRunsQuery): Promise<JobRunsResponse> {
    return this.runs.list(query);
  }
}
