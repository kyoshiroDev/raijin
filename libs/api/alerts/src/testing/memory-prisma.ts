import { randomUUID } from 'node:crypto';

/**
 * Faux Prisma en mémoire pour les tests unitaires des suivis (aucune base) : seulement les opérations
 * et filtres utilisés par les services (égalité, `in`, `notIn`, `not`, `lt`, `lte`, `gt`, `gte`, `OR`, relation
 * `user`), `createMany({ skipDuplicates })` avec les contraintes uniques du schéma, `{ increment }`.
 */
type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const UNIQUE: Readonly<Record<string, readonly (readonly string[])[]>> = {
  watchEvent: [['mint', 'dedupeKey']],
  alert: [['userId', 'eventId']],
  watch: [['userId', 'mint']],
  mintWatchState: [['mint']],
  pushSubscription: [['endpoint']],
};

const DEFAULTS: Readonly<Record<string, () => Row>> = {
  alert: () => ({ readAt: null, emailedAt: null, pushedAt: null, emailSkipped: false, token: null }),
  watch: () => ({ status: 'active', pausedReason: null, pausedAt: null, lastVerdict: null, lastCheckedAt: null }),
  mintWatchState: () => ({ revision: 0, priority: 0, consecutiveFailures: 0, lastErrorCode: null, unanalyzable: false, lastEarlyFullAt: null, token: null }),
  pushSubscription: () => ({ lastSuccessAt: null, userAgent: null }),
};

function compare(value: unknown, condition: unknown, rows: MemoryPrisma, row: Row): boolean {
  if (condition === null) return value === null || value === undefined;
  if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
  if (typeof condition !== 'object') return value === condition;
  const ops = condition as Record<string, unknown>;
  const v = value instanceof Date ? value.getTime() : value;
  const c = (x: unknown) => (x instanceof Date ? x.getTime() : x);
  for (const [op, arg] of Object.entries(ops)) {
    if (op === 'in' && !(arg as unknown[]).includes(value)) return false;
    if (op === 'notIn' && (arg as unknown[]).includes(value)) return false;
    if (op === 'not' && (arg === null ? value === null || value === undefined : compare(value, arg, rows, row))) return false;
    if (op === 'lt' && !((v as number) < (c(arg) as number))) return false;
    if (op === 'lte' && !((v as number) <= (c(arg) as number))) return false;
    if (op === 'gt' && !((v as number) > (c(arg) as number))) return false;
    if (op === 'gte' && !((v as number) >= (c(arg) as number))) return false;
    if (op === 'some') return true;
  }
  return true;
}

export class MemoryPrisma {
  readonly tables: Record<string, Row[]> = { watchEvent: [], alert: [], watch: [], mintWatchState: [], pushSubscription: [], user: [], usageCounter: [] };
  /** Résultats des requêtes SQL brutes, par ordre d'appel (tests). */
  readonly rawQueries: string[] = [];
  rawHandler: (sql: string, values: unknown[]) => unknown = () => [];
  /** Horodatages strictement croissants des lignes créées. */
  private sequence = 0;

  matches(table: string, row: Row, where: Where = {}): boolean {
    return Object.entries(where).every(([key, condition]) => {
      if (condition === undefined) return true;
      if (key === 'OR') return (condition as Where[]).some((part) => this.matches(table, row, part));
      if (key === 'user') {
        const user = this.tables['user']?.find((candidate) => candidate['id'] === row['userId']);
        return !!user && this.matches('user', user, condition as Where);
      }
      if (key === 'watches') return true;
      if (key.includes('_')) {
        const fields = key.split('_');
        return fields.every((field) => row[field] === (condition as Row)[field]);
      }
      return compare(row[key], condition, this, row);
    });
  }

  private delegate(table: string) {
    const rows = () => (this.tables[table] ??= []);
    const apply = (row: Row, data: Row) => {
      for (const [key, value] of Object.entries(data)) {
        if (value !== null && typeof value === 'object' && 'increment' in (value as Row)) row[key] = Number(row[key] ?? 0) + Number((value as Row)['increment']);
        else row[key] = value;
      }
    };
    const pick = (row: Row | undefined, select?: Record<string, unknown>) => {
      if (!row) return null;
      if (!select) return { ...row };
      const out: Row = {};
      for (const [key, wanted] of Object.entries(select)) {
        if (!wanted) continue;
        if (key === 'user' && typeof wanted === 'object') {
          const user = this.tables['user']?.find((candidate) => candidate['id'] === row['userId']);
          out[key] = pick(user, (wanted as { select: Record<string, unknown> }).select);
        } else out[key] = row[key];
      }
      return out;
    };
    const duplicate = (data: Row) =>
      (UNIQUE[table] ?? []).some((fields) => fields.every((field) => data[field] !== undefined && data[field] !== null) && rows().some((row) => fields.every((field) => row[field] === data[field])));
    const create = (data: Row): Row => {
      const at = new Date(Date.now() + (this.sequence += 1));
      const row: Row = { id: randomUUID(), createdAt: at, updatedAt: at, ...(DEFAULTS[table]?.() ?? {}), ...data };
      rows().push(row);
      return row;
    };
    const sort = (list: Row[], orderBy?: unknown) => {
      const orders = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Record<string, 'asc' | 'desc'>[];
      return [...list].sort((a, b) => {
        for (const order of orders) {
          const [[key, dir] = ['id', 'asc']] = Object.entries(order);
          const av = a[key] instanceof Date ? (a[key] as Date).getTime() : (a[key] as number | string);
          const bv = b[key] instanceof Date ? (b[key] as Date).getTime() : (b[key] as number | string);
          if (av < bv) return dir === 'asc' ? -1 : 1;
          if (av > bv) return dir === 'asc' ? 1 : -1;
        }
        return 0;
      });
    };
    return {
      findMany: async (args: { where?: Where; select?: Record<string, unknown>; orderBy?: unknown; take?: number; distinct?: string[] } = {}) => {
        let list = sort(rows().filter((row) => this.matches(table, row, args.where)), args.orderBy);
        if (args.distinct) {
          const seen = new Set<string>();
          list = list.filter((row) => {
            const key = args.distinct?.map((field) => String(row[field])).join('|') ?? '';
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }
        return list.slice(0, args.take ?? list.length).map((row) => pick(row, args.select));
      },
      findFirst: async (args: { where?: Where; select?: Record<string, unknown>; orderBy?: unknown } = {}) =>
        pick(sort(rows().filter((row) => this.matches(table, row, args.where)), args.orderBy)[0], args.select),
      findUnique: async (args: { where: Where; select?: Record<string, unknown> }) => pick(rows().find((row) => this.matches(table, row, args.where)), args.select),
      count: async (args: { where?: Where } = {}) => rows().filter((row) => this.matches(table, row, args.where)).length,
      create: async (args: { data: Row; select?: Record<string, unknown> }) => {
        if (duplicate(args.data)) throw Object.assign(new Error('Unique'), { code: 'P2002' });
        return pick(create(args.data), args.select);
      },
      createMany: async (args: { data: Row[]; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const data of args.data) {
          if (duplicate(data)) {
            if (args.skipDuplicates) continue;
            throw Object.assign(new Error('Unique'), { code: 'P2002' });
          }
          create(data);
          count += 1;
        }
        return { count };
      },
      update: async (args: { where: Where; data: Row; select?: Record<string, unknown> }) => {
        const row = rows().find((candidate) => this.matches(table, candidate, args.where));
        if (!row) throw Object.assign(new Error('Not found'), { code: 'P2025' });
        apply(row, args.data);
        return pick(row, args.select);
      },
      updateMany: async (args: { where?: Where; data: Row }) => {
        const list = rows().filter((row) => this.matches(table, row, args.where));
        for (const row of list) apply(row, args.data);
        return { count: list.length };
      },
      upsert: async (args: { where: Where; create: Row; update: Row; select?: Record<string, unknown> }) => {
        const row = rows().find((candidate) => this.matches(table, candidate, args.where));
        if (row) {
          apply(row, args.update);
          return pick(row, args.select);
        }
        return pick(create(args.create), args.select);
      },
      deleteMany: async (args: { where?: Where } = {}) => {
        const before = rows().length;
        this.tables[table] = rows().filter((row) => !this.matches(table, row, args.where));
        return { count: before - (this.tables[table]?.length ?? 0) };
      },
      groupBy: async (args: { by: string[]; where?: Where }) => {
        const groups = new Map<string, { row: Row; count: number }>();
        for (const row of rows().filter((candidate) => this.matches(table, candidate, args.where))) {
          const key = args.by.map((field) => String(row[field])).join('|');
          const entry = groups.get(key) ?? { row, count: 0 };
          entry.count += 1;
          groups.set(key, entry);
        }
        return [...groups.values()].map(({ row, count }) => ({ ...Object.fromEntries(args.by.map((field) => [field, row[field]])), _count: { _all: count } }));
      },
    };
  }

  readonly watchEvent = this.delegate('watchEvent');
  readonly alert = this.delegate('alert');
  readonly watch = this.delegate('watch');
  readonly mintWatchState = this.delegate('mintWatchState');
  readonly pushSubscription = this.delegate('pushSubscription');
  readonly user = this.delegate('user');
  readonly jobRun = this.delegate('jobRun');

  async $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown> {
    const sql = strings.join('?');
    this.rawQueries.push(sql);
    return this.rawHandler(sql, values);
  }

  async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
    const sql = strings.join('?');
    this.rawQueries.push(sql);
    return Number(this.rawHandler(sql, values) ?? 0);
  }
}
