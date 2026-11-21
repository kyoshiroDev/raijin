// « Calme » / « Frénésie » auto-paper wiring (feat/young-calm). Pure, no network.
// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test` (zod shim below).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setupZodForNode } from './test-support/zod-node.ts';
import type { PresetToken } from './presets.ts';

// paper-engine.ts imports zod (npm: specifier): loaded after the Node shim (no-op under Deno).
await setupZodForNode();
const {
  autoPaperUserIds,
  CALM_FRENZY_EXISTING_LIMIT,
  CALM_FRENZY_MAX_PER_PRESET,
  calmFrenzyMatches,
  calmFrenzyRpcArgs,
  existingReadComplete,
} = await import('./calm-frenzy-wiring.ts');
const { calmFrenzyOpenings } = await import('./paper-engine.ts');

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const HOUR = 3_600_000;
const U1 = '00000000-0000-4000-8000-0000000000a1';
const U2 = '00000000-0000-4000-8000-0000000000a2';
// Valid base58 mints (32+ chars, no 0 / O / I / l).
const mint = (i: number) => `D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhub${'ABCDEFGHJKMN'[i % 12]}${'pqrstuvwxyz'[Math.floor(i / 12) % 11]}mp`;

function token(over: Partial<PresetToken> = {}): PresetToken {
  return {
    mint: mint(0),
    symbol: 'CALM',
    score: 60,
    zone_status: 'wait',
    dex_id: 'pumpswap',
    market_cap: 400_000,
    flags: [],
    mint_authority_disabled: true,
    freeze_authority_disabled: true,
    price_usd: 0.0004,
    roundtrip_cost_pct: 2,
    insiders_detected: false,
    creator_rug_history: false,
    liquidity_usd: 45_000,
    liquidity_effective_usd: 40_000,
    change_1h: 40,
    top10_pct: 12,
    pair_created_at: NOW - 3 * HOUR,
    buys_1h: 110,
    sells_1h: 100,
    lp_locked_pct: null,
    ...over,
  };
}

describe('calmFrenzyMatches', () => {
  it('classifies calm and frenzy tokens, scan order kept, non-matching tokens skipped', () => {
    const calm = token({ mint: mint(1) });
    const frenzy = token({ mint: mint(2), change_1h: 200 });
    const frenzyRatio = token({ mint: mint(3), buys_1h: 300, sells_1h: 100 });
    const old = token({ mint: mint(4), pair_created_at: NOW - 30 * HOUR });
    const neither = token({ mint: mint(5), change_1h: 120 });
    const out = calmFrenzyMatches([calm, frenzy, old, neither, frenzyRatio], NOW);
    assert.deepEqual(
      out.map((m) => [m.preset, m.token.mint]),
      [['young_calm', mint(1)], ['young_frenzy', mint(2)], ['young_frenzy', mint(3)]],
    );
    assert.deepEqual(out[0].token, { mint: mint(1), price_usd: 0.0004 });
  });

  it('unknown buys / sells → no match (ratio unknown), never the 0 default', () => {
    assert.deepEqual(calmFrenzyMatches([token({ buys_1h: null }), token({ sells_1h: undefined })], NOW), []);
  });

  it('bounded per preset, duplicates and invalid mints skipped, invalid now → nothing', () => {
    const many = Array.from({ length: 15 }, (_, i) => token({ mint: mint(i) }));
    assert.equal(calmFrenzyMatches(many, NOW).length, CALM_FRENZY_MAX_PER_PRESET);
    assert.equal(calmFrenzyMatches(many, NOW, 3).length, 3);
    assert.equal(calmFrenzyMatches(many, NOW, 0).length, 0);
    assert.equal(calmFrenzyMatches([token(), token()], NOW).length, 1);
    assert.equal(calmFrenzyMatches([token({ mint: '<script>' })], NOW).length, 0);
    assert.equal(calmFrenzyMatches([token()], Number.NaN).length, 0);
    assert.deepEqual(calmFrenzyMatches(null as unknown as PresetToken[], NOW), []);
  });
});

describe('autoPaperUserIds', () => {
  it('valid distinct UUIDs in order, bounded', () => {
    assert.deepEqual(autoPaperUserIds([{ user_id: U1 }, { user_id: 'x' }, { user_id: U1 }, { user_id: U2 }, null]), [U1, U2]);
    assert.deepEqual(autoPaperUserIds([{ user_id: U1 }, { user_id: U2 }], 1), [U1]);
    assert.deepEqual(autoPaperUserIds(undefined), []);
  });
});

describe('existingReadComplete', () => {
  it('only a short page proves absence (fail closed)', () => {
    assert.equal(existingReadComplete([]), true);
    assert.equal(existingReadComplete(new Array(CALM_FRENZY_EXISTING_LIMIT - 1).fill({})), true);
    assert.equal(existingReadComplete(new Array(CALM_FRENZY_EXISTING_LIMIT).fill({})), false);
    assert.equal(existingReadComplete(null), false);
    assert.equal(existingReadComplete({}), false);
  });
});

describe('calmFrenzyRpcArgs', () => {
  it('one all_x2 next_tick RPC per opening and book, no alert link, active (user, book, mint) excluded', () => {
    const matches = calmFrenzyMatches([token({ mint: mint(1) }), token({ mint: mint(2), change_1h: 200 })], NOW);
    const existing = [{ user_id: U1, book: 'calm_sl30', mint: mint(1), status: 'open', paper_legs: [] }];
    const args = calmFrenzyRpcArgs(calmFrenzyOpenings(matches, [U1, U2], existing, NOW));
    assert.deepEqual(
      args.map((a) => [a.p_user, a.p_book, a.p_mint, a.p_sl_pct]),
      [
        [U1, 'calm_sl40', mint(1), 40],
        [U2, 'calm_sl30', mint(1), 30],
        [U2, 'calm_sl40', mint(1), 40],
        [U1, 'frenzy_sl30', mint(2), 30],
        [U2, 'frenzy_sl30', mint(2), 30],
      ],
    );
    for (const a of args) {
      assert.equal(a.p_strategy, 'all_x2');
      assert.equal(a.p_entry_mode, 'next_tick');
      assert.equal(a.p_source, 'auto_alert');
      assert.equal(a.p_alert_id, null);
      assert.equal(a.p_stake, 0.1);
    }
  });

  it('bounded; invalid openings dropped', () => {
    const matches = calmFrenzyMatches(Array.from({ length: 5 }, (_, i) => token({ mint: mint(i) })), NOW);
    const openings = calmFrenzyOpenings(matches, [U1, U2], [], NOW);
    assert.equal(calmFrenzyRpcArgs(openings).length, 20, '5 calm matches × 2 users × 2 books');
    assert.equal(calmFrenzyRpcArgs(openings, 4).length, 4);
    assert.deepEqual(calmFrenzyRpcArgs([{ user_id: 'nope', mint: mint(1), plan: openings[0].plan }]), []);
    assert.deepEqual(calmFrenzyRpcArgs(undefined as unknown as []), []);
  });
});
