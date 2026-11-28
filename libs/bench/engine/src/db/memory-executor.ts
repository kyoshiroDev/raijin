import { DbQueryError, type BenchDbExecutor, type DbFilter, type ExecResult, type QuerySpec, type SelectItem } from './bench-db';
import { relationship } from './relationships';
import { POSTGREST_MAX_ROWS } from './sql-compiler';

/**
 * Exécuteur en mémoire du `BenchDb` (tests des jobs portés, aucune base) : mêmes filtres, tri, plafond de
 * 1 000 lignes, ressources liées et `upsert` que le SQL compilé. Les fonctions SQL (`rpc`) sont simulées par
 * des gestionnaires fournis par le test. Chaque requête est journalisée (`queries`, `rpcCalls`).
 */
export type Row = Record<string, unknown>;
export type RpcHandler = (args: Record<string, unknown>, db: MemoryDbExecutor) => unknown;

export interface MemoryDbOptions {
  readonly tables?: Record<string, Row[]>;
  /** Valeurs par défaut à l'insertion (id, horodatages…), par table. */
  readonly defaults?: Record<string, (row: Row, seq: number) => Row>;
  readonly rpc?: Record<string, RpcHandler>;
}

const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

function comparable(v: unknown): number | string | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    if (ISO.test(v)) {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
    if (/^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(v)) return Number(v);
    return v;
  }
  return JSON.stringify(v);
}

function compare(a: unknown, b: unknown): number {
  const x = comparable(a);
  const y = comparable(b);
  if (x === null || y === null) return Number.NaN;
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  const sx = String(x);
  const sy = String(y);
  return sx < sy ? -1 : sx > sy ? 1 : 0;
}

function matches(row: Row, f: DbFilter): boolean {
  switch (f.kind) {
    case 'cmp': {
      const c = compare(row[f.column], f.value);
      if (Number.isNaN(c)) return false;
      return { eq: c === 0, neq: c !== 0, gt: c > 0, gte: c >= 0, lt: c < 0, lte: c <= 0 }[f.op];
    }
    case 'in':
      return f.values.some((v) => compare(row[f.column], v) === 0);
    case 'is': {
      const v = row[f.column];
      return f.value === null ? v === null || v === undefined : v === f.value;
    }
    case 'not':
      return !matches(row, f.filter);
    case 'and':
      return f.filters.every((x) => matches(row, x));
    case 'or':
      return f.filters.some((x) => matches(row, x));
  }
}

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

export class MemoryDbExecutor implements BenchDbExecutor {
  readonly tables = new Map<string, Row[]>();
  readonly queries: QuerySpec[] = [];
  readonly rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  private seq = 0;

  constructor(private readonly options: MemoryDbOptions = {}) {
    for (const [name, rows] of Object.entries(options.tables ?? {})) this.tables.set(name, rows.map((r) => clone(r)));
  }

  table(name: string): Row[] {
    let rows = this.tables.get(name);
    if (!rows) {
      rows = [];
      this.tables.set(name, rows);
    }
    return rows;
  }

  private project(table: string, row: Row, items: readonly SelectItem[]): Row {
    const out: Row = {};
    for (const item of items) {
      if (item.kind === 'star') Object.assign(out, clone(row));
      else if (item.kind === 'column') {
        let v: unknown = row[item.column];
        for (const step of item.jsonPath) {
          v = v && typeof v === 'object' ? (v as Row)[step.key] : null;
          if (step.text && v !== null && v !== undefined) v = typeof v === 'string' ? v : JSON.stringify(v);
        }
        out[item.alias] = v === undefined ? null : clone(v);
      } else {
        const rel = relationship(table, item.table);
        const linked = this.table(item.table).filter((r) => compare(r[rel.foreignColumn], row[rel.localColumn]) === 0);
        const shaped = linked.map((r) => this.project(item.table, r, item.items));
        out[item.alias] = rel.cardinality === 'many' ? shaped : (shaped[0] ?? null);
      }
    }
    return out;
  }

  private sorted(rows: Row[], spec: QuerySpec): Row[] {
    if (spec.order.length === 0) return rows;
    return [...rows].sort((a, b) => {
      for (const o of spec.order) {
        const va = a[o.column];
        const vb = b[o.column];
        const na = va === null || va === undefined;
        const nb = vb === null || vb === undefined;
        if (na || nb) {
          if (na && nb) continue;
          const nullsFirst = o.nullsFirst ?? !o.ascending;
          return na ? (nullsFirst ? -1 : 1) : nullsFirst ? 1 : -1;
        }
        const c = compare(va, vb);
        if (c !== 0) return o.ascending ? c : -c;
      }
      return 0;
    });
  }

  async execute(spec: QuerySpec): Promise<ExecResult> {
    this.queries.push(clone(spec));
    const rows = this.table(spec.table);
    const where = (r: Row) => spec.filters.every((f) => matches(r, f));
    const count = spec.count === 'exact' ? rows.filter(where).length : null;

    if (spec.action === 'select') {
      if (spec.head) return { rows: [], count };
      const limit = Math.min(spec.limit ?? POSTGREST_MAX_ROWS, POSTGREST_MAX_ROWS);
      const offset = spec.offset ?? 0;
      const picked = this.sorted(rows.filter(where), spec).slice(offset, offset + limit);
      return { rows: picked.map((r) => this.project(spec.table, r, spec.select ?? [{ kind: 'star' }])), count };
    }

    let written: Row[] = [];
    if (spec.action === 'insert' || spec.action === 'upsert') {
      const keys = new Set<string>();
      for (const r of spec.rows ?? []) for (const k of Object.keys(r)) keys.add(k);
      for (const input of spec.rows ?? []) {
        const full: Row = {};
        for (const k of keys) full[k] = input[k] === undefined ? null : clone(input[k]);
        const conflict = spec.onConflict ?? [];
        const existing =
          spec.action === 'upsert' ? rows.find((r) => conflict.every((c) => compare(r[c], full[c]) === 0)) : undefined;
        if (existing) {
          if (spec.ignoreDuplicates) continue;
          Object.assign(existing, full);
          written.push(existing);
          continue;
        }
        const withDefaults = this.options.defaults?.[spec.table]?.(full, ++this.seq) ?? full;
        const row = { ...withDefaults, ...Object.fromEntries(Object.entries(full).filter(([, v]) => v !== null)) };
        for (const k of keys) if (!(k in row)) row[k] = null;
        rows.push(row);
        written.push(row);
      }
    } else if (spec.action === 'update') {
      written = rows.filter(where);
      for (const r of written) Object.assign(r, clone(spec.values ?? {}));
    } else {
      written = rows.filter(where);
      this.tables.set(
        spec.table,
        rows.filter((r) => !written.includes(r)),
      );
    }
    if (spec.select === null) return { rows: [], count };
    return { rows: written.map((r) => this.project(spec.table, r, spec.select ?? [{ kind: 'star' }])), count };
  }

  async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.rpcCalls.push({ name, args: clone(args) });
    const handler = this.options.rpc?.[name];
    if (!handler) throw new DbQueryError(`Could not find the function public.${name}`, 'PGRST202');
    return clone(await handler(args, this));
  }
}
