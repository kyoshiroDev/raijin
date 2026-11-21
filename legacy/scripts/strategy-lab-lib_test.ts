// node --experimental-strip-types --no-warnings --test scripts/strategy-lab-lib_test.ts  (also runs under deno test)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  argOf,
  batchStatements,
  candlesForMintsSql,
  chunks,
  dbQueryArgs,
  detectionSource,
  insertOhlcvSql,
  parseCliOutput,
  queueUpdateSql,
  seedDetectionsSql,
  seedFiles,
  seedRow,
  sqlNumArray,
  supabaseCommand,
} from './strategy-lab-lib.ts';
import { ohlcvRow } from '../supabase/functions/_shared/candles.ts';
import type { Candle } from '../supabase/functions/_shared/types.ts';

const MINT = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump';
const PAIR = 'B8a1mw1vfm5pnm4RgUd8zhbtBnkPB2fBMdikU33Z1jqv';
const T0 = 1_800_000_000;

describe('Supabase CLI', () => {
  it('uses supabase when on PATH, else npx supabase; never a shell string', () => {
    assert.deepEqual(supabaseCommand(() => ({ status: 0, error: undefined })), { cmd: 'supabase', prefix: [] });
    assert.deepEqual(supabaseCommand(() => ({ status: null, error: new Error('ENOENT') })), { cmd: 'npx', prefix: ['supabase'] });
    assert.deepEqual(supabaseCommand(() => ({ status: 1, error: undefined })), { cmd: 'npx', prefix: ['supabase'] });
    assert.deepEqual(supabaseCommand(() => { throw new Error('x'); }), { cmd: 'npx', prefix: ['supabase'] });
    const a = dbQueryArgs({ cmd: 'npx', prefix: ['supabase'] }, 'select 1', false);
    assert.deepEqual(a, ['supabase', 'db', 'query', '--remote', '--output-format', 'json', '--read-only', 'select 1']);
    assert.ok(dbQueryArgs({ cmd: 'supabase', prefix: [] }, 'x', true).includes('--yes'));
  });
  it('parseCliOutput: rows, errors without echoing stdout', () => {
    assert.deepEqual(parseCliOutput(0, 'notice\n{"rows":[{"a":1}]}'), [{ a: 1 }]);
    assert.throws(() => parseCliOutput(1, '{"rows":[]}'), /exit 1/);
    assert.throws(() => parseCliOutput(0, '{"error":{"message":"boom"}}'), /boom/);
    assert.throws(() => parseCliOutput(0, 'secret-ish text'), (e: Error) => !e.message.includes('secret'));
  });
});

describe('SQL builders', () => {
  it('sqlNumArray: finite only, real rounded to 8 significant digits, int checked', () => {
    assert.equal(sqlNumArray([1, 2.5], 'real'), "'{1,2.5}'::real[]");
    assert.equal(sqlNumArray([0.000123456789123], 'real'), "'{0.00012345679}'::real[]");
    assert.equal(sqlNumArray([0, 60], 'int'), "'{0,60}'::int[]");
    assert.throws(() => sqlNumArray([Number.NaN], 'real'), RangeError);
    assert.throws(() => sqlNumArray([1.5], 'int'), RangeError);
  });
  it('insertOhlcvSql: one statement, on conflict do nothing, quoted values', () => {
    const row = ohlcvRow({ mint: MINT, pool: PAIR, tf: '5m', candles: [[T0, 1, 2, 0.5, 1.5, 3] as Candle], source: 'preset_signals', detectedAtMs: T0 * 1000, fetchedAtMs: T0 * 1000 })!;
    const sql = insertOhlcvSql([row]);
    assert.match(sql, /^insert into public\.ohlcv_candles \(mint, pool, tf, ts_start, step_s, ts, o, h, l, c, v, source, detected_at, fetched_at\) values /);
    assert.match(sql, /on conflict \(mint, tf, ts_start\) do nothing;$/);
    assert.ok(sql.includes(`'${MINT}'`) && sql.includes("'5m'") && sql.includes("'{0}'::int[]") && sql.includes("'preset_signals'"));
    assert.equal(insertOhlcvSql([]), '');
    assert.throws(() => insertOhlcvSql([{ ...row, mint: "x'; drop table t; --" }]), RangeError);
  });
  it('batchStatements keeps each transaction under the limit', () => {
    const stmts = Array.from({ length: 10 }, (_, i) => `select ${'x'.repeat(30)}${i};`);
    const b = batchStatements(stmts, 120);
    assert.ok(b.length > 1);
    assert.ok(b.every((s) => s.startsWith('begin; ') && s.endsWith(' commit;') && s.length <= 120));
    assert.equal(b.join(' ').match(/select/g)?.length, 10);
    assert.deepEqual(batchStatements(['', '']), []);
  });
  it('queueUpdateSql: only candles_* columns, validated key', () => {
    assert.equal(
      queueUpdateSql('signal_outcomes', 'mint', MINT, { candles_1m_at: null, candles_attempts: 2, status: 'final' }),
      `update public.signal_outcomes set candles_1m_at = null, candles_attempts = 2 where mint = '${MINT}';`,
    );
    assert.equal(
      queueUpdateSql('preset_signals', 'id', 7, { candles_5m_at: '2026-11-19T00:00:00.000Z' }),
      "update public.preset_signals set candles_5m_at = '2026-11-19T00:00:00.000Z'::timestamptz where id = 7;",
    );
    assert.equal(queueUpdateSql('preset_signals', 'id', 7, { other: 1 }), '');
    assert.throws(() => queueUpdateSql('preset_signals', 'mint', MINT, {}), RangeError);
    assert.throws(() => queueUpdateSql('signal_outcomes', 'mint', 'bad', {}), RangeError);
    assert.throws(() => queueUpdateSql('preset_signals', 'id', 1.5, {}), RangeError);
  });
  it('mint lists are validated before entering SQL', () => {
    assert.equal(seedDetectionsSql(['bad']), '');
    assert.ok(seedDetectionsSql([MINT, 'bad']).endsWith(`in ('${MINT}')`));
    assert.equal(candlesForMintsSql(["'; drop"]), '');
    assert.ok(candlesForMintsSql([MINT]).includes(`'${MINT}'`));
  });
});

describe('15-minute seed', () => {
  it('seedFiles keeps signal_outcomes files only, once per mint', () => {
    assert.deepEqual(seedFiles([`signal_outcomes-${MINT}.json`, `early_outcomes-${MINT}.json`, 'signal_outcomes-bad.json', `signal_outcomes-${MINT}.json`, 'x']), [
      { mint: MINT, file: `signal_outcomes-${MINT}.json` },
    ]);
  });
  it('seedRow: 15m row from the candle containing the detection to detection + 7 days', () => {
    const det = (T0 + 400) * 1000; // inside the candle opening at T0 (T0 is a multiple of 900)
    const candles = [T0 - 900, T0, T0 + 900, T0 + 400 + 7 * 86400, T0 + 400 + 7 * 86400 + 900].map((t) => [t, 1, 2, 0.5, 1.5, 1]);
    const row = seedRow(candles, { mint: MINT, pool: PAIR, detectedAtMs: det }, det)!;
    assert.equal(row.tf, '15m');
    assert.equal(row.step_s, 900);
    assert.equal(row.source, 'signal_outcomes');
    assert.equal(row.ts_start, new Date(T0 * 1000).toISOString());
    assert.deepEqual(row.ts, [0, 900, 400 + 7 * 86400]);
    assert.equal(seedRow([], { mint: MINT, pool: PAIR, detectedAtMs: det }, det), null);
    assert.equal(seedRow('x', { mint: MINT, pool: PAIR, detectedAtMs: det }, det), null);
    assert.equal(seedRow(candles, { mint: 'bad', pool: PAIR, detectedAtMs: det }, det), null);
  });
});

describe('misc', () => {
  it('detectionSource parses features given as text', () => {
    assert.deepEqual(detectionSource({ src: 'signal_outcomes', features: '{"change_1h":3}' })?.row.features, { change_1h: 3 });
    assert.equal(detectionSource({ src: 'signal_outcomes', features: '{bad' })?.row.features, null);
    assert.equal(detectionSource({ src: 'early_outcomes' }), null);
  });
  it('chunks and argOf', () => {
    assert.deepEqual(chunks([1, 2, 3], 2), [[1, 2], [3]]);
    assert.equal(argOf(['--out', 'a.json'], '--out'), 'a.json');
    assert.equal(argOf(['--out'], '--out'), undefined);
  });
});
