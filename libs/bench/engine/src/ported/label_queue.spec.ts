// Merged labelling queue of label-outcomes. Pure, no network.
// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareLabelItems,
  canStartRequest,
  LABEL_PACE,
  LABEL_PACE_2MIN,
  LABEL_PRIORITY,
  LABEL_TABLES,
  labelQueueColumns,
  type LabelItem,
  type LabelTable,
  mergeLabelQueue,
  nextLabelAt,
  onRateLimited,
  parseLabelRow,
  withNextLabelAt,
} from './label-queue';
import { labelFailureUpdate, labelUpdate } from './x3-rows';
import { labelOutcome } from './outcomes';

const MINT = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump';
const PAIR = 'B8a1mw1vfm5pnm4RgUd8zhbtBnkPB2fBMdikU33Z1jqv';
const T0 = Date.UTC(2026, 10, 18, 0, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

function item(
  table: LabelTable,
  key: string | number,
  detectedH: number,
  labelledH: number | null,
  nextH: number | null = null,
): LabelItem {
  return {
    table,
    keyColumn: table === 'preset_signals' ? 'id' : 'mint',
    keyValue: key,
    mint: MINT,
    pairAddress: PAIR,
    detectedAtMs: T0 + detectedH * 3_600_000,
    entryPrice: 1,
    attempts: 0,
    labelledAtMs: labelledH === null ? null : T0 + labelledH * 3_600_000,
    nextLabelAtMs: nextH === null ? null : T0 + nextH * 3_600_000,
  };
}

describe('parseLabelRow', () => {
  const row = { mint: MINT, pair_address: PAIR, detected_at: iso(T0), entry_price: '0.001', label_attempts: 2, labelled_at: null };

  it('keys outcome tables by mint and preset_signals by id', () => {
    const a = parseLabelRow('signal_outcomes', row);
    assert.equal(a?.keyColumn, 'mint');
    assert.equal(a?.keyValue, MINT);
    assert.equal(a?.labelledAtMs, null);
    assert.equal(a?.nextLabelAtMs, null);
    const b = parseLabelRow('preset_signals', { ...row, id: '42', labelled_at: iso(T0 + 1000), next_label_at: iso(T0 + 2000) });
    assert.equal(b?.keyColumn, 'id');
    assert.equal(b?.keyValue, 42);
    assert.equal(b?.labelledAtMs, T0 + 1000);
    assert.equal(b?.nextLabelAtMs, T0 + 2000);
    assert.equal(b?.entryPrice, 0.001);
  });

  it('rejects invalid ids, times and base rows', () => {
    assert.equal(parseLabelRow('preset_signals', row), null);
    assert.equal(parseLabelRow('preset_signals', { ...row, id: -1 }), null);
    assert.equal(parseLabelRow('preset_signals', { ...row, id: '1; drop' }), null);
    assert.equal(parseLabelRow('signal_outcomes', { ...row, labelled_at: 'yesterday' }), null);
    assert.equal(parseLabelRow('signal_outcomes', { ...row, next_label_at: 'soon' }), null);
    assert.equal(parseLabelRow('signal_outcomes', { ...row, mint: '<script>' }), null);
    assert.equal(parseLabelRow('signal_outcomes', { ...row, entry_price: 0 }), null);
  });

  it('selects the id only for preset_signals', () => {
    assert.ok(labelQueueColumns('preset_signals').startsWith('id, '));
    assert.ok(!labelQueueColumns('signal_outcomes').includes('id,'));
    assert.ok(labelQueueColumns('signal_outcomes').includes('labelled_at'));
    for (const t of ['signal_outcomes', 'preset_signals'] as const) {
      assert.ok(labelQueueColumns(t).includes('next_label_at'));
    }
  });
});

describe('compareLabelItems', () => {
  it('oldest checkpoint first (null first of all), then oldest detection', () => {
    const list = [
      item('signal_outcomes', 'a', 10, 50, 60),
      item('signal_outcomes', 'b', 5, null, 20),
      item('signal_outcomes', 'c', 1, 40, 60),
      item('signal_outcomes', 'd', 2, null, null),
    ].sort(compareLabelItems);
    assert.deepEqual(list.map((i) => i.keyValue), ['d', 'b', 'c', 'a']);
  });
});

describe('mergeLabelQueue', () => {
  it('serves preset_signals, then signal_outcomes (the radar queue early_outcomes is archived)', () => {
    assert.deepEqual(LABEL_PRIORITY, ['preset_signals', 'signal_outcomes']);
    assert.deepEqual([...LABEL_TABLES].sort(), ['preset_signals', 'signal_outcomes']);
    const q = mergeLabelQueue(
      [
        item('signal_outcomes', 'm2', 5, null, 30),
        item('preset_signals', 9, 8, null, 40),
        item('signal_outcomes', 'm1', 6, null, 20),
        item('preset_signals', 3, 7, null, 35),
      ],
      3,
    );
    assert.deepEqual(q.map((i) => i.keyValue), [3, 9, 'm1']);
  });

  it('a row of an unknown table (e.g. archived early_outcomes) is never served', () => {
    const main = [1, 2].map((h) => item('signal_outcomes', `m${h}`, h, null, h));
    const q = mergeLabelQueue([item('early_outcomes' as never, 'e', 0, null, 0), ...main], 5);
    assert.deepEqual(q.map((i) => i.keyValue), ['m1', 'm2']);
  });

  it('uses every slot for whatever is due', () => {
    const main = [1, 2, 3, 4].map((h) => item('signal_outcomes', `m${h}`, h, null));
    assert.equal(mergeLabelQueue(main, 4).length, 4);
  });

  it('drops duplicates and respects maxRows', () => {
    const a = item('signal_outcomes', 'e', 1, null);
    assert.equal(mergeLabelQueue([a, { ...a }], 5).length, 1);
    assert.equal(mergeLabelQueue([a], 0).length, 0);
    // Same key in two tables: two different rows.
    assert.equal(mergeLabelQueue([a, item('preset_signals', 7, 1, null)], 5).length, 2);
  });
});

describe('nextLabelAt', () => {
  const H = 3_600_000;
  const det = T0;

  it('final → null, failure → now + 6 h', () => {
    assert.equal(nextLabelAt(det, det + 13 * H, 'final', true), null);
    assert.equal(nextLabelAt(det, det + 13 * H, 'final', false), null);
    assert.equal(nextLabelAt(det, det + 2 * H, 'pending', false), iso(det + 8 * H));
    assert.equal(nextLabelAt(det, det + 200 * H, 'pending', false), iso(det + 206 * H));
  });

  it('checkpoints at detection + 12 h, then + 7 days, then every 6 h past the horizon', () => {
    assert.equal(nextLabelAt(det, det + 1 * H, 'pending', true), iso(det + 12 * H));
    assert.equal(nextLabelAt(det, det + 12 * H - 1, 'pending', true), iso(det + 12 * H));
    assert.equal(nextLabelAt(det, det + 12 * H, 'pending', true), iso(det + 168 * H));
    assert.equal(nextLabelAt(det, det + 168 * H - 1, 'pending', true), iso(det + 168 * H));
    assert.equal(nextLabelAt(det, det + 168 * H, 'pending', true), iso(det + 174 * H));
    assert.equal(nextLabelAt(det, det + 300 * H, 'pending', true), iso(det + 306 * H));
  });

  it('never null for a pending row, even with an invalid detection time', () => {
    assert.equal(nextLabelAt(Number.NaN, det, 'pending', true), iso(det + 6 * H));
    assert.throws(() => nextLabelAt(det, Number.NaN, 'pending', true), RangeError);
  });
});

describe('withNextLabelAt', () => {
  const H = 3_600_000;

  it('adds next_label_at to the success payload (pending → checkpoint, final → null)', () => {
    const now = T0 + 13 * H;
    const pending = withNextLabelAt(labelUpdate(labelOutcome(0.001, T0, [], now), 0, now), T0, now, true);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.next_label_at, iso(T0 + 168 * H));
    assert.equal(pending.label_attempts, 1);
    const final = withNextLabelAt({ status: 'final' as const, labelled_at: iso(now) }, T0, now, true);
    assert.ok('next_label_at' in final);
    assert.equal(final.next_label_at, null);
  });

  it('adds next_label_at to the failure payload (now + 6 h)', () => {
    const now = T0 + 2 * H;
    const p = withNextLabelAt(labelFailureUpdate('GeckoTerminal HTTP 500', 3, now), T0, now, false);
    assert.equal(p.next_label_at, iso(now + 6 * H));
    assert.equal(p.label_attempts, 4);
    assert.equal(p.labelled_at, iso(now));
  });
});

describe('onRateLimited', () => {
  it('retries once when the retry can still start before the budget, then stops', () => {
    assert.equal(onRateLimited(false, 5_000), 'retry');
    assert.equal(onRateLimited(true, 5_000), 'stop');
    assert.equal(onRateLimited(false, LABEL_PACE.stopNewMs - LABEL_PACE.retryAfter429Ms), 'stop');
    assert.equal(onRateLimited(false, Number.NaN), 'stop');
  });

  it('paces ~4 rows per run (one request every 12 s, no new request after 45 s)', () => {
    assert.equal(Math.floor(LABEL_PACE.stopNewMs / LABEL_PACE.spacingMs) + 1, 4);
  });

  it('2-minute cron pace: ≤ 5 requests per call, the first 429 stops the call', () => {
    assert.equal(onRateLimited(false, 0, LABEL_PACE_2MIN), 'stop');
    assert.equal(LABEL_PACE_2MIN.maxRequests, 5);
    // 5 spaced requests fit before stopNewMs, and the call ends before the next one (2 min).
    assert.ok((LABEL_PACE_2MIN.maxRequests - 1) * LABEL_PACE_2MIN.spacingMs < LABEL_PACE_2MIN.stopNewMs);
    assert.ok(LABEL_PACE_2MIN.abortMs < 60_000);
    assert.equal(canStartRequest(0, 0), true);
    assert.equal(canStartRequest(4, 32_000), true);
    assert.equal(canStartRequest(5, 1_000), false);
    assert.equal(canStartRequest(1, LABEL_PACE_2MIN.stopNewMs), false);
    assert.equal(canStartRequest(Number.NaN, 0), false);
    assert.equal(canStartRequest(50, 1_000, LABEL_PACE), true, 'no cap on the legacy pace');
  });
});
