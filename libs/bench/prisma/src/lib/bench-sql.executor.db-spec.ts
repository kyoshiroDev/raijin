import { BenchDb } from '@raijin/bench-engine';
import { Client } from 'pg';
import { SqlBenchDbExecutor } from './bench-sql.executor';

/**
 * Client compatible `supabase-js` du code porté sur une vraie base migrée (`BENCH_TEST_DATABASE_URL`) : mêmes formes de
 * réponse que PostgREST (horodatages à la microseconde, `numeric` en nombre, `jsonb` en objet, `RETURNING`, comptage,
 * `upsert`, `or`, ressource liée, fonctions SQL à arguments nommés). Chaque test tourne dans une transaction annulée.
 */
const url = process.env['BENCH_TEST_DATABASE_URL'];
const describeDb = url ? describe : describe.skip;

describeDb('SqlBenchDbExecutor (base réelle)', () => {
  let client: Client;
  let db: BenchDb;

  beforeAll(async () => {
    client = new Client({ connectionString: url });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });
  beforeEach(async () => {
    await client.query('BEGIN');
    db = new BenchDb(new SqlBenchDbExecutor(client));
  });
  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  it('insert … select().single(), update avec garde, lecture à la microseconde', async () => {
    const { data: run, error } = await db.from('scan_runs').insert({}).select('id').single();
    expect(error).toBeNull();
    expect(typeof run.id).toBe('number');
    const read = await db.from('scan_runs').select('id, started_at, finished_at').eq('id', run.id).single();
    expect(read.data.finished_at).toBeNull();
    expect(read.data.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?\+00:00$/);
    const same = await db.from('scan_runs').update({ error: 'x' }).eq('id', run.id).eq('started_at', read.data.started_at).select('id');
    expect(same.data).toHaveLength(1);
    const stale = await db.from('scan_runs').update({ error: 'y' }).eq('id', run.id).eq('started_at', '2000-01-01T00:00:00Z').select('id');
    expect(stale.data).toHaveLength(0);
    const sol = await db.from('scan_runs').update({ sol_usd: 151.25, source_counts: { dex: { seen: 3 } } }).eq('id', run.id).select('sol_usd, source_counts').single();
    expect(sol.data).toEqual({ sol_usd: 151.25, source_counts: { dex: { seen: 3 } } });
  });

  it('count exact + head, is null, or(), order, limit, range, delete', async () => {
    for (let i = 0; i < 3; i++) { const ins = await db.from('label_runs').insert({ requests: i, rate_limited: 0, rows_written: i, labels: i, candles: 0, failed: 0, queued: 0, ms: 10 }); expect(ins.error).toBeNull(); }
    const head = await db.from('label_runs').select('id', { count: 'exact', head: true }).gte('requests', 1);
    expect(head.data).toBeNull();
    expect(head.count).toBeGreaterThanOrEqual(2);
    const ordered = await db.from('label_runs').select('requests').in('requests', [0, 1, 2]).order('requests', { ascending: false }).limit(2);
    expect(ordered.data.map((r: { requests: number }) => r.requests).slice(0, 2)).toEqual([2, 1]);
    const ranged = await db.from('label_runs').select('requests').in('requests', [0, 1, 2]).order('requests').range(1, 1);
    expect(ranged.data).toEqual([{ requests: 1 }]);
    const ored = await db.from('label_runs').select('requests').or('requests.eq.0,and(requests.gt.1,labels.is.not.null)');
    expect(ored.error?.code).toBe('PGRST100');
    const ored2 = await db.from('label_runs').select('requests').or('requests.eq.0,and(requests.gt.1,labels.gte.2)').order('requests');
    expect(ored2.data.map((r: { requests: number }) => r.requests)).toEqual(expect.arrayContaining([0, 2]));
    const del = await db.from('label_runs').delete().in('requests', [0, 1, 2]);
    expect(del.error).toBeNull();
  });

  it('upsert onConflict (fusion) et ignoreDuplicates, fonctions SQL (scalaire, jeu, json)', async () => {
    const st = { key: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', state: { a: 1 } };
    expect((await db.from('backtest_event_state').upsert(st, { onConflict: 'key', ignoreDuplicates: true })).error).toBeNull();
    await db.from('backtest_event_state').upsert({ key: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', state: { a: 2 } }, { onConflict: 'key', ignoreDuplicates: true });
    expect((await db.from('backtest_event_state').select('state').eq('key', '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin').single()).data.state).toEqual({ a: 1 });
    await db.from('backtest_event_state').upsert({ key: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', state: { a: 3 } }, { onConflict: 'key' });
    expect((await db.from('backtest_event_state').select('state').eq('key', '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin').single()).data.state).toEqual({ a: 3 });

    const queue = await db.rpc('wallet_study_queue', { p_limit: 5 });
    expect(queue.error).toBeNull();
    expect(Array.isArray(queue.data)).toBe(true);
    const tracking = await db.rpc('apply_alert_tracking', { p_rows: [] });
    expect(tracking.error).toBeNull();
    const unknown = await db.rpc('wallet_study_queue', { p_nope: 1 });
    expect(unknown.error?.code).toBe('PGRST202');
  });

  it('ressource liée paper_legs (tableau) et erreur Postgres remontée avec son code', async () => {
    const res = await db.from('paper_positions').select('id, paper_legs(id, status)').limit(1);
    expect(res.error).toBeNull();
    const bad = await db.from('scan_runs').insert({ id: 'pas-un-nombre' });
    expect(bad.error?.code).toMatch(/^(22P02|428C9)$/);
  });
});
