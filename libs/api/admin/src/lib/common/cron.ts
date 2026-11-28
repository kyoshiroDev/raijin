/**
 * Prochaine occurrence d'un cron à 5 champs (minute heure jour-du-mois mois jour-de-semaine), dans le fuseau donné.
 * Syntaxe acceptée par la configuration (`METRICS_CRON`, `PURGE_CRON`…) : `*`, `*\/n`, `a`, `a-b`, `a-b/n`, listes `,`.
 * Jour du mois et jour de semaine tous deux restreints : l'un **ou** l'autre suffit (cron classique, comme BullMQ).
 * Sert seulement à l'affichage de la santé (`nextRunAt`) : `null` si le motif est illisible ou sans occurrence proche.
 */

interface CronFields {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly weekdays: ReadonlySet<number>;
  readonly daysRestricted: boolean;
  readonly weekdaysRestricted: boolean;
}

/** Horizon de recherche (un cron annuel reste couvert). */
const HORIZON_MINUTES = 400 * 24 * 60;

function parseField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const match = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!match) return null;
    const step = match[4] === undefined ? 1 : Number(match[4]);
    let from = min;
    let to = max;
    if (match[1] !== '*') {
      from = Number(match[2]);
      to = match[3] === undefined ? (match[4] === undefined ? from : max) : Number(match[3]);
    }
    if (step < 1 || from < min || to > max || from > to) return null;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

export function parseCron(pattern: string): CronFields | null {
  const parts = pattern.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const minutes = parseField(m, 0, 59);
  const hours = parseField(h, 0, 23);
  const days = parseField(dom, 1, 31);
  const months = parseField(mon, 1, 12);
  const rawWeekdays = parseField(dow, 0, 7);
  if (!minutes || !hours || !days || !months || !rawWeekdays) return null;
  // 7 = dimanche, comme 0.
  const weekdays = new Set([...rawWeekdays].map((day) => day % 7));
  return { minutes, hours, days, months, weekdays, daysRestricted: dom !== '*', weekdaysRestricted: dow !== '*' };
}

interface LocalParts {
  readonly minute: number;
  readonly hour: number;
  readonly day: number;
  readonly month: number;
  readonly weekday: number;
}

const WEEKDAYS: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function partsReader(timeZone: string): ((date: Date) => LocalParts) | null {
  if (timeZone === 'UTC') {
    return (date) => ({ minute: date.getUTCMinutes(), hour: date.getUTCHours(), day: date.getUTCDate(), month: date.getUTCMonth() + 1, weekday: date.getUTCDay() });
  }
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', minute: 'numeric', hour: 'numeric', day: 'numeric', month: 'numeric', weekday: 'short' });
  } catch {
    return null;
  }
  return (date) => {
    const parts: Record<string, string> = {};
    for (const part of format.formatToParts(date)) parts[part.type] = part.value;
    return { minute: Number(parts['minute']), hour: Number(parts['hour']), day: Number(parts['day']), month: Number(parts['month']), weekday: WEEKDAYS[parts['weekday'] ?? ''] ?? -1 };
  };
}

/** Première minute strictement postérieure à `after` qui correspond au motif, dans le fuseau `timeZone`. */
export function nextCronRun(pattern: string, timeZone: string, after: Date): Date | null {
  const cron = parseCron(pattern);
  const read = partsReader(timeZone);
  if (!cron || !read) return null;
  let cursor = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const limit = cursor + HORIZON_MINUTES * 60_000;
  while (cursor <= limit) {
    const local = read(new Date(cursor));
    const dayOk =
      cron.daysRestricted && cron.weekdaysRestricted
        ? cron.days.has(local.day) || cron.weekdays.has(local.weekday)
        : cron.days.has(local.day) && cron.weekdays.has(local.weekday);
    if (!cron.months.has(local.month) || !dayOk) {
      // Saut au jour local suivant (minuit local).
      cursor += ((23 - local.hour) * 60 + (60 - local.minute)) * 60_000;
      continue;
    }
    if (!cron.hours.has(local.hour)) {
      cursor += (60 - local.minute) * 60_000;
      continue;
    }
    if (cron.minutes.has(local.minute)) return new Date(cursor);
    cursor += 60_000;
  }
  return null;
}
