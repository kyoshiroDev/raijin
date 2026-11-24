import { assertIdent, DbQueryError, type DbFilter, type QuerySpec, type SelectItem } from './bench-db';
import { relationship } from './relationships';

/**
 * Traduction d'un `QuerySpec` en SQL paramétré, **comme PostgREST** : lecture agrégée par `json_agg` (types JSON de
 * Postgres : `numeric` → nombre, `timestamptz` → texte à la microseconde, `jsonb` → objet, tableaux → tableaux),
 * écritures par `json_populate_recordset` (conversion de types de Postgres, clés absentes d'une ligne → NULL comme
 * `supabase-js`), plafond de 1 000 lignes par lecture (réglage `max-rows` de Supabase, conservé pour que les
 * paginations portées lisent les mêmes lots). Identifiants validés, valeurs toujours en paramètres.
 */
export interface CompiledQuery {
  readonly text: string;
  readonly values: unknown[];
}

/** `max-rows` de l'API Supabase (valeur par défaut du projet d'origine). */
export const POSTGREST_MAX_ROWS = 1000;

const q = (ident: string): string => `"${assertIdent(ident)}"`;

class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

function filterSql(f: DbFilter, p: Params, alias: string): string {
  switch (f.kind) {
    case 'cmp': {
      const op = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[f.op];
      return `${alias}.${q(f.column)} ${op} ${p.add(f.value)}`;
    }
    case 'in':
      if (f.values.length === 0) return 'false';
      return `${alias}.${q(f.column)} = ANY(${p.add([...f.values])})`;
    case 'is':
      return `${alias}.${q(f.column)} IS ${f.value === null ? 'NULL' : f.value ? 'TRUE' : 'FALSE'}`;
    case 'not':
      return `NOT (${filterSql(f.filter, p, alias)})`;
    case 'and':
    case 'or':
      if (f.filters.length === 0) return f.kind === 'and' ? 'true' : 'false';
      return `(${f.filters.map((x) => filterSql(x, p, alias)).join(f.kind === 'and' ? ' AND ' : ' OR ')})`;
  }
}

function whereSql(filters: readonly DbFilter[], p: Params, alias = '_t'): string {
  return filters.length === 0 ? '' : ` WHERE ${filters.map((f) => filterSql(f, p, alias)).join(' AND ')}`;
}

function columnExpr(item: Extract<SelectItem, { kind: 'column' }>, alias: string): string {
  let expr = `${alias}.${q(item.column)}`;
  for (const step of item.jsonPath) expr += `${step.text ? '->>' : '->'}'${assertIdent(step.key)}'`;
  return expr;
}

function embedObject(items: readonly SelectItem[], alias: string): string {
  const pairs: string[] = [];
  for (const item of items) {
    if (item.kind !== 'column') throw new DbQueryError('ressource liée imbriquée non prise en charge', 'PGRST100');
    pairs.push(`'${assertIdent(item.alias)}', ${columnExpr(item, alias)}`);
  }
  return `json_build_object(${pairs.join(', ')})`;
}

function selectList(table: string, items: readonly SelectItem[], alias = '_t'): string {
  return items
    .map((item) => {
      if (item.kind === 'star') return `${alias}.*`;
      if (item.kind === 'column') return `${columnExpr(item, alias)} AS ${q(item.alias)}`;
      const rel = relationship(table, item.table);
      const child = `${alias}_${item.table}`.slice(0, 60);
      const join = `${child}.${q(rel.foreignColumn)} = ${alias}.${q(rel.localColumn)}`;
      const body = embedObject(item.items, child);
      return rel.cardinality === 'many'
        ? `(SELECT coalesce(json_agg(${body}), '[]'::json) FROM public.${q(item.table)} ${child} WHERE ${join}) AS ${q(item.alias)}`
        : `(SELECT ${body} FROM public.${q(item.table)} ${child} WHERE ${join} LIMIT 1) AS ${q(item.alias)}`;
    })
    .join(', ');
}

function orderSql(spec: QuerySpec): string {
  if (spec.order.length === 0) return '';
  return ` ORDER BY ${spec.order
    .map((o) => `_t.${q(o.column)} ${o.ascending ? 'ASC' : 'DESC'}${o.nullsFirst === undefined ? '' : o.nullsFirst ? ' NULLS FIRST' : ' NULLS LAST'}`)
    .join(', ')}`;
}

function aggregate(inner: string): string {
  return `SELECT coalesce(json_agg(_q), '[]'::json)::text AS rows FROM (${inner}) _q`;
}

function writtenColumns(rows: readonly Record<string, unknown>[]): string[] {
  const cols = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) cols.add(assertIdent(key));
  return [...cols];
}

/** Ligne JSON envoyée à `json_populate_record(set)` : `undefined` → absent (NULL), comme `JSON.stringify`. */
function jsonPayload(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

export interface CompiledSpec {
  readonly main: CompiledQuery;
  /** Requête de comptage (`count: 'exact'`) exécutée à part. */
  readonly count: CompiledQuery | null;
}

export function compileQuery(spec: QuerySpec): CompiledSpec {
  const table = `public.${q(spec.table)}`;
  const p = new Params();
  let count: CompiledQuery | null = null;
  if (spec.count === 'exact' && spec.action === 'select') {
    const cp = new Params();
    count = { text: `SELECT count(*)::bigint AS count FROM ${table} _t${whereSql(spec.filters, cp)}`, values: cp.values };
  }

  if (spec.action === 'select') {
    if (spec.head) return { main: { text: 'SELECT \'[]\'::text AS rows', values: [] }, count };
    const limit = Math.min(spec.limit ?? POSTGREST_MAX_ROWS, POSTGREST_MAX_ROWS);
    const inner =
      `SELECT ${selectList(spec.table, spec.select ?? [{ kind: 'star' }])} FROM ${table} _t` +
      `${whereSql(spec.filters, p)}${orderSql(spec)} LIMIT ${limit}${spec.offset ? ` OFFSET ${spec.offset}` : ''}`;
    return { main: { text: aggregate(inner), values: p.values }, count };
  }

  let write: string;
  if (spec.action === 'insert' || spec.action === 'upsert') {
    const rows = spec.rows ?? [];
    const cols = writtenColumns(rows);
    if (rows.length === 0) return { main: { text: 'SELECT \'[]\'::text AS rows', values: [] }, count };
    const list = cols.map(q).join(', ');
    // `insert({})` : ligne par défaut (PostgREST : `DEFAULT VALUES`).
    write =
      cols.length === 0
        ? `INSERT INTO ${table} AS _t DEFAULT VALUES`
        : `INSERT INTO ${table} AS _t (${list}) SELECT ${list} FROM json_populate_recordset(NULL::${table}, ${p.add(jsonPayload(rows))}::json)`;
    if (spec.action === 'upsert') {
      const conflict = spec.onConflict ?? [];
      if (conflict.length === 0) throw new DbQueryError('upsert sans onConflict', 'PGRST100');
      const target = conflict.map(q).join(', ');
      const updates = cols.filter((c) => !conflict.includes(c));
      write +=
        spec.ignoreDuplicates || updates.length === 0
          ? ` ON CONFLICT (${target}) DO NOTHING`
          : ` ON CONFLICT (${target}) DO UPDATE SET ${updates.map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(', ')}`;
    }
  } else if (spec.action === 'update') {
    const cols = writtenColumns([spec.values ?? {}]);
    if (cols.length === 0) throw new DbQueryError('update sans colonne', 'PGRST100');
    const payload = p.add(jsonPayload(spec.values));
    write =
      `UPDATE ${table} AS _t SET ${cols.map((c) => `${q(c)} = _v.${q(c)}`).join(', ')} ` +
      `FROM json_populate_record(NULL::${table}, ${payload}::json) AS _v${whereSql(spec.filters, p)}`;
  } else {
    write = `DELETE FROM ${table} AS _t${whereSql(spec.filters, p)}`;
  }

  if (spec.select === null) return { main: { text: `WITH _w AS (${write} RETURNING 1) SELECT '[]'::text AS rows, (SELECT count(*) FROM _w)::bigint AS written`, values: p.values }, count };
  const inner = `SELECT ${selectList(spec.table, spec.select)} FROM _w _t`;
  return { main: { text: `WITH _w AS (${write} RETURNING _t.*) ${aggregate(inner)}`, values: p.values }, count };
}

// --- RPC ---------------------------------------------------------------------------------------------

export interface FunctionMeta {
  readonly name: string;
  /** Arguments d'entrée (nom → type SQL, `format_type`). */
  readonly args: readonly { readonly name: string; readonly type: string; readonly hasDefault: boolean }[];
  readonly returnsSet: boolean;
  /** `void`, `composite` (ligne / record), `scalar`. */
  readonly returnKind: 'void' | 'composite' | 'scalar';
}

const SQL_TYPE = /^[a-z][a-z0-9_ ]*(\(\d+(,\d+)?\))?(\[\])?$/;

export function compileRpc(meta: FunctionMeta, args: Record<string, unknown>): CompiledQuery {
  const p = new Params();
  const known = new Map(meta.args.map((a) => [a.name, a]));
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const arg = known.get(key);
    if (!arg) throw new DbQueryError(`Could not find the function public.${meta.name} with argument ${key}`, 'PGRST202');
    if (!SQL_TYPE.test(arg.type)) throw new DbQueryError(`type refusé : ${arg.type}`, 'PGRST100');
    const isJson = arg.type === 'json' || arg.type === 'jsonb';
    const placeholder = p.add(isJson ? (value === null ? null : jsonPayload(value)) : value);
    parts.push(`${q(key)} => ${placeholder}::${arg.type}`);
  }
  const call = `public.${q(meta.name)}(${parts.join(', ')})`;
  if (meta.returnsSet) return { text: `SELECT coalesce(json_agg(_r), '[]'::json)::text AS value FROM ${call} _r`, values: p.values };
  if (meta.returnKind === 'void') return { text: `SELECT NULL::text AS value FROM (SELECT ${call}) _v`, values: p.values };
  if (meta.returnKind === 'composite') return { text: `SELECT to_json(_r)::text AS value FROM ${call} _r`, values: p.values };
  return { text: `SELECT to_json(${call})::text AS value`, values: p.values };
}
