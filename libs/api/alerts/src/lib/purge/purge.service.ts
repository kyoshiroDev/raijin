import { Inject, Injectable } from '@nestjs/common';
import { AnalysisClock } from '@raijin/api-analysis';
import { APP_CONFIG, type AppConfig } from '@raijin/api-core';
import { Prisma, PrismaService } from '@raijin/api-prisma';
import { JobRunService } from '../jobs/job-run.service';

/** Lignes supprimées par requête (lots : pas de verrou long sur les tables). */
export const PURGE_BATCH = 5_000;
/** `JobRun` conservé 30 jours. */
export const JOB_RUN_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

/** Une purge : table et condition (SQL paramétré, jamais de valeur concaténée). */
export interface PurgeRule {
  readonly name: string;
  readonly table: string;
  readonly key: string;
  readonly where: Prisma.Sql;
}

/**
 * Purges quotidiennes (docs/ARCHITECTURE.md §11.9, `PURGE_CRON`) par lots de 5 000 lignes. Rien en
 * dehors de ces règles n'est supprimé ; chaque purge écrit son `JobRun` (lignes par table).
 */
@Injectable()
export class PurgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: JobRunService,
    private readonly clock: AnalysisClock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  rules(now: Date): PurgeRule[] {
    const retention = new Date(now.getTime() - this.config.jobs.retentionDays * DAY_MS);
    const jobRuns = new Date(now.getTime() - JOB_RUN_RETENTION_DAYS * DAY_MS);
    const oneDay = new Date(now.getTime() - DAY_MS);
    const sevenDays = new Date(now.getTime() - 7 * DAY_MS);
    const day = retention.toISOString().slice(0, 10);
    return [
      { name: 'tokenAnalysis', table: 'TokenAnalysis', key: 'id', where: Prisma.sql`"createdAt" < ${retention}` },
      { name: 'productEvent', table: 'ProductEvent', key: 'id', where: Prisma.sql`"createdAt" < ${retention}` },
      { name: 'usageCounter', table: 'UsageCounter', key: 'id', where: Prisma.sql`"day" < ${day}::date` },
      { name: 'trialFingerprint', table: 'TrialFingerprint', key: 'id', where: Prisma.sql`"createdAt" < ${retention}` },
      { name: 'alert', table: 'Alert', key: 'id', where: Prisma.sql`"createdAt" < ${retention}` },
      { name: 'watchEvent', table: 'WatchEvent', key: 'id', where: Prisma.sql`"createdAt" < ${retention}` },
      { name: 'jobRun', table: 'JobRun', key: 'id', where: Prisma.sql`"startedAt" < ${jobRuns} AND "status" <> 'RUNNING'` },
      {
        name: 'session',
        table: 'Session',
        key: 'id',
        where: Prisma.sql`("expiresAt" < ${oneDay}) OR ("revokedAt" IS NOT NULL AND "revokedAt" < ${sevenDays})`,
      },
      { name: 'authToken', table: 'AuthToken', key: 'id', where: Prisma.sql`"expiresAt" < ${oneDay}` },
      {
        name: 'mintWatchState',
        table: 'MintWatchState',
        key: 'mint',
        where: Prisma.sql`NOT EXISTS (SELECT 1 FROM "Watch" w WHERE w."mint" = "MintWatchState"."mint")`,
      },
    ];
  }

  run(): Promise<Record<string, number>> {
    return this.runs.track('purge', () => this.purge());
  }

  private async purge(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const rule of this.rules(this.clock.now())) counts[rule.name] = await this.purgeRule(rule);
    return counts;
  }

  private async purgeRule(rule: PurgeRule): Promise<number> {
    const table = Prisma.raw(`"${rule.table}"`);
    const key = Prisma.raw(`"${rule.key}"`);
    let total = 0;
    for (;;) {
      const deleted = await this.prisma.$executeRaw`
        DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE ${rule.where} LIMIT ${PURGE_BATCH})`;
      total += deleted;
      if (deleted < PURGE_BATCH) return total;
    }
  }
}
