import { randomUUID } from 'node:crypto';

/**
 * Base en mémoire minimale des tests de `api-trial` : tables `user`, `productEvent`, `jobRun` avec les
 * filtres utilisés par les services (égalité, `null`, `lt`, `lte`, `gt`, `gte`, `not`) et `$transaction`.
 */
type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function value(v: unknown): unknown {
  return v instanceof Date ? v.getTime() : v;
}

function matchField(actual: unknown, condition: unknown): boolean {
  if (condition === null) return actual === null || actual === undefined;
  if (condition instanceof Date || typeof condition !== 'object') return value(actual) === value(condition);
  for (const [op, arg] of Object.entries(condition as Record<string, unknown>)) {
    const a = value(actual) as number;
    const b = value(arg) as number;
    if (op === 'lt' && !(actual != null && a < b)) return false;
    if (op === 'lte' && !(actual != null && a <= b)) return false;
    if (op === 'gt' && !(actual != null && a > b)) return false;
    if (op === 'gte' && !(actual != null && a >= b)) return false;
    if (op === 'not' && matchField(actual, arg)) return false;
  }
  return true;
}

export function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, condition]) => condition === undefined || matchField(row[key], condition));
}

function pick(row: Row | undefined, select?: Record<string, unknown>): Row | null {
  if (!row) return null;
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));
}

export class MemoryTable {
  readonly rows: Row[] = [];

  async findMany(args: { where?: Where; select?: Record<string, unknown>; take?: number } = {}) {
    return this.rows.filter((row) => matches(row, args.where)).slice(0, args.take ?? Infinity).map((row) => pick(row, args.select));
  }
  async findFirst(args: { where?: Where; select?: Record<string, unknown> } = {}) {
    return pick(this.rows.find((row) => matches(row, args.where)), args.select);
  }
  async findUnique(args: { where: Where; select?: Record<string, unknown> }) {
    return pick(this.rows.find((row) => matches(row, args.where)), args.select);
  }
  async count(args: { where?: Where } = {}) {
    return this.rows.filter((row) => matches(row, args.where)).length;
  }
  async create(args: { data: Row; select?: Record<string, unknown> }) {
    const row = { id: randomUUID(), createdAt: new Date(), ...args.data };
    this.rows.push(row);
    return pick(row, args.select);
  }
  async update(args: { where: Where; data: Row }) {
    const row = this.rows.find((candidate) => matches(candidate, args.where));
    if (!row) throw Object.assign(new Error('Not found'), { code: 'P2025' });
    Object.assign(row, args.data);
    return { ...row };
  }
  async updateMany(args: { where: Where; data: Row }) {
    const rows = this.rows.filter((row) => matches(row, args.where));
    for (const row of rows) Object.assign(row, args.data);
    return { count: rows.length };
  }
}

export class MemoryDb {
  readonly user = new MemoryTable();
  readonly productEvent = new MemoryTable();
  readonly jobRun = new MemoryTable();
  /** Échec simulé de la prochaine transaction (rollback). */
  failNextTransaction = false;

  async $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    if (this.failNextTransaction) {
      this.failNextTransaction = false;
      throw Object.assign(new Error('deadlock'), { code: 'P2034' });
    }
    // Rollback simulé : instantané des lignes, restauré si la fonction échoue.
    const snapshot = (table: MemoryTable) => table.rows.map((row) => ({ ...row }));
    const users = snapshot(this.user);
    const events = snapshot(this.productEvent);
    try {
      return await fn(this);
    } catch (error) {
      this.user.rows.splice(0, this.user.rows.length, ...users);
      this.productEvent.rows.splice(0, this.productEvent.rows.length, ...events);
      throw error;
    }
  }

  addUser(overrides: Row = {}): Row {
    const row: Row = {
      id: randomUUID(),
      email: `${randomUUID().slice(0, 8)}@exemple.fr`,
      plan: 'FREE',
      emailVerifiedAt: new Date('2026-11-01T00:00:00Z'),
      trialStatus: 'NONE',
      trialStartedAt: null,
      trialEndsAt: null,
      notifyTrialEmails: true,
      trialDay1MailAt: null,
      trialDayMinus2MailAt: null,
      trialEndMailAt: null,
      trialEndScreenSeenAt: null,
      ...overrides,
    };
    this.user.rows.push(row);
    return row;
  }
}
