import { Injectable } from '@nestjs/common';
import { METRICS_AGGREGATE_JOB } from '@raijin/api-alerts';
import { PrismaService } from '@raijin/api-prisma';
import {
  dailyMetricDefinition,
  type DailyMetricKey,
  type DateRange,
  type MetricUnit,
  type TimeSeries,
} from '@raijin/shared-contracts';
import { AdminStore, cached } from '../common/admin-store';
import { addDays, dayStart, rangeDays, utcDay } from '../common/range';
import { MetricsCalculator } from './metrics-calculator';

/** Jours non encore agrégés calculés en direct (jour en cours, et la nuit avant le passage du job). */
export const LIVE_DAYS = 3;
/** Cache du calcul en direct (s). */
export const LIVE_CACHE_TTL_S = 60;

/** Valeurs par clé et par jour (`null` : jour non mesuré). */
export type MetricGrid = Map<DailyMetricKey, Map<string, number>>;

/**
 * Agrège une liste de valeurs journalières selon la définition de la clé :
 * `sum` = somme, `last` = dernière valeur connue, `avg` = moyenne pondérée par la clé `weight` du même jour.
 * `null` si aucun jour n'a de valeur.
 */
export function aggregateDays(key: DailyMetricKey, days: readonly string[], grid: MetricGrid): number | null {
  const definition = dailyMetricDefinition(key);
  const values = days.map((day) => grid.get(key)?.get(day)).map((value) => (value === undefined ? null : value));
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  if (definition.aggregation === 'sum') return present.reduce((sum, value) => sum + value, 0);
  if (definition.aggregation === 'last') return present[present.length - 1] ?? null;
  const weightKey = definition.weight as DailyMetricKey | undefined;
  let weighted = 0;
  let weights = 0;
  days.forEach((day, index) => {
    const value = values[index];
    if (value === null || value === undefined) return;
    const weight = weightKey ? (grid.get(weightKey)?.get(day) ?? 0) : 1;
    weighted += value * weight;
    weights += weight;
  });
  return weights > 0 ? weighted / weights : null;
}

/**
 * Lecture des agrégats (docs/ARCHITECTURE.md §14.5) : jours passés dans `DailyMetric` seule ; jours postérieurs au
 * dernier passage du job (au plus `LIVE_DAYS`, jour en cours compris) calculés en direct, en cache 60 s.
 */
@Injectable()
export class MetricsReader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calculator: MetricsCalculator,
    private readonly store: AdminStore,
  ) {}

  /** Dernier jour couvert par un passage réussi du job (`null` avant le premier passage). */
  async aggregatedThrough(): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ through: string | null }[]>`
      SELECT max("details"->>'through') AS "through" FROM "JobRun"
      WHERE "job" = ${METRICS_AGGREGATE_JOB} AND "status" = 'SUCCESS' AND "details"->>'through' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`;
    const through = rows[0]?.through;
    return typeof through === 'string' ? through : null;
  }

  /** Grille des valeurs des `keys` sur les périodes données, jours en direct compris. */
  async grid(keys: readonly DailyMetricKey[], ranges: readonly DateRange[], now: Date): Promise<MetricGrid> {
    const grid: MetricGrid = new Map(keys.map((key) => [key, new Map<string, number>()]));
    if (ranges.length === 0 || keys.length === 0) return grid;
    const from = ranges.map((range) => range.from).sort()[0] as string;
    const to = ranges.map((range) => range.to).sort().at(-1) as string;
    const through = await this.aggregatedThrough();
    const today = utcDay(now);
    const stored = await this.prisma.dailyMetric.findMany({
      where: { key: { in: [...keys] }, date: { gte: dayStart(from), lte: dayStart(through && through < to ? through : to) } },
      select: { date: true, key: true, value: true },
    });
    for (const row of stored) {
      const day = utcDay(row.date);
      if (through !== null && day > through) continue;
      grid.get(row.key as DailyMetricKey)?.set(day, row.value);
    }
    const firstLive = addDays(today, -(LIVE_DAYS - 1));
    for (let day = to < today ? to : today; day >= from && day >= firstLive && (through === null || day > through); day = addDays(day, -1)) {
      const live = await this.live(day, now);
      for (const key of keys) {
        const value = live[key];
        if (value !== undefined) grid.get(key)?.set(day, value);
      }
    }
    return grid;
  }

  /** Métriques d'un jour non agrégé, calculées en direct (cache 60 s). */
  async live(day: string, now: Date): Promise<Partial<Record<DailyMetricKey, number>>> {
    return cached(this.store, `admin:live:v1:${day}`, LIVE_CACHE_TTL_S, async () => Object.fromEntries(await this.calculator.compute(day, now)));
  }

  /** Série journalière d'une clé (point `null` = jour non mesuré), avec la période précédente en comparaison. */
  series(key: DailyMetricKey, current: DateRange, previous: DateRange | null, grid: MetricGrid, seriesKey: string = key, unit?: MetricUnit): TimeSeries {
    const points = (range: DateRange) => rangeDays(range).map((date) => ({ date, value: grid.get(key)?.get(date) ?? null }));
    return {
      key: seriesKey,
      unit: unit ?? dailyMetricDefinition(key).unit,
      points: points(current),
      ...(previous ? { comparison: points(previous) } : {}),
    };
  }

  /** Valeur agrégée d'une clé sur une période. */
  value(key: DailyMetricKey, range: DateRange, grid: MetricGrid): number | null {
    return aggregateDays(key, rangeDays(range), grid);
  }
}
