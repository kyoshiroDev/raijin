/**
 * Port Node du client de base des Edge Functions (`supabase-js` → PostgREST) : même interface fluide, mêmes
 * résultats `{ data, error, count }`, pour que le code porté garde **ses requêtes à l'identique** (BENCH.md §2,
 * « comportement inchangé »). Les requêtes sont décrites par un `QuerySpec` et exécutées par un `BenchDbExecutor` :
 * SQL paramétré sur `raijin_bench` en production (`@raijin/bench-prisma`), tables en mémoire dans les tests.
 *
 * Sous-ensemble couvert (celui des 7 fonctions, vérifié par grep) : `select` (colonnes, alias `a:b`, `col->clé`,
 * ressource liée `table(cols)`, `count: 'exact'`, `head`), `insert`, `upsert` (`onConflict`, `ignoreDuplicates`),
 * `update`, `delete`, filtres `eq neq gt gte lt lte in is not or`, `order`, `limit`, `range`, `single`,
 * `maybeSingle`, et `rpc(nom, args)`.
 */

export interface DbError {
  readonly message: string;
  readonly code?: string;
  readonly details?: string | null;
  readonly hint?: string | null;
}

/** Résultat au format `supabase-js` (`data` est `null` en cas d'erreur). */
export interface DbResult<T = any> {
  readonly data: T | null;
  readonly error: DbError | null;
  readonly count?: number | null;
  readonly status?: number;
}

export type CmpOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';

export type DbFilter =
  | { readonly kind: 'cmp'; readonly column: string; readonly op: CmpOp; readonly value: unknown }
  | { readonly kind: 'in'; readonly column: string; readonly values: readonly unknown[] }
  | { readonly kind: 'is'; readonly column: string; readonly value: null | boolean }
  | { readonly kind: 'and' | 'or'; readonly filters: readonly DbFilter[] }
  | { readonly kind: 'not'; readonly filter: DbFilter };

/** Élément de `select()` : colonne (éventuellement `col->clé`) ou ressource liée. */
export type SelectItem =
  | { readonly kind: 'column'; readonly alias: string; readonly column: string; readonly jsonPath: readonly { readonly key: string; readonly text: boolean }[] }
  | { readonly kind: 'embed'; readonly alias: string; readonly table: string; readonly items: readonly SelectItem[] }
  | { readonly kind: 'star' };

export interface OrderSpec {
  readonly column: string;
  readonly ascending: boolean;
  /** `undefined` : ordre par défaut de Postgres (NULLS LAST en ASC, NULLS FIRST en DESC). */
  readonly nullsFirst?: boolean;
}

export type QueryAction = 'select' | 'insert' | 'upsert' | 'update' | 'delete';

export interface QuerySpec {
  readonly table: string;
  readonly action: QueryAction;
  /** Colonnes lues (`select`) ou renvoyées (`RETURNING`) ; `null` : écriture sans retour. */
  readonly select: readonly SelectItem[] | null;
  readonly count: 'exact' | null;
  readonly head: boolean;
  /** `insert` / `upsert`. */
  readonly rows?: readonly Record<string, unknown>[];
  /** `update`. */
  readonly values?: Record<string, unknown>;
  readonly onConflict?: readonly string[];
  readonly ignoreDuplicates?: boolean;
  readonly filters: readonly DbFilter[];
  readonly order: readonly OrderSpec[];
  readonly limit: number | null;
  readonly offset: number | null;
}

export interface ExecResult {
  readonly rows: Record<string, unknown>[];
  readonly count: number | null;
}

/** Exécuteur d'un `QuerySpec` (SQL ou mémoire). Lève `DbQueryError` (ou toute erreur portant `message`/`code`). */
export interface BenchDbExecutor {
  execute(spec: QuerySpec): Promise<ExecResult>;
  /** Appel d'une fonction SQL `public.<name>` à arguments nommés ; renvoie la valeur JSON de PostgREST. */
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export class DbQueryError extends Error implements DbError {
  constructor(
    message: string,
    readonly code?: string,
    readonly details: string | null = null,
    readonly hint: string | null = null,
  ) {
    super(message);
    this.name = 'DbQueryError';
  }
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export function assertIdent(name: string): string {
  if (!IDENT.test(name)) throw new DbQueryError(`identifiant refusé : ${name.slice(0, 40)}`, 'PGRST100');
  return name;
}

function toDbError(e: unknown): DbError {
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
    const o = e as { message: string; code?: unknown; details?: unknown; hint?: unknown };
    return {
      message: o.message,
      code: typeof o.code === 'string' ? o.code : undefined,
      details: typeof o.details === 'string' ? o.details : null,
      hint: typeof o.hint === 'string' ? o.hint : null,
    };
  }
  return { message: String(e) };
}

// --- Analyse de `select('…')` -------------------------------------------------------------------

function splitTopLevel(text: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '(') depth++;
    if (!quoted && ch === ')') depth--;
    if (!quoted && depth === 0 && ch === sep) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (depth !== 0 || quoted) throw new DbQueryError(`liste mal formée : ${text.slice(0, 60)}`, 'PGRST100');
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

export function parseSelect(text: string): SelectItem[] {
  return splitTopLevel(text).map((raw): SelectItem => {
    if (raw === '*') return { kind: 'star' };
    const embed = /^(?:([a-z_][a-z0-9_]*):)?([a-z_][a-z0-9_]*)\((.*)\)$/s.exec(raw);
    if (embed) {
      const table = assertIdent(embed[2]!);
      return { kind: 'embed', alias: embed[1] ?? table, table, items: parseSelect(embed[3]!) };
    }
    const m = /^(?:([a-z_][a-z0-9_]*):)?([a-z_][a-z0-9_]*)((?:->>?[a-z0-9_]+)*)$/.exec(raw);
    if (!m) throw new DbQueryError(`colonne refusée : ${raw.slice(0, 60)}`, 'PGRST100');
    const column = assertIdent(m[2]!);
    const jsonPath: { key: string; text: boolean }[] = [];
    for (const step of m[3]!.matchAll(/(->>?)([a-z0-9_]+)/g)) jsonPath.push({ key: step[2]!, text: step[1] === '->>' });
    const last = jsonPath[jsonPath.length - 1];
    return { kind: 'column', alias: m[1] ?? (last ? last.key : column), column, jsonPath };
  });
}

// --- Analyse des filtres PostgREST (`or('a.eq.1,and(b.is.null,c.gt."x")')`) ------------------------

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function parseCondition(text: string): DbFilter {
  const group = /^(not\.)?(and|or)\((.*)\)$/s.exec(text);
  if (group) {
    const inner: DbFilter = { kind: group[2] as 'and' | 'or', filters: splitTopLevel(group[3]!).map(parseCondition) };
    return group[1] ? { kind: 'not', filter: inner } : inner;
  }
  const m = /^([a-z_][a-z0-9_]*)\.(not\.)?(eq|neq|gt|gte|lt|lte|is|in)\.(.*)$/s.exec(text);
  if (!m) throw new DbQueryError(`filtre refusé : ${text.slice(0, 80)}`, 'PGRST100');
  const column = assertIdent(m[1]!);
  const op = m[3];
  const raw = m[4];
  let filter: DbFilter;
  if (op === 'is') {
    const v = raw!.toLowerCase();
    if (v !== 'null' && v !== 'true' && v !== 'false') throw new DbQueryError(`valeur is refusée : ${raw}`, 'PGRST100');
    filter = { kind: 'is', column, value: v === 'null' ? null : v === 'true' };
  } else if (op === 'in') {
    const list = /^\((.*)\)$/s.exec(raw!);
    if (!list) throw new DbQueryError(`liste in refusée : ${raw!.slice(0, 60)}`, 'PGRST100');
    filter = { kind: 'in', column, values: splitTopLevel(list[1]!).map(unquote) };
  } else {
    filter = { kind: 'cmp', column, op: op as CmpOp, value: unquote(raw!) };
  }
  return m[2] ? { kind: 'not', filter } : filter;
}

/** Filtre `or=(…)` de PostgREST (sans les parenthèses externes, comme `supabase-js`). */
export function parseOrFilter(text: string): { readonly kind: 'or'; readonly filters: readonly DbFilter[] } {
  return { kind: 'or', filters: splitTopLevel(text).map(parseCondition) };
}

// --- Constructeur de requêtes ----------------------------------------------------------------------

interface BuilderState {
  action: QueryAction;
  select: SelectItem[] | null;
  count: 'exact' | null;
  head: boolean;
  rows?: Record<string, unknown>[];
  values?: Record<string, unknown>;
  onConflict?: string[];
  ignoreDuplicates?: boolean;
  filters: DbFilter[];
  order: OrderSpec[];
  limit: number | null;
  offset: number | null;
  single: 'single' | 'maybe' | null;
  /** Erreur d'analyse (filtre ou colonnes) : renvoyée à l'`await`, comme une réponse 400 de PostgREST. */
  error: unknown;
}

export class QueryBuilder<T = any> implements PromiseLike<DbResult<T>> {
  private readonly state: BuilderState = {
    action: 'select',
    select: null,
    count: null,
    head: false,
    filters: [],
    order: [],
    limit: null,
    offset: null,
    single: null,
    error: null,
  };

  private guard(fn: () => void): this {
    try {
      fn();
    } catch (e) {
      this.state.error ??= e;
    }
    return this;
  }

  constructor(
    private readonly executor: BenchDbExecutor,
    private readonly table: string,
  ) {
    assertIdent(table);
  }

  select(columns = '*', options: { count?: 'exact'; head?: boolean } = {}): QueryBuilder<T> {
    this.guard(() => {
      this.state.select = parseSelect(columns);
    });
    if (options.count) this.state.count = options.count;
    if (options.head) this.state.head = true;
    return this;
  }

  insert(rows: object | readonly object[]): QueryBuilder<T> {
    this.state.action = 'insert';
    this.state.rows = (Array.isArray(rows) ? [...rows] : [rows]) as Record<string, unknown>[];
    return this;
  }

  upsert(
    rows: object | readonly object[],
    options: { onConflict?: string; ignoreDuplicates?: boolean } = {},
  ): QueryBuilder<T> {
    this.state.action = 'upsert';
    this.state.rows = (Array.isArray(rows) ? [...rows] : [rows]) as Record<string, unknown>[];
    this.state.onConflict = options.onConflict ? options.onConflict.split(',').map((c) => assertIdent(c.trim())) : undefined;
    this.state.ignoreDuplicates = options.ignoreDuplicates === true;
    return this;
  }

  update(values: object): QueryBuilder<T> {
    this.state.action = 'update';
    this.state.values = values as Record<string, unknown>;
    return this;
  }

  delete(): QueryBuilder<T> {
    this.state.action = 'delete';
    return this;
  }

  private cmp(op: CmpOp, column: string, value: unknown): QueryBuilder<T> {
    this.state.filters.push({ kind: 'cmp', column: assertIdent(column), op, value });
    return this;
  }

  eq(column: string, value: unknown): QueryBuilder<T> {
    return this.cmp('eq', column, value);
  }
  neq(column: string, value: unknown): QueryBuilder<T> {
    return this.cmp('neq', column, value);
  }
  gt(column: string, value: unknown): QueryBuilder<T> {
    return this.cmp('gt', column, value);
  }
  gte(column: string, value: unknown): QueryBuilder<T> {
    return this.cmp('gte', column, value);
  }
  lt(column: string, value: unknown): QueryBuilder<T> {
    return this.cmp('lt', column, value);
  }
  lte(column: string, value: unknown): QueryBuilder<T> {
    return this.cmp('lte', column, value);
  }

  in(column: string, values: readonly unknown[]): QueryBuilder<T> {
    this.state.filters.push({ kind: 'in', column: assertIdent(column), values: [...values] });
    return this;
  }

  is(column: string, value: null | boolean): QueryBuilder<T> {
    this.state.filters.push({ kind: 'is', column: assertIdent(column), value });
    return this;
  }

  /** `not(col, 'is', null)` (seule forme utilisée) et `not(col, op, valeur)`. */
  not(column: string, operator: string, value: unknown): QueryBuilder<T> {
    const text = operator === 'in' ? `${column}.in.${String(value)}` : `${column}.${operator}.${value === null ? 'null' : String(value)}`;
    return this.guard(() => {
      this.state.filters.push({ kind: 'not', filter: parseOrFilter(text).filters[0]! });
    });
  }

  or(text: string): QueryBuilder<T> {
    return this.guard(() => {
      this.state.filters.push(parseOrFilter(text));
    });
  }

  order(column: string, options: { ascending?: boolean; nullsFirst?: boolean } = {}): QueryBuilder<T> {
    this.state.order.push({ column: assertIdent(column), ascending: options.ascending !== false, nullsFirst: options.nullsFirst });
    return this;
  }

  limit(count: number): QueryBuilder<T> {
    this.state.limit = Math.max(0, Math.floor(count));
    return this;
  }

  range(from: number, to: number): QueryBuilder<T> {
    this.state.offset = Math.max(0, Math.floor(from));
    this.state.limit = Math.max(0, Math.floor(to) - Math.floor(from) + 1);
    return this;
  }

  single(): QueryBuilder<T> {
    this.state.single = 'single';
    return this;
  }

  maybeSingle(): QueryBuilder<T> {
    this.state.single = 'maybe';
    return this;
  }

  /** Spécification figée (exposée pour les tests du compilateur SQL). */
  spec(): QuerySpec {
    const s = this.state;
    const writes = s.action !== 'select';
    return {
      table: this.table,
      action: s.action,
      select: writes ? s.select : (s.select ?? [{ kind: 'star' }]),
      count: s.count,
      head: s.head,
      rows: s.rows,
      values: s.values,
      onConflict: s.onConflict,
      ignoreDuplicates: s.ignoreDuplicates,
      filters: s.filters,
      order: s.order,
      limit: s.limit,
      offset: s.offset,
    };
  }

  private async run(): Promise<DbResult<T>> {
    if (this.state.error !== null) return { data: null, error: toDbError(this.state.error), count: null, status: 400 };
    try {
      const { rows, count } = await this.executor.execute(this.spec());
      const wantsRows = this.state.action === 'select' ? !this.state.head : this.state.select !== null;
      if (!wantsRows) return { data: null, error: null, count, status: 200 };
      if (this.state.single !== null) {
        if (rows.length === 1) return { data: rows[0] as T, error: null, count, status: 200 };
        if (rows.length === 0 && this.state.single === 'maybe') return { data: null, error: null, count, status: 200 };
        return {
          data: null,
          error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116', details: `${rows.length} rows`, hint: null },
          count,
          status: 406,
        };
      }
      return { data: rows as T, error: null, count, status: 200 };
    } catch (e) {
      return { data: null, error: toDbError(e), count: null, status: 400 };
    }
  }

  then<R1 = DbResult<T>, R2 = never>(
    onfulfilled?: ((value: DbResult<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onfulfilled, onrejected);
  }
}

/** Client de base du code porté (remplace `createClient(SUPABASE_URL, SERVICE_ROLE_KEY)`). */
export class BenchDb {
  constructor(readonly executor: BenchDbExecutor) {}

  from<T = any>(table: string): QueryBuilder<T> {
    return new QueryBuilder<T>(this.executor, table);
  }

  async rpc<T = any>(name: string, args: object = {}): Promise<DbResult<T>> {
    try {
      assertIdent(name);
      return { data: (await this.executor.rpc(name, args as Record<string, unknown>)) as T, error: null, status: 200 };
    } catch (e) {
      return { data: null, error: toDbError(e), status: 400 };
    }
  }
}

/** Alias du type `SupabaseClient` du code d'origine. */
export type SupabaseClient = BenchDb;
