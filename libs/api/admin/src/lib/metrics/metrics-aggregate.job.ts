import { randomUUID } from 'node:crypto';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { JobRegistry, JobRunService, METRICS_AGGREGATE_JOB, type JobData } from '@raijin/api-alerts';
import { APP_CONFIG, randomToken, type AppConfig } from '@raijin/api-core';
import { Prisma, PrismaService } from '@raijin/api-prisma';
import { isDailyMetricKey } from '@raijin/shared-contracts';
import * as z from 'zod';
import { AdminStore } from '../common/admin-store';
import { addDays, dayStart, utcDay } from '../common/range';
import { MetricsCalculator } from './metrics-calculator';

export const METRICS_LOCK_KEY = 'lock:metrics-aggregate';
const LOCK_TTL_S = 30 * 60;
/** Jours recalculés à chaque passage : J-1, puis J-2 et J-3 (événements tardifs, webhooks rejoués). */
export const METRICS_RECOMPUTE_DAYS = 3;

/** Données du job : `now` seulement depuis la route interne de test (horloge simulée), jamais par BullMQ. */
const runData = z.object({ now: z.iso.datetime().optional() }).strict();

export interface MetricsAggregateResult {
  readonly [key: string]: string | number | boolean;
  /** Dernier jour agrégé (lu par la purge : clôt m6). */
  readonly through: string;
  readonly days: number;
  readonly rows: number;
  readonly catchUp: boolean;
}

/**
 * Job nocturne `metrics-aggregate` (file `maintenance`, `METRICS_CRON` = 02:15 UTC, avant la purge de 03:30 ; verrou
 * Redis ; `JobRun` avec `details.through`) : calcule J-1, recalcule J-2 et J-3 par `upsert` idempotent ; au premier
 * passage (table vide), rattrape tous les jours encore présents dans les tables sources (≤ `RETENTION_DAYS`).
 */
@Injectable()
export class MetricsAggregateJob implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calculator: MetricsCalculator,
    private readonly registry: JobRegistry,
    private readonly runs: JobRunService,
    private readonly store: AdminStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: METRICS_AGGREGATE_JOB,
      queue: 'maintenance',
      scheduler: { pattern: this.config.admin.metricsCron, tz: 'UTC' },
      manualRun: true,
      handler: async (data: JobData) => {
        const parsed = runData.safeParse(data ?? {});
        const testClock = parsed.success && parsed.data.now && this.config.jobs.testTrigger && !this.config.isProduction;
        return this.run(testClock && parsed.data.now ? new Date(parsed.data.now) : new Date());
      },
    });
  }

  async run(now: Date = new Date()): Promise<MetricsAggregateResult | { locked: true }> {
    const owner = randomToken(12);
    if ((await this.store.setIfAbsent(METRICS_LOCK_KEY, owner, LOCK_TTL_S)) === false) return { locked: true };
    try {
      return await this.runs.track(METRICS_AGGREGATE_JOB, () => this.aggregate(now));
    } finally {
      await this.store.deleteIfEquals(METRICS_LOCK_KEY, owner);
    }
  }

  /** Jours à (re)calculer : J-3 → J-1, ou tout l'historique au premier passage. */
  async daysToCompute(now: Date): Promise<{ days: string[]; catchUp: boolean }> {
    const yesterday = addDays(utcDay(now), -1);
    const empty = (await this.prisma.dailyMetric.count()) === 0;
    const first = empty ? addDays(yesterday, -(this.calculator.retentionDays - 1)) : addDays(yesterday, -(METRICS_RECOMPUTE_DAYS - 1));
    const days: string[] = [];
    for (let day = first; day <= yesterday; day = addDays(day, 1)) days.push(day);
    return { days, catchUp: empty };
  }

  private async aggregate(now: Date): Promise<MetricsAggregateResult> {
    const { days, catchUp } = await this.daysToCompute(now);
    let rows = 0;
    for (const day of days) rows += await this.write(day, await this.calculator.compute(day, now));
    return { through: days.at(-1) ?? addDays(utcDay(now), -1), days: days.length, rows, catchUp };
  }

  /** Upsert idempotent des valeurs d'un jour (clés hors catalogue refusées). */
  async write(day: string, metrics: Map<string, number>): Promise<number> {
    const entries = [...metrics].filter(([key, value]) => isDailyMetricKey(key) && Number.isFinite(value));
    if (entries.length === 0) return 0;
    const date = dayStart(day);
    const values = entries.map(([key, value]) => Prisma.sql`(${randomUUID()}::uuid, ${date}::date, ${key}, ${value}::float8, now())`);
    await this.prisma.$executeRaw`
      INSERT INTO "DailyMetric" ("id", "date", "key", "value", "createdAt") VALUES ${Prisma.join(values)}
      ON CONFLICT ("date", "key") DO UPDATE SET "value" = EXCLUDED."value"`;
    return entries.length;
  }
}
