import { daysInRange, type AdminRangeQuery, type DateRange, type ResolvedRange } from '@raijin/shared-contracts';

const DAY_MS = 86_400_000;

/** Jour UTC `AAAA-MM-JJ` d'un instant. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Décale un jour UTC de `days` jours. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Début (inclus) d'un jour UTC. */
export function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** Jours `AAAA-MM-JJ` de la période (inclus, 400 au plus). */
export function rangeDays(range: DateRange): string[] {
  const out: string[] = [];
  for (let day = range.from; day <= range.to && out.length < 400; day = addDays(day, 1)) out.push(day);
  return out;
}

const PERIOD_DAYS = { today: 1, '7d': 7, '30d': 30, '90d': 90 } as const;

/**
 * Période courante et précédente en jours UTC (`DailyMetric`) : la période se termine aujourd'hui inclus ; la
 * précédente a la même longueur et finit la veille. Une période personnalisée (`from`/`to`) prime sur `period`.
 */
export function resolveRange(query: AdminRangeQuery, now: Date): ResolvedRange {
  if (query.from && query.to) {
    const length = daysInRange(query.from, query.to);
    const previousTo = addDays(query.from, -1);
    return {
      period: 'custom',
      current: { from: query.from, to: query.to },
      previous: { from: addDays(previousTo, -(length - 1)), to: previousTo },
      timezone: 'UTC',
    };
  }
  const today = utcDay(now);
  const length = PERIOD_DAYS[query.period];
  const from = addDays(today, -(length - 1));
  const previousTo = addDays(from, -1);
  return {
    period: query.period,
    current: { from, to: today },
    previous: { from: addDays(previousTo, -(length - 1)), to: previousTo },
    timezone: 'UTC',
  };
}
