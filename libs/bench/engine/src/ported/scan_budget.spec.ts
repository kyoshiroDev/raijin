// scan-tokens run-wide budget (fake clock and timers) and overlap guard (security review M1).
// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createScanBudget, isOverlapping, OVERLAP_WINDOW_MS, SCAN_BUDGET } from './scan-budget';

function fakeClock(start: number) {
  let t = start;
  const timers: { at: number; fn: () => void; done: boolean }[] = [];
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const h = { at: t + ms, fn, done: false };
      timers.push(h);
      return h;
    },
    clearTimer: (h: unknown) => {
      (h as { done: boolean }).done = true;
    },
    advance(ms: number) {
      t += ms;
      for (const h of timers) {
        if (!h.done && h.at <= t) {
          h.done = true;
          h.fn();
        }
      }
    },
    pending: () => timers.filter((h) => !h.done).length,
  };
}

describe('scan-budget', () => {
  describe('SCAN_BUDGET', () => {
    it('milestones are ordered and the worst case stays well under pg_net 55 s', () => {
      const order = [
        SCAN_BUDGET.collectStopMs,
        SCAN_BUDGET.collectAbortMs,
        SCAN_BUDGET.pairsStopMs,
        SCAN_BUDGET.auditsStopMs,
        SCAN_BUDGET.trackingStopMs,
        SCAN_BUDGET.abortMs,
        SCAN_BUDGET.pushStopMs,
        SCAN_BUDGET.pushAbortMs,
      ];
      assert.deepEqual([...order].sort((a, b) => a - b), order);
      // 8 s request timeout after the last "stop" milestones still ends by the abort.
      assert.ok(SCAN_BUDGET.collectStopMs + 8_000 >= SCAN_BUDGET.collectAbortMs);
      assert.ok(SCAN_BUDGET.pushAbortMs + 2_000 <= 45_000);
    });
  });

  describe('createScanBudget (fake clock)', () => {
    it('passed / left / at follow the clock', () => {
      const c = fakeClock(1_000_000);
      const b = createScanBudget(1_000_000, c);
      assert.equal(b.at('collectStopMs'), 1_000_000 + SCAN_BUDGET.collectStopMs);
      assert.equal(b.passed('collectStopMs'), false);
      assert.equal(b.left('collectStopMs'), SCAN_BUDGET.collectStopMs);
      c.advance(SCAN_BUDGET.collectStopMs);
      assert.equal(b.passed('collectStopMs'), true);
      assert.equal(b.left('collectStopMs'), 0);
      assert.equal(b.passed('trackingStopMs'), false);
      b.dispose();
    });
    it('aborts the collection signal at collectAbortMs and every request at abortMs', () => {
      const c = fakeClock(0);
      const b = createScanBudget(0, c);
      c.advance(SCAN_BUDGET.collectAbortMs - 1);
      assert.equal(b.collectSignal.aborted, false);
      c.advance(1);
      assert.equal(b.collectSignal.aborted, true);
      assert.equal(b.signal.aborted, false);
      c.advance(SCAN_BUDGET.abortMs - SCAN_BUDGET.collectAbortMs);
      assert.equal(b.signal.aborted, true);
      b.dispose();
    });
    it('a budget created late (clock already past) aborts immediately; dispose clears the timers', () => {
      const c = fakeClock(100_000);
      const b = createScanBudget(0, c);
      assert.equal(c.pending(), 2);
      c.advance(0);
      assert.equal(b.signal.aborted, true);
      assert.equal(b.collectSignal.aborted, true);
      const c2 = fakeClock(0);
      const b2 = createScanBudget(0, c2);
      b2.dispose();
      assert.equal(c2.pending(), 0);
      c2.advance(60_000);
      assert.equal(b2.signal.aborted, false);
    });
  });

  describe('isOverlapping', () => {
    const now = Date.parse('2026-11-17T20:00:00Z');
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
    it('skips while an older unfinished run started < 90 s ago', () => {
      assert.equal(isOverlapping(10, [{ id: 9, started_at: iso(30_000), finished_at: null }], now), true);
    });
    it('the smaller id proceeds: a NEWER unfinished run never blocks', () => {
      assert.equal(isOverlapping(9, [{ id: 10, started_at: iso(1_000), finished_at: null }], now), false);
      assert.equal(isOverlapping(10, [{ id: 10, started_at: iso(1_000), finished_at: null }], now), false);
    });
    it('finished, stale (crashed > 90 s ago) or invalid rows do not block', () => {
      assert.equal(isOverlapping(10, [{ id: 9, started_at: iso(30_000), finished_at: iso(1_000) }], now), false);
      assert.equal(isOverlapping(10, [{ id: 9, started_at: iso(OVERLAP_WINDOW_MS), finished_at: null }], now), false);
      assert.equal(isOverlapping(10, [{ id: '9', started_at: iso(1), finished_at: null }], now), false);
      assert.equal(isOverlapping(10, [{ id: 9, started_at: 'nope', finished_at: null }], now), false);
      assert.equal(isOverlapping(10, [{ id: 9, started_at: iso(1) }], now), false);
      assert.equal(isOverlapping(10, [null], now), false);
      assert.equal(isOverlapping(10, null, now), false);
    });
  });
});
