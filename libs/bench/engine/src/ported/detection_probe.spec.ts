// Detection probe (feat/calm-sl-test): targets, bounded RugCheck / round-trip probes, merge. Pure, injected I/O.
// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeProbe,
  PROBE_MAX_QUOTES,
  PROBE_MAX_RUGCHECK,
  type ProbeCandidate,
  probeLpLocks,
  probeRoundTrips,
  probeTargets,
} from './detection-probe';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const mint = (i: number) => 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXh' + B58[Math.floor(i / 58) % 58] + B58[i % 58] + 'pump';
const cand = (i: number, over: Partial<ProbeCandidate> = {}): ProbeCandidate => ({
  mint: mint(i),
  ageHours: 2,
  roundtripCostPct: null,
  lpLockedPct: null,
  ...over,
});

describe('probeTargets', () => {
  it('first-detected (not in tokens) young (< 24 h) valid mints, input order, no duplicates', () => {
    const items = [cand(1), cand(2, { ageHours: 30 }), cand(3, { ageHours: null }), cand(4), cand(1), cand(5, { mint: 'bad' }), cand(6, { ageHours: 23.9 })];
    assert.deepEqual(probeTargets(items, new Set([mint(4)]), true).map((t) => t.mint), [mint(1), mint(6)]);
  });
  it('nothing when the « existing » read was incomplete (a known token could look new)', () => {
    assert.deepEqual(probeTargets([cand(1)], new Set(), false), []);
  });
});

describe('probeLpLocks', () => {
  it('only unknown LP, at most PROBE_MAX_RUGCHECK, values bounded, failures leave the key absent', async () => {
    const calls: string[] = [];
    const targets = [cand(1), cand(2, { lpLockedPct: 100 }), cand(3), cand(4), cand(5), cand(6)];
    const out = await probeLpLocks(targets, async (m) => {
      calls.push(m);
      if (m === mint(3)) return null;
      if (m === mint(4)) throw new Error('boom');
      if (m === mint(5)) return { lpLockedPct: 140 };
      return { lpLockedPct: 99.5 };
    });
    assert.equal(PROBE_MAX_RUGCHECK, 4);
    assert.deepEqual(calls, [mint(1), mint(3), mint(4), mint(5)], 'mint 2 already known, mint 6 over the cap');
    assert.deepEqual([...out.entries()], [[mint(1), { lpLockedPct: 99.5 }], [mint(5), { lpLockedPct: null }]]);
  });
});

describe('probeRoundTrips', () => {
  it('one at a time, only unknown round trips, at most PROBE_MAX_QUOTES; null skipped; budget stop (undefined) ends', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const calls: string[] = [];
    const rt = async (m: string) => {
      calls.push(m);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return m === mint(1) ? null : { roundtripCostPct: 2.5 };
    };
    const out = await probeRoundTrips([cand(1), cand(2, { roundtripCostPct: 1 }), cand(3), cand(4)], rt);
    assert.equal(PROBE_MAX_QUOTES, 2);
    assert.deepEqual(calls, [mint(1), mint(3)]);
    assert.equal(maxInFlight, 1);
    assert.deepEqual([...out.entries()], [[mint(3), { roundtripCostPct: 2.5 }]]);

    const stopped = await probeRoundTrips([cand(1), cand(3)], async () => undefined, 5);
    assert.equal(stopped.size, 0);
    const outOfRange = await probeRoundTrips([cand(1)], async () => ({ roundtripCostPct: 250 }));
    assert.deepEqual(outOfRange.get(mint(1)), { roundtripCostPct: null });
    const thrown = await probeRoundTrips([cand(1)], () => Promise.reject(new Error('x')));
    assert.equal(thrown.size, 0);
  });
});

describe('mergeProbe', () => {
  it('fills unknown values only (a fresh enrich-tokens value is never overwritten), untouched items kept as is', () => {
    const a = cand(1);
    const b = cand(2, { roundtripCostPct: 1.2, lpLockedPct: 80 });
    const c = cand(3);
    const lp = new Map([[mint(1), { lpLockedPct: 100 }], [mint(2), { lpLockedPct: 100 }]]);
    const rt = new Map([[mint(1), { roundtripCostPct: 3 }], [mint(2), { roundtripCostPct: 9 }]]);
    const [ma, mb, mc] = mergeProbe([a, b, c], lp, rt);
    assert.deepEqual(ma, { ...a, lpLockedPct: 100, roundtripCostPct: 3 });
    assert.equal(mb, b);
    assert.equal(mc, c);
    assert.equal(a.lpLockedPct, null, 'input not mutated');
  });
});
