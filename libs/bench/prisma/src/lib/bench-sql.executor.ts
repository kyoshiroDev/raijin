import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  BenchDb,
  compileQuery,
  compileRpc,
  DbQueryError,
  type BenchDbExecutor,
  type ExecResult,
  type FunctionMeta,
  type QuerySpec,
} from '@raijin/bench-engine';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { BENCH_PRISMA_OPTIONS, type BenchPrismaOptions } from './bench-prisma.options';

/** Connexion minimale (pool `pg` ou client d'une transaction). */
export interface SqlRunner {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

function toDbError(e: unknown): DbQueryError {
  if (e instanceof DbQueryError) return e;
  const o = (e ?? {}) as { message?: unknown; code?: unknown; detail?: unknown; hint?: unknown };
  return new DbQueryError(
    typeof o.message === 'string' ? o.message : 'erreur de base',
    typeof o.code === 'string' ? o.code : undefined,
    typeof o.detail === 'string' ? o.detail : null,
    typeof o.hint === 'string' ? o.hint : null,
  );
}

const FUNCTION_META_SQL = `
select p.proname as name, p.proretset as returns_set, format_type(p.prorettype, null) as return_type,
       t.typtype as return_typtype, p.pronargs as nargs, p.pronargdefaults as nargdefaults,
       coalesce(p.proargnames, '{}') as arg_names, coalesce(p.proargmodes::text[], '{}') as arg_modes,
       coalesce((select array_agg(format_type(x, null) order by ord) from unnest(p.proargtypes) with ordinality u(x, ord)), '{}') as arg_types
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_type t on t.oid = p.prorettype
 where n.nspname = 'public' and p.proname = $1`;

interface MetaRow {
  name: string;
  returns_set: boolean;
  return_type: string;
  return_typtype: string;
  nargs: number;
  nargdefaults: number;
  arg_names: string[];
  arg_modes: string[];
  arg_types: string[];
}

export function functionMetaFromRow(row: MetaRow): FunctionMeta {
  const inNames = row.arg_modes.length === 0 ? row.arg_names : row.arg_names.filter((_n, i) => ['i', 'b', 'v'].includes(row.arg_modes[i] ?? 'i'));
  const args = row.arg_types.map((type, i) => ({ name: inNames[i] ?? `$${i + 1}`, type, hasDefault: i >= row.nargs - row.nargdefaults }));
  const returnKind = row.return_type === 'void' ? 'void' : row.return_typtype === 'c' || row.return_type === 'record' ? 'composite' : 'scalar';
  return { name: row.name, args, returnsSet: row.returns_set, returnKind };
}

/**
 * Exécuteur SQL du `BenchDb` (client compatible `supabase-js` du code porté, `@raijin/bench-engine`) sur
 * `raijin_bench`, utilisateur `raijin_bench` seul. Requêtes compilées comme PostgREST (`json_agg`, types JSON de
 * Postgres) ; fonctions SQL conservées à l'identique (T5) appelées à arguments nommés, types lus dans `pg_proc`.
 */
export class SqlBenchDbExecutor implements BenchDbExecutor {
  private readonly meta = new Map<string, Promise<FunctionMeta>>();

  constructor(private readonly runner: SqlRunner) {}

  async execute(spec: QuerySpec): Promise<ExecResult> {
    const compiled = compileQuery(spec);
    try {
      const main = await this.runner.query<{ rows: string }>(compiled.main.text, compiled.main.values);
      const rows = JSON.parse(main.rows[0]?.rows ?? '[]') as Record<string, unknown>[];
      let count: number | null = null;
      if (compiled.count) {
        const c = await this.runner.query<{ count: string }>(compiled.count.text, compiled.count.values);
        count = Number(c.rows[0]?.count ?? 0);
      }
      return { rows, count };
    } catch (e) {
      throw toDbError(e);
    }
  }

  private functionMeta(name: string): Promise<FunctionMeta> {
    let pending = this.meta.get(name);
    if (!pending) {
      pending = this.runner.query<MetaRow & QueryResultRow>(FUNCTION_META_SQL, [name]).then((r) => {
        if (r.rows.length !== 1) throw new DbQueryError(`Could not find the function public.${name}`, 'PGRST202');
        return functionMetaFromRow(r.rows[0] as MetaRow);
      });
      pending.catch(() => this.meta.delete(name));
      this.meta.set(name, pending);
    }
    return pending;
  }

  async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      const compiled = compileRpc(await this.functionMeta(name), args);
      const res = await this.runner.query<{ value: string | null }>(compiled.text, compiled.values);
      const value = res.rows[0]?.value ?? null;
      return value === null ? null : JSON.parse(value);
    } catch (e) {
      throw toDbError(e);
    }
  }
}

/**
 * Pool `pg` du code porté (à côté du client Prisma, même URL, jamais journalisée) et `BenchDb` prêt à l'emploi.
 * `transaction()` sert les endpoints transactionnels (ex-RPC du front).
 */
@Injectable()
export class BenchSqlService implements OnModuleDestroy {
  private readonly logger = new Logger('BenchSql');
  readonly pool: Pool;
  readonly db: BenchDb;

  constructor(@Inject(BENCH_PRISMA_OPTIONS) options: BenchPrismaOptions) {
    this.pool = new Pool({ connectionString: options.databaseUrl, max: 6, idleTimeoutMillis: 30_000, application_name: 'raijin-bench-api' });
    this.pool.on('error', (error) => this.logger.warn(`Connexion SQL perdue (${(error as { code?: string }).code ?? 'erreur'})`));
    this.db = new BenchDb(new SqlBenchDbExecutor(this.pool));
  }

  query<R extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<{ rows: R[] }> {
    return this.pool.query<R>(text, values);
  }

  /** Transaction : `fn` reçoit un `SqlRunner` et un `BenchDb` liés au même client. */
  async transaction<T>(fn: (tx: SqlRunner, db: BenchDb) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client, new BenchDb(new SqlBenchDbExecutor(client)));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }
}
