import { randomUUID } from 'node:crypto';

/**
 * Faux Prisma en mémoire pour les tests unitaires de l'abonnement (aucune base) : tables `user`,
 * `subscription`, `stripeEvent`, `productEvent` ; égalité et `in` ; `orderBy` sur une date ;
 * `$transaction` avec **rollback** (instantané restauré si la fonction lève) ; `createMany({ skipDuplicates })`
 * sur la clé primaire ; `$queryRaw` (verrous) sans effet.
 */
type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const UNIQUE: Readonly<Record<string, readonly string[]>> = {
  user: ['id', 'email', 'stripeCustomerId'],
  subscription: ['id', 'stripeSubscriptionId'],
  stripeEvent: ['id'],
  productEvent: ['id'],
};

class UniqueError extends Error {
  readonly code = 'P2002';
}

function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (condition === undefined) return true;
    const value = row[key];
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      const ops = condition as Record<string, unknown>;
      if ('in' in ops) return (ops['in'] as unknown[]).includes(value);
      return true;
    }
    if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
    return value === condition;
  });
}

function pick(row: Row | undefined, select?: Record<string, unknown>): Row | null {
  if (!row) return null;
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key] ?? null]));
}

function clone(tables: Record<string, Row[]>): Record<string, Row[]> {
  return Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]));
}

export class MemoryBillingPrisma {
  tables: Record<string, Row[]> = { user: [], subscription: [], stripeEvent: [], productEvent: [] };
  /** Requêtes brutes reçues (verrous), pour les tests. */
  readonly rawQueries: string[] = [];
  /** Lève dans la transaction à l'appel n° N de `subscription.upsert` (test du rollback). */
  failOnUpsert = 0;
  private upserts = 0;
  private sequence = 0;

  private check(table: string, row: Row, except?: Row): void {
    for (const field of UNIQUE[table] ?? []) {
      const value = row[field];
      if (value === null || value === undefined) continue;
      if ((this.tables[table] ?? []).some((other) => other !== except && other[field] === value)) throw new UniqueError(`${table}.${field}`);
    }
  }

  private insert(table: string, data: Row): Row {
    const now = new Date(Date.UTC(2026, 10, 22) + ++this.sequence);
    const row: Row = { id: randomUUID(), createdAt: now, updatedAt: now, ...data };
    if (table === 'stripeEvent') row['processedAt'] = now;
    this.check(table, row);
    (this.tables[table] ??= []).push(row);
    return row;
  }

  private delegate(table: string) {
    const rows = () => (this.tables[table] ??= []);
    const update = (row: Row, data: Row) => {
      const next = { ...row, ...data, updatedAt: new Date(Date.UTC(2026, 10, 22) + ++this.sequence) };
      this.check(table, next, row);
      Object.assign(row, next);
      return row;
    };
    return {
      findUnique: async ({ where, select }: { where: Where; select?: Record<string, unknown> }) => pick(rows().find((row) => matches(row, where)), select),
      findFirst: async ({ where, select, orderBy }: { where?: Where; select?: Record<string, unknown>; orderBy?: unknown }) => {
        const list = rows().filter((row) => matches(row, where));
        const order = (Array.isArray(orderBy) ? orderBy[0] : orderBy) as Record<string, 'asc' | 'desc'> | undefined;
        const [field, direction] = order ? (Object.entries(order)[0] ?? []) : [];
        if (field) list.sort((a, b) => ((a[field] as Date).getTime() - (b[field] as Date).getTime()) * (direction === 'desc' ? -1 : 1));
        return pick(list[0], select);
      },
      findMany: async ({ where }: { where?: Where } = {}) => rows().filter((row) => matches(row, where)).map((row) => ({ ...row })),
      count: async ({ where }: { where?: Where } = {}) => rows().filter((row) => matches(row, where)).length,
      create: async ({ data }: { data: Row }) => ({ ...this.insert(table, data) }),
      createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const item of data) {
          try {
            this.insert(table, item);
            count += 1;
          } catch (error) {
            if (!(skipDuplicates && error instanceof UniqueError)) throw error;
          }
        }
        return { count };
      },
      update: async ({ where, data }: { where: Where; data: Row }) => {
        const row = rows().find((candidate) => matches(candidate, where));
        if (!row) throw new Error(`${table} introuvable`);
        return { ...update(row, data) };
      },
      updateMany: async ({ where, data }: { where: Where; data: Row }) => {
        const list = rows().filter((candidate) => matches(candidate, where));
        for (const row of list) update(row, data);
        return { count: list.length };
      },
      deleteMany: async ({ where }: { where: Where }) => {
        const before = rows().length;
        this.tables[table] = rows().filter((row) => !matches(row, where));
        return { count: before - rows().length };
      },
      upsert: async ({ where, create, update: changes }: { where: Where; create: Row; update: Row }) => {
        this.upserts += 1;
        if (this.failOnUpsert === this.upserts) throw new Error('panne simulée');
        const row = rows().find((candidate) => matches(candidate, where));
        return row ? { ...update(row, changes) } : { ...this.insert(table, create) };
      },
    };
  }

  readonly user = this.delegate('user');
  readonly subscription = this.delegate('subscription');
  readonly stripeEvent = this.delegate('stripeEvent');
  readonly productEvent = this.delegate('productEvent');

  async $queryRaw(strings: TemplateStringsArray): Promise<unknown[]> {
    this.rawQueries.push(strings.join('?'));
    return [];
  }

  async $transaction<T>(run: (tx: this) => Promise<T>): Promise<T> {
    const snapshot = clone(this.tables);
    try {
      return await run(this);
    } catch (error) {
      this.tables = snapshot;
      throw error;
    }
  }

  /** Ajoute un utilisateur (valeurs par défaut du schéma). */
  addUser(data: Row = {}): Row {
    return this.insert('user', {
      email: `u${this.sequence}@exemple.fr`,
      emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z'),
      plan: 'FREE',
      trialStatus: 'NONE',
      trialStartedAt: null,
      trialEndsAt: null,
      trialEndScreenSeenAt: null,
      stripeCustomerId: null,
      ...data,
    });
  }
}
