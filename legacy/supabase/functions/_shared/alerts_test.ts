// Runs with `deno test supabase/functions` (node:test is supported by Deno)
// and with `node --experimental-strip-types --test` for quick local checks.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  budget,
  buildGroupedPayload,
  buildPayload,
  buildTestPayload,
  buildFollowUpPayload,
  formatCompactUsd,
  formatPairAge,
  formatPlan,
  formatRr,
  formatSignedPct,
  formatUsdPrice,
  isQuietHour,
  localHour,
  mapLimit,
  MAX_PAYLOAD_BYTES,
  passedPreviousScan,
  PERSISTENCE_MAX_AGE_MS,
  planNotifications,
  previousSnapshotsFromRows,
  stakeSetting,
  type AlertToken,
} from './alerts.ts';
import { fixedExitPlan } from './exit-plan.ts';

const MINTS = [
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
];

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);

function tok(over: Partial<AlertToken> = {}): AlertToken {
  return {
    mint: MINTS[0],
    symbol: 'RAI',
    dex_id: 'pumpswap',
    market_cap: 1_200_000,
    flags: [],
    mint_authority_disabled: true,
    freeze_authority_disabled: true,
    price_usd: 1,
    ...over,
  };
}

describe('previousSnapshotsFromRows / passedPreviousScan (persistence over 2 scans)', () => {
  it('keeps the latest valid row per mint strictly before the scan start; score / zone are not required', () => {
    const rows = [
      { mint: MINTS[0], captured_at: new Date(NOW - 240_000).toISOString() },
      { mint: MINTS[0], captured_at: new Date(NOW - 120_000).toISOString(), score: null, zone_status: null },
      { mint: MINTS[0], captured_at: new Date(NOW).toISOString() }, // this scan
      { mint: MINTS[1], captured_at: 'garbage' },
      { mint: MINTS[2], captured_at: new Date(NOW - 60_000).toISOString(), score: 80, zone_status: 'moon' },
      { mint: 'bad', captured_at: new Date(NOW - 60_000).toISOString() },
      null,
    ];
    const m = previousSnapshotsFromRows(rows, NOW);
    assert.deepEqual([...m.keys()].sort(), [MINTS[0], MINTS[2]].sort());
    assert.deepEqual(m.get(MINTS[0]), { at: NOW - 120_000 });
    assert.equal(previousSnapshotsFromRows('nope', NOW).size, 0);
  });
  it('passedPreviousScan: a previous scan 0 < age ≤ 5 min exists', () => {
    assert.equal(passedPreviousScan({ at: NOW - 120_000 }, NOW), true);
    assert.equal(passedPreviousScan({ at: NOW - PERSISTENCE_MAX_AGE_MS }, NOW), true);
    assert.equal(passedPreviousScan({ at: NOW - PERSISTENCE_MAX_AGE_MS - 1 }, NOW), false);
    assert.equal(passedPreviousScan(undefined, NOW), false);
    assert.equal(passedPreviousScan({ at: NOW }, NOW), false);
    assert.equal(passedPreviousScan({ at: NOW + 1 }, NOW), false);
  });
});

describe('stakeSetting', () => {
  it('0.01–100 SOL, else 0.1', () => {
    assert.equal(stakeSetting({ stake_sol: 0.5 }), 0.5);
    assert.equal(stakeSetting({ stake_sol: 0 }), 0.1);
    assert.equal(stakeSetting({ stake_sol: null }), 0.1);
    assert.equal(stakeSetting({}), 0.1);
  });
});

describe('isQuietHour (Europe/Paris)', () => {
  it('handles a window wrapping midnight (23 -> 7), end exclusive', () => {
    // Winter (UTC+1)
    assert.equal(isQuietHour(Date.UTC(2026, 0, 15, 22, 30), 23, 7), true); // 23:30
    assert.equal(isQuietHour(Date.UTC(2026, 0, 15, 2, 0), 23, 7), true); // 03:00
    assert.equal(isQuietHour(Date.UTC(2026, 0, 15, 5, 30), 23, 7), true); // 06:30
    assert.equal(isQuietHour(Date.UTC(2026, 0, 15, 6, 0), 23, 7), false); // 07:00
    assert.equal(isQuietHour(Date.UTC(2026, 0, 15, 21, 59), 23, 7), false); // 22:59
  });
  it('applies summer time (UTC+2): 05:30 UTC is 07:30 in July, 06:30 in January', () => {
    assert.equal(isQuietHour(Date.UTC(2026, 6, 1, 5, 30), 23, 7), false);
    assert.equal(isQuietHour(Date.UTC(2026, 0, 15, 5, 30), 23, 7), true);
  });
  it('handles the spring-forward boundary (2026-03-29, 02:00 -> 03:00)', () => {
    assert.equal(localHour(Date.UTC(2026, 2, 29, 0, 59)), 1);
    assert.equal(localHour(Date.UTC(2026, 2, 29, 1, 0)), 3);
    assert.equal(isQuietHour(Date.UTC(2026, 2, 29, 0, 59), 1, 3), true);
    assert.equal(isQuietHour(Date.UTC(2026, 2, 29, 1, 0), 1, 3), false);
  });
  it('handles the fall-back boundary (2026-10-25, 03:00 -> 02:00)', () => {
    assert.equal(localHour(Date.UTC(2026, 9, 25, 0, 30)), 2); // 02:30 CEST
    assert.equal(localHour(Date.UTC(2026, 9, 25, 1, 30)), 2); // 02:30 CET
    assert.equal(localHour(Date.UTC(2026, 9, 25, 2, 0)), 3);
    assert.equal(isQuietHour(Date.UTC(2026, 9, 25, 1, 30), 2, 3), true);
  });
  it('handles a non-wrapping window (13 -> 15)', () => {
    assert.equal(isQuietHour(Date.UTC(2026, 0, 15, 12, 0), 13, 15), true); // 13:00
    assert.equal(isQuietHour(Date.UTC(2026, 0, 15, 14, 0), 13, 15), false); // 15:00
    assert.equal(isQuietHour(Date.UTC(2026, 0, 15, 11, 0), 13, 15), false); // 12:00
  });
  it('start === end means no quiet hours', () => {
    for (let h = 0; h < 24; h++) assert.equal(isQuietHour(Date.UTC(2026, 0, 15, h, 0), 5, 5), false);
  });
  it('accepts midnight as 0, never 24', () => {
    assert.equal(localHour(Date.UTC(2026, 0, 15, 23, 0)), 0);
  });
});

describe('budget', () => {
  it('returns what remains this hour, never negative', () => {
    assert.equal(budget(4, 0), 4);
    assert.equal(budget(4, 3), 1);
    assert.equal(budget(4, 4), 0);
    assert.equal(budget(4, 9), 0);
    assert.equal(budget(1, -2), 1);
  });
});

describe('planNotifications', () => {
  const cands = (n: number) => MINTS.slice(0, n).map((mint, i) => tok({ mint, market_cap: 1_000_000 - i }));

  it('sends nothing without budget or candidates', () => {
    assert.deepEqual(planNotifications(cands(3), 0), { individual: [], grouped: null, cost: 0 });
    assert.deepEqual(planNotifications([], 4), { individual: [], grouped: null, cost: 0 });
  });
  it('sends up to 3 individual pushes when they all fit', () => {
    const p = planNotifications(cands(3), 4);
    assert.equal(p.individual.length, 3);
    assert.equal(p.grouped, null);
    assert.equal(p.cost, 3);
  });
  it('sends 3 individual + 1 grouped (count = total) when more candidates remain', () => {
    const p = planNotifications(cands(5), 4);
    assert.deepEqual(p.individual.map((t) => t.mint), MINTS.slice(0, 3));
    assert.deepEqual(p.grouped, { count: 5, mints: MINTS.slice(3, 5) });
    assert.equal(p.cost, 4);
  });
  it('reserves one budget slot for the grouped push when the budget is short', () => {
    const p = planNotifications(cands(5), 2);
    assert.equal(p.individual.length, 1);
    assert.deepEqual(p.grouped, { count: 5, mints: MINTS.slice(1, 5) });
    assert.equal(p.cost, 2);
  });
  it('with a budget of 1 and several candidates, sends only the grouped push covering all', () => {
    const p = planNotifications(cands(2), 1);
    assert.equal(p.individual.length, 0);
    assert.deepEqual(p.grouped, { count: 2, mints: MINTS.slice(0, 2) });
    assert.equal(p.cost, 1);
  });
  it('a single candidate with a budget of 1 is sent individually', () => {
    const p = planNotifications(cands(1), 1);
    assert.equal(p.individual.length, 1);
    assert.equal(p.grouped, null);
  });
  it('every candidate is either individual or in the grouped mints (all get logged)', () => {
    const c = cands(6);
    const p = planNotifications(c, 3);
    const logged = [...p.individual.map((t) => t.mint), ...(p.grouped?.mints ?? [])];
    assert.deepEqual(logged.sort(), c.map((t) => t.mint).sort());
  });
});

describe('formatCompactUsd', () => {
  it('formats compactly in French', () => {
    assert.equal(formatCompactUsd(1_234_567), '1,2 M$');
    assert.equal(formatCompactUsd(250_000), '250 k$');
    assert.equal(formatCompactUsd(12_500), '13 k$');
    assert.equal(formatCompactUsd(1_540), '1,5 k$');
    assert.equal(formatCompactUsd(3_400_000_000), '3,4 Md$');
    assert.equal(formatCompactUsd(850), '850 $');
    assert.equal(formatCompactUsd(2_000_000), '2 M$');
    assert.equal(formatCompactUsd(Number.NaN), '? $');
  });
});

describe('buildPayload', () => {
  it('uses the ngsw shape: notification object, icon and a click target equal to data.url', () => {
    for (const p of [buildPayload(tok()), buildGroupedPayload(5), buildTestPayload()]) {
      const n = p.notification;
      assert.equal(typeof n.title, 'string');
      assert.equal(n.icon, '/icons/icon-192.png');
      assert.equal(n.data.onActionClick.default.operation, 'navigateLastFocusedOrOpen');
      assert.equal(n.data.onActionClick.default.url, n.data.url);
      assert.match(n.data.url, /^\/(token\/[1-9A-HJ-NP-Za-km-z]{32,44}|settings)?$/);
      assert.ok(!('title' in (p as unknown as Record<string, unknown>)), 'no top-level title');
    }
  });
  it('« Jeune calme » title, body (pair age, plan, MC, 2 flags, disclaimer) and deep link', () => {
    const plan = fixedExitPlan(0.001);
    assert.ok(plan);
    const p = buildPayload(tok({ symbol: 'rai', price_usd: 0.001, flags: ['Liquidité faible vs MC', 'Moins d\'1 h', 'Bonding curve'] }), plan, 5.2);
    assert.equal(p.notification.title, '⚡ RAIJIN · Jeune calme · RAI');
    assert.equal(
      p.notification.body,
      'Paire de 5 h · Objectif +100 % (0,002 $) · Stop \u221230 % (0,0007 $) · R/R 3,3 · MC 1,2 M$ · Liquidité faible vs MC · Moins d\'1 h · Aide à la décision, pas un conseil financier.',
    );
    assert.equal(p.notification.data.url, `/token/${MINTS[0]}`);
    assert.equal(p.notification.tag, `raijin-${MINTS[0]}`);
  });
  it('no score, zone or model note any more', () => {
    const body = buildPayload(tok({ market_cap: 250_000 })).notification.body;
    assert.equal(body, 'MC 250 k$ · Aide à la décision, pas un conseil financier.');
    assert.doesNotMatch(buildPayload(tok()).notification.title, /\/100/);
  });
  it('formatPairAge: minutes under 1 h, hours above, unknown → null', () => {
    assert.equal(formatPairAge(0.2), 'Paire de 12 min');
    assert.equal(formatPairAge(0), 'Paire de 1 min');
    assert.equal(formatPairAge(5.4), 'Paire de 5 h');
    assert.equal(formatPairAge(null), null);
    assert.equal(formatPairAge(-1), null);
  });
  it('neutralises a hostile symbol (bidi override, control chars, tags, length)', () => {
    const p = buildPayload(tok({ symbol: '\u202Egpj.exe<script>alert(1)</script>\u0007' + 'A'.repeat(200) }));
    assert.doesNotMatch(p.notification.title, /[\u202A-\u202E\u2066-\u2069\u0000-\u001F<>]/);
    assert.ok(p.notification.title.length <= '⚡ RAIJIN · Jeune calme · '.length + 16);
  });
  it('falls back to ??? for an empty symbol and / for an invalid mint', () => {
    const p = buildPayload(tok({ symbol: '\u200B\u202E', mint: 'evil/../../x' }));
    assert.match(p.notification.title, /^⚡ RAIJIN · Jeune calme · \?\?\?$/);
    assert.equal(p.notification.data.url, '/');
  });
  it('stays under 3 KB even with hostile flags', () => {
    const p = buildPayload(tok({ flags: ['x'.repeat(5000), 'y'.repeat(5000)] }));
    assert.ok(new TextEncoder().encode(JSON.stringify(p)).length < MAX_PAYLOAD_BYTES);
  });
  it('grouped and test payloads', () => {
    assert.equal(buildGroupedPayload(5).notification.title, '⚡ RAIJIN · 5 nouvelles opportunités');
    assert.equal(buildGroupedPayload(5).notification.data.url, '/');
    assert.equal(buildTestPayload().notification.title, '⚡ RAIJIN · Notification de test');
    assert.equal(buildTestPayload().notification.data.url, '/settings');
  });
});

describe('price / percent / plan formatting', () => {
  it('formatUsdPrice: 4 significant digits, French comma, no exponent', () => {
    assert.equal(formatUsdPrice(1.2), '1,2 $');
    assert.equal(formatUsdPrice(0.00012346), '0,0001235 $');
    assert.equal(formatUsdPrice(0.000000012345), '0,00000001235 $');
    assert.equal(formatUsdPrice(12.5), '12,5 $');
    assert.equal(formatUsdPrice(12345.6), '12346 $');
    assert.equal(formatUsdPrice(0), '? $');
    assert.equal(formatUsdPrice(Number.NaN), '? $');
  });
  it('formatSignedPct / formatRr', () => {
    assert.equal(formatSignedPct(20), '+20 %');
    assert.equal(formatSignedPct(-14.2), '\u221214 %');
    assert.equal(formatSignedPct(0.2), '0 %');
    assert.equal(formatRr(1.429), '1,4');
    assert.equal(formatRr(1), '1');
  });
  it('formatPlan', () => {
    const plan = fixedExitPlan(1);
    assert.ok(plan);
    assert.equal(formatPlan(plan), 'Objectif +100 % (2 $) · Stop \u221230 % (0,7 $) · R/R 3,3');
  });
});

describe('buildFollowUpPayload', () => {
  it('target hit: « ✅ Objectif atteint · SYMBOL +20 % », deep link, own tag', () => {
    const p = buildFollowUpPayload(MINTS[0], 'rai', 'target', 1, 1.2);
    assert.equal(p.notification.title, '✅ Objectif atteint · RAI +20 %');
    assert.equal(p.notification.data.url, `/token/${MINTS[0]}`);
    assert.equal(p.notification.data.onActionClick.default.url, p.notification.data.url);
    assert.equal(p.notification.tag, `raijin-followup-${MINTS[0]}`);
    assert.match(p.notification.body, /pas un conseil financier/);
  });
  it('stop hit: « 🛑 Invalidation touchée · SYMBOL −14 % »', () => {
    assert.equal(buildFollowUpPayload(MINTS[0], 'rai', 'stop', 1, 0.86).notification.title, '🛑 Invalidation touchée · RAI \u221214 %');
  });
  it('hostile symbol and invalid mint are neutralised', () => {
    const p = buildFollowUpPayload('evil/../x', '\u202e<script>', 'target', 1, 1.2);
    assert.equal(p.notification.data.url, '/');
    assert.doesNotMatch(p.notification.title, /[<>\u202e]/);
  });
});

describe('mapLimit', () => {
  it('respects the concurrency limit and keeps order', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 2;
    });
    assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
    assert.ok(peak <= 3);
  });
  it('skips items once the deadline has passed', async () => {
    let t = 0;
    const out = await mapLimit([1, 2, 3], 1, async (n) => {
      t += 10;
      return n;
    }, 15, () => t);
    assert.deepEqual(out, [1, 2, undefined]);
  });
});
