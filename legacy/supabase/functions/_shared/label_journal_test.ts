// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { labelRunRow } from './label-journal.ts';

describe('labelRunRow', () => {
  it('maps the counts of a call', () => {
    assert.deepEqual(labelRunRow({ requests: 5, rateLimited: 1, labels: 3, candles: 1, failed: 0, queued: 8, ms: 41_234.4 }), {
      requests: 5,
      rate_limited: 1,
      rows_written: 4,
      labels: 3,
      candles: 1,
      failed: 0,
      queued: 8,
      ms: 41_234,
    });
  });

  it('clamps to the Postgres checks (never rejected)', () => {
    const r = labelRunRow({ requests: 0, rateLimited: 3, labels: 90, candles: 50, failed: -2, queued: Number.NaN, ms: 1e9 });
    assert.equal(r.rate_limited, 0); // <= requests
    assert.equal(r.rows_written, r.labels + r.candles);
    assert.ok(r.rows_written <= 100);
    assert.equal(r.failed, 0);
    assert.equal(r.queued, 0);
    assert.equal(r.ms, 600_000);
  });
});
