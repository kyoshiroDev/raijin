import { BenchDb, parseOrFilter, parseSelect, type BenchDbExecutor, type QuerySpec } from './bench-db';
import { MemoryDbExecutor } from './memory-executor';
import { compileQuery, compileRpc, POSTGREST_MAX_ROWS } from './sql-compiler';

/** Spécification produite par le constructeur (exécuteur espion, aucune base). */
async function specOf(build: (db: BenchDb) => PromiseLike<unknown>): Promise<QuerySpec> {
  let captured: QuerySpec | null = null;
  const exec: BenchDbExecutor = {
    execute: async (spec) => {
      captured = spec;
      return { rows: [], count: 0 };
    },
    rpc: async () => null,
  };
  await build(new BenchDb(exec));
  if (captured === null) throw new Error('aucune requête');
  return captured;
}

describe('BenchDb : analyse façon PostgREST', () => {
  it('select : colonnes, alias, flèches JSON, ressource liée', () => {
    expect(parseSelect('mint, pair_address:pool, change_1h:features->change_1h, tokens(narrative)')).toEqual([
      { kind: 'column', alias: 'mint', column: 'mint', jsonPath: [] },
      { kind: 'column', alias: 'pair_address', column: 'pool', jsonPath: [] },
      { kind: 'column', alias: 'change_1h', column: 'features', jsonPath: [{ key: 'change_1h', text: false }] },
      { kind: 'embed', alias: 'tokens', table: 'tokens', items: [{ kind: 'column', alias: 'narrative', column: 'narrative', jsonPath: [] }] },
    ]);
    expect(() => parseSelect('mint; drop table x')).toThrow();
  });

  it('or : jeu de clés (µs conservées), in, is, not, and imbriqué', () => {
    expect(parseOrFilter('detected_at.gt."2026-11-01T10:00:00.123456+00:00",and(detected_at.eq."2026-11-01T10:00:00.123456+00:00",mint.gt.ABC)')).toEqual({
      kind: 'or',
      filters: [
        { kind: 'cmp', column: 'detected_at', op: 'gt', value: '2026-11-01T10:00:00.123456+00:00' },
        {
          kind: 'and',
          filters: [
            { kind: 'cmp', column: 'detected_at', op: 'eq', value: '2026-11-01T10:00:00.123456+00:00' },
            { kind: 'cmp', column: 'mint', op: 'gt', value: 'ABC' },
          ],
        },
      ],
    });
    expect(parseOrFilter('status.in.(pending,open),locked_until.is.null').filters).toEqual([
      { kind: 'in', column: 'status', values: ['pending', 'open'] },
      { kind: 'is', column: 'locked_until', value: null },
    ]);
  });

  it('une erreur d’analyse revient à l’await (comme une réponse 400), jamais en exception', async () => {
    const res = await new BenchDb(new MemoryDbExecutor()).from('tokens').select('mint').or('mint.like.x');
    expect(res.data).toBeNull();
    expect(res.error?.code).toBe('PGRST100');
  });
});

describe('compileQuery : SQL paramétré', () => {
  it('lecture agrégée en JSON, plafond max-rows de Supabase, valeurs en paramètres', async () => {
    const spec = await specOf((db) => db.from('tokens').select('mint, symbol').gte('updated_at', 'x').order('volume_1h', { ascending: false, nullsFirst: false }).limit(5000));
    const { main } = compileQuery(spec);
    expect(main.text).toContain('json_agg');
    expect(main.text).toContain(`LIMIT ${POSTGREST_MAX_ROWS}`);
    expect(main.text).toContain('"volume_1h" DESC NULLS LAST');
    expect(main.values).toEqual(['x']);
  });

  it('upsert : json_populate_recordset, ON CONFLICT fusion ou DO NOTHING', async () => {
    const merge = compileQuery(await specOf((db) => db.from('tokens').upsert([{ mint: 'a', symbol: 's' }], { onConflict: 'mint' }))).main;
    expect(merge.text).toContain('json_populate_recordset(NULL::public."tokens"');
    expect(merge.text).toContain('ON CONFLICT ("mint") DO UPDATE SET "symbol" = EXCLUDED."symbol"');
    const ignore = compileQuery(await specOf((db) => db.from('early_buyers').upsert([{ mint: 'a', wallet: 'b' }], { onConflict: 'mint,wallet', ignoreDuplicates: true }))).main;
    expect(ignore.text).toContain('ON CONFLICT ("mint", "wallet") DO NOTHING');
    const empty = compileQuery(await specOf((db) => db.from('scan_runs').insert({}).select('id').single())).main;
    expect(empty.text).toContain('DEFAULT VALUES');
  });

  it('rpc : arguments nommés typés, jsonb sérialisé, ensemble → tableau', () => {
    const meta = { name: 'apply_alert_tracking', args: [{ name: 'p_rows', type: 'jsonb', hasDefault: false }], returnsSet: false, returnKind: 'scalar' as const };
    const q = compileRpc(meta, { p_rows: [{ id: 1 }] });
    expect(q.text).toBe('SELECT to_json(public."apply_alert_tracking"("p_rows" => $1::jsonb))::text AS value');
    expect(q.values).toEqual(['[{"id":1}]']);
    expect(() => compileRpc(meta, { p_other: 1 })).toThrow(/Could not find/);
    expect(compileRpc({ ...meta, returnsSet: true }, {}).text).toContain('json_agg');
  });
});

describe('MemoryDbExecutor', () => {
  it('upsert, update filtré, ressource liée, single / maybeSingle', async () => {
    const exec = new MemoryDbExecutor({ tables: { paper_positions: [{ id: 'p1', status: 'open' }], paper_legs: [{ id: 'l1', position_id: 'p1', status: 'open' }] } });
    const db = new BenchDb(exec);
    const pos = await db.from('paper_positions').select('id, paper_legs(id, status)').eq('id', 'p1').single();
    expect(pos.data).toEqual({ id: 'p1', paper_legs: [{ id: 'l1', status: 'open' }] });
    expect((await db.from('paper_positions').select('id').eq('id', 'none').maybeSingle()).data).toBeNull();
    expect((await db.from('paper_positions').select('id').eq('id', 'none').single()).error?.code).toBe('PGRST116');
    const upd = await db.from('paper_positions').update({ status: 'closed' }).eq('id', 'p1').eq('status', 'open').select('id');
    expect(upd.data).toEqual([{ id: 'p1' }]);
    const stale = await db.from('paper_positions').update({ status: 'x' }).eq('id', 'p1').eq('status', 'open').select('id');
    expect(stale.data).toEqual([]);
  });
});
