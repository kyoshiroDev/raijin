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
/** Job des agrégats nocturnes (`api-admin`) : la purge des événements attend qu'il ait couvert le jour. */
export const METRICS_AGGREGATE_JOB = 'metrics-aggregate';
/** Tables sources des agrégats `DailyMetric` (docs/ARCHITECTURE.md §14.5) : purgées seulement une fois agrégées. */
export const AGGREGATED_PURGE_RULES: readonly string[] = ['tokenAnalysis', 'productEvent'];

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

  /**
   * `aggregatedThrough` : dernier jour UTC (`AAAA-MM-JJ`) couvert par un `JobRun` `metrics-aggregate` en succès.
   * Les `TokenAnalysis` et `ProductEvent` ne sont supprimés que jusqu'à ce jour inclus (jamais un jour non agrégé :
   * clôt le mineur m6). Sans valeur (`null`), ces deux règles sont absentes. `undefined` : pas de condition (tests).
   */
  rules(now: Date, aggregatedThrough?: string | null): PurgeRule[] {
    const retention = new Date(now.getTime() - this.config.jobs.retentionDays * DAY_MS);
    const aggregatedEnd = aggregatedThrough ? new Date(Date.parse(`${aggregatedThrough}T00:00:00.000Z`) + DAY_MS) : null;
    const eventsCutoff = aggregatedEnd && aggregatedEnd < retention ? aggregatedEnd : retention;
    const jobRuns = new Date(now.getTime() - JOB_RUN_RETENTION_DAYS * DAY_MS);
    const oneDay = new Date(now.getTime() - DAY_MS);
    const sevenDays = new Date(now.getTime() - 7 * DAY_MS);
    const day = retention.toISOString().slice(0, 10);
    // Anti-abus de l'essai (§13.6) : empreintes IP + UA 90 jours, HMAC des e-mails ayant eu un essai 24 mois.
    const fingerprints = new Date(now.getTime() - this.config.trial.fingerprintRetentionDays * DAY_MS);
    const claims = new Date(now.getTime() - this.config.trial.claimRetentionDays * DAY_MS);
    const rules: PurgeRule[] = [
      { name: 'tokenAnalysis', table: 'TokenAnalysis', key: 'id', where: Prisma.sql`"createdAt" < ${eventsCutoff}` },
      { name: 'productEvent', table: 'ProductEvent', key: 'id', where: Prisma.sql`"createdAt" < ${eventsCutoff}` },
      { name: 'usageCounter', table: 'UsageCounter', key: 'id', where: Prisma.sql`"day" < ${day}::date` },
      { name: 'trialFingerprint', table: 'TrialFingerprint', key: 'id', where: Prisma.sql`"createdAt" < ${fingerprints}` },
      { name: 'trialClaim', table: 'TrialClaim', key: 'id', where: Prisma.sql`"createdAt" < ${claims}` },
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
    return aggregatedThrough === null ? rules.filter((rule) => !AGGREGATED_PURGE_RULES.includes(rule.name)) : rules;
  }

  /** Dernier jour couvert par un passage réussi des agrégats nocturnes (`details.through`), `null` sinon. */
  async aggregatedThrough(): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ through: string | null }[]>`
      SELECT max("details"->>'through') AS "through" FROM "JobRun"
      WHERE "job" = ${METRICS_AGGREGATE_JOB} AND "status" = 'SUCCESS' AND "details"->>'through' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`;
    const through = Array.isArray(rows) ? rows[0]?.through : null;
    return typeof through === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(through) ? through : null;
  }

  run(): Promise<Record<string, number>> {
    return this.runs.track('purge', () => this.purge());
  }

  private async purge(): Promise<Record<string, number>> {
    const now = this.clock.now();
    const through = await this.aggregatedThrough();
    const retentionDay = new Date(now.getTime() - this.config.jobs.retentionDays * DAY_MS).toISOString().slice(0, 10);
    const counts: Record<string, number> = {};
    for (const rule of this.rules(now, through)) counts[rule.name] = await this.purgeRule(rule);
    // 1 si des jours à purger ne sont pas encore agrégés (l'alerte « job en échec » des agrégats préviendra l'admin).
    counts['skippedUnaggregated'] = through === null || through < retentionDay ? 1 : 0;
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
