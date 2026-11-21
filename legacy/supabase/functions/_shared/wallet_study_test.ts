// feat/wallet-study: pure smart-wallet study (wallet-study.ts). Synthetic data only, no network.
// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSolanaAddress } from './solana.ts';
import {
  ageFromLogAge,
  bootstrapDiffCI,
  bootstrapMeanCI,
  broadWallets,
  candlePeakMs,
  chronologicalSplit,
  type EarlyBuy,
  GAIN_NEITHER_PCT,
  GAIN_SL_PCT,
  GAIN_X2_PCT,
  type GroupMetrics,
  groupMetrics,
  parseBuyerRow,
  parseOutcomeRow,
  parseYoungCalmRow,
  runWalletStudy,
  sampleControlWallets,
  seededRng,
  selectSmartWallets,
  type SmartWallet,
  smartDelays,
  type StudyToken,
  tradeGainPct,
  walletHitsPerMint,
  walletStudyVerdict,
  walletTokens,
} from './wallet-study.ts';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const addr = (prefix: string, i: number) =>
  prefix + B58[Math.floor(i / 3364) % 58] + B58[Math.floor(i / 58) % 58] + B58[i % 58] + 'pump';
const mint = (i: number) => addr('D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRH', i);
const wal = (i: number) => addr('D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRw', i);
const T0 = Date.UTC(2026, 10, 1, 0, 0, 0);
const H = 3_600_000;

const tok = (i: number, over: Partial<StudyToken> = {}): StudyToken => ({
  mint: mint(i),
  detectedMs: T0 + i * H,
  hitX3: false,
  x2First: false,
  slFirst: false,
  maxMultiple: 1.2,
  hoursToX2: null,
  hoursToX3: null,
  ageH: 5,
  ...over,
});
const buy = (m: number, w: number, over: Partial<EarlyBuy> = {}): EarlyBuy => ({
  mint: mint(m),
  wallet: wal(w),
  tsMs: T0 + m * H - 30 * 60_000,
  solAmount: 1,
  rank: 10,
  ...over,
});
const metrics = (over: Partial<GroupMetrics>): GroupMetrics => ({
  n: 40,
  pct_x2_first: 0,
  pct_sl_first: 0,
  pct_neither: 0,
  mean_gain_pct: 10,
  ci95: [2, 20],
  ...over,
});

describe('wallet-study: parsing', () => {
  it('synthetic addresses are valid Solana addresses', () => {
    for (const i of [0, 1, 57, 58, 3364, 9999]) {
      assert.ok(isSolanaAddress(mint(i)), mint(i));
      assert.ok(isSolanaAddress(wal(i)), wal(i));
    }
  });
  it('parses outcome rows (strings / JSON text features), rejects incomplete labels', () => {
    const r = parseOutcomeRow({
      mint: mint(1),
      detected_at: '2026-11-01T00:00:00Z',
      hit_x3: 't',
      x2_before_sl30: 'true',
      sl30_before_x2: false,
      max_multiple_7d: '3.4',
      hours_to_x2: '1.5',
      hours_to_x3: null,
      features: JSON.stringify({ log_age_h: Math.log1p(10) }),
    }) as StudyToken;
    assert.ok(r);
    assert.equal(r.hitX3, true);
    assert.equal(r.x2First, true);
    assert.equal(r.maxMultiple, 3.4);
    assert.equal(r.hoursToX2, 1.5);
    assert.ok(Math.abs((r.ageH ?? 0) - 10) < 1e-9);
    const base = { mint: mint(1), detected_at: '2026-11-01T00:00:00Z', hit_x3: false, x2_before_sl30: false, sl30_before_x2: false, features: {} };
    assert.equal(parseOutcomeRow(base)?.ageH, null);
    assert.equal(parseOutcomeRow({ ...base, x2_before_sl30: null }), null);
    assert.equal(parseOutcomeRow({ ...base, x2_before_sl30: true, sl30_before_x2: true }), null);
    assert.equal(parseOutcomeRow({ ...base, mint: '<script>' }), null);
    assert.equal(parseOutcomeRow(null), null);
    assert.equal(ageFromLogAge(-1), null);
    assert.equal(ageFromLogAge('x'), null);
  });
  it('parses buyer and young_calm rows', () => {
    const b = parseBuyerRow({ mint: mint(1), wallet: wal(2), ts: '2026-11-01T00:00:00Z', sol_amount: '0.5', rank: '3' });
    assert.deepEqual(b, { mint: mint(1), wallet: wal(2), tsMs: Date.parse('2026-11-01T00:00:00Z'), solAmount: 0.5, rank: 3 });
    assert.equal(parseBuyerRow({ mint: mint(1), wallet: wal(2), ts: '2026-11-01T00:00:00Z', rank: 51 }), null);
    assert.equal(parseBuyerRow({ mint: mint(1), wallet: wal(2), ts: '2026-11-01T00:00:00Z', rank: 1.5 }), null);
    assert.equal(parseBuyerRow({ mint: mint(1), wallet: wal(2), ts: null, rank: 4 })?.tsMs, null); // undated: kept
    assert.equal(parseBuyerRow({ mint: mint(1), wallet: 'nope', ts: '2026-11-01T00:00:00Z', rank: 1 }), null);
    assert.deepEqual(parseYoungCalmRow({ mint: mint(1), detected_at: '2026-11-01T01:00:00Z' }), {
      mint: mint(1),
      detectedMs: Date.parse('2026-11-01T01:00:00Z'),
    });
    assert.equal(parseYoungCalmRow({ mint: mint(1), detected_at: 'garbage' }), null);
  });
  it('candlePeakMs: highest high over the rows, earliest on ties, null when none', () => {
    const row = (tsStart: string, ts: number[], h: number[]) => ({
      tf: '5m', step_s: 300, ts_start: tsStart, ts, o: h.map(() => 1), h, l: h.map(() => 0.5), c: h.map(() => 1), v: h.map(() => 10),
    });
    const start = '2026-11-01T00:00:00.000Z';
    const t = Date.parse(start);
    assert.equal(candlePeakMs([row(start, [0, 300, 600], [2, 5, 3])]), t + 300_000);
    assert.equal(candlePeakMs([row(start, [0, 300], [5, 5])]), t);
    assert.equal(candlePeakMs([row(start, [0], [2]), row('2026-11-01T01:00:00.000Z', [0], [9])]), t + 3_600_000);
    assert.equal(candlePeakMs([{ tf: 'bad' }]), null);
    assert.equal(candlePeakMs([]), null);
  });
});

describe('wallet-study: split and wallets', () => {
  it('chronological split 60/40 (floor), order by detected_at then mint', () => {
    const ts = [5, 1, 3, 2, 4].map((i) => tok(i));
    const { a, b } = chronologicalSplit(ts);
    assert.deepEqual(a.map((t) => t.mint), [mint(1), mint(2), mint(3)]);
    assert.deepEqual(b.map((t) => t.mint), [mint(4), mint(5)]);
    assert.equal(chronologicalSplit(ts.slice(0, 1)).a.length, 0);
    const same = [tok(2, { detectedMs: T0 }), tok(1, { detectedMs: T0 })];
    assert.deepEqual(chronologicalSplit(same, 0.5).a.map((t) => t.mint), [mint(1)]);
  });
  it('broad wallets: strictly more than 30 % of the tokens', () => {
    const mints = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(mint));
    const buys = [0, 1, 2].map((m) => buy(m, 1)).concat([0, 1, 2, 3].map((m) => buy(m, 2)), [buy(20, 3), buy(21, 3), buy(22, 3), buy(23, 3)]);
    assert.deepEqual([...broadWallets(buys, mints)], [wal(2)]); // 3/10 = 30 % kept, 4/10 excluded, out-of-set mints ignored
    assert.equal(broadWallets(buys, new Set()).size, 0);
  });
  it('walletTokens: rank cap, exclusion, distinct mints', () => {
    const buys = [buy(1, 1), buy(1, 1, { rank: 2 }), buy(2, 1, { rank: 51 }), buy(3, 2)];
    const w = walletTokens(buys, new Set([mint(1), mint(2), mint(3)]), new Set([wal(2)]));
    assert.deepEqual([...w.keys()], [wal(1)]);
    assert.deepEqual([...(w.get(wal(1)) ?? [])], [mint(1)]);
  });
  it('smart wallets: ≥ 3 ×3 tokens AND rate ≥ 2 × base', () => {
    // 12 A tokens, 3 ×3 (0, 1, 2) → base 25 %, threshold 50 %.
    const a = Array.from({ length: 12 }, (_, i) => tok(i, { hitX3: i < 3 }));
    const w = new Map<string, Set<string>>([
      [wal(1), new Set([0, 1, 2].map(mint))], // 3/3 → smart
      [wal(2), new Set([0, 1, 2, 3, 4, 5].map(mint))], // 3/6 = 50 % → smart (≥)
      [wal(3), new Set([0, 1, 2, 3, 4, 5, 6].map(mint))], // 3/7 < 50 %
      [wal(4), new Set([0, 1].map(mint))], // 2 ×3 only
    ]);
    const { baseRate, smart } = selectSmartWallets(a, w);
    assert.equal(baseRate, 0.25);
    assert.deepEqual(smart.map((s) => [s.wallet, s.a_tokens, s.a_x3_tokens]), [[wal(1), 3, 3], [wal(2), 6, 3]]);
    assert.deepEqual(selectSmartWallets([], w), { baseRate: null, smart: [] });
  });
  it('control: same A activity, without replacement, nearest count fallback, deterministic', () => {
    const set = (n: number, off: number) => new Set(Array.from({ length: n }, (_, i) => mint(off + i)));
    const w = new Map<string, Set<string>>([
      [wal(1), set(3, 0)], // smart
      [wal(2), set(5, 0)], // smart
      [wal(3), set(5, 10)], // smart, only one 5-token candidate → fallback
      [wal(10), set(3, 20)],
      [wal(11), set(3, 30)],
      [wal(12), set(5, 40)],
      [wal(13), set(7, 50)],
    ]);
    const smart: SmartWallet[] = [1, 2, 3].map((i) => ({ wallet: wal(i), a_tokens: (w.get(wal(i)) as Set<string>).size, a_x3_tokens: 3, x3_rate: 1 }));
    const c1 = sampleControlWallets(w, smart, seededRng(7));
    const c2 = sampleControlWallets(w, smart, seededRng(7));
    assert.deepEqual(c1, c2);
    assert.equal(c1.wallets.length, 3);
    assert.equal(c1.exact, 2);
    assert.equal(c1.fallback, 1);
    assert.ok([wal(10), wal(11)].includes(c1.wallets[0]));
    assert.equal(c1.wallets[1], wal(12));
    assert.equal(new Set(c1.wallets).size, 3);
    for (const x of c1.wallets) assert.ok(![wal(1), wal(2), wal(3)].includes(x));
    const none = sampleControlWallets(new Map([[wal(1), set(3, 0)]]), smart.slice(0, 1), seededRng(1));
    assert.deepEqual(none, { wallets: [], exact: 0, fallback: 0, unmatched: 1 });
  });
  it('walletHitsPerMint counts distinct set wallets per mint', () => {
    const hits = walletHitsPerMint([buy(1, 1), buy(1, 1), buy(1, 2), buy(2, 3), buy(3, 1, { rank: 51 })], new Set([wal(1), wal(2)]));
    assert.deepEqual([...hits], [[mint(1), 2]]);
  });
});

describe('wallet-study: metrics, bootstrap, verdict', () => {
  it('trade gain: +97 / −33 / −3', () => {
    assert.equal(tradeGainPct({ x2First: true, slFirst: false }), GAIN_X2_PCT);
    assert.equal(tradeGainPct({ x2First: false, slFirst: true }), GAIN_SL_PCT);
    assert.equal(tradeGainPct({ x2First: false, slFirst: false }), GAIN_NEITHER_PCT);
    assert.deepEqual([GAIN_X2_PCT, GAIN_SL_PCT, GAIN_NEITHER_PCT], [97, -33, -3]);
  });
  it('seeded rng is deterministic and in [0, 1)', () => {
    const a = seededRng(42);
    const b = seededRng(42);
    for (let i = 0; i < 100; i++) {
      const x = a();
      assert.equal(x, b());
      assert.ok(x >= 0 && x < 1);
    }
    assert.notEqual(seededRng(1)(), seededRng(2)());
  });
  it('bootstrap CI: deterministic, brackets the mean, degenerate on constants, null when empty', () => {
    const xs = [97, -33, -3, 97, -33, 97, -3, -33, 97, 97];
    const ci = bootstrapMeanCI(xs, seededRng(1)) as [number, number];
    assert.deepEqual(ci, bootstrapMeanCI(xs, seededRng(1)));
    const m = xs.reduce((s, x) => s + x, 0) / xs.length;
    assert.ok(ci[0] < m && m < ci[1]);
    assert.deepEqual(bootstrapMeanCI([5, 5, 5], seededRng(1)), [5, 5]);
    assert.equal(bootstrapMeanCI([], seededRng(1)), null);
    const d = bootstrapDiffCI(Array(40).fill(97), Array(40).fill(-33), seededRng(1));
    assert.deepEqual(d, [130, 130]);
    assert.equal(bootstrapDiffCI([1], [], seededRng(1)), null);
  });
  it('groupMetrics: shares, mean gain, empty group', () => {
    const g = groupMetrics([tok(1, { x2First: true }), tok(2, { slFirst: true }), tok(3), tok(4, { x2First: true })], seededRng(3), 200);
    assert.equal(g.n, 4);
    assert.equal(g.pct_x2_first, 50);
    assert.equal(g.pct_sl_first, 25);
    assert.equal(g.pct_neither, 25);
    assert.equal(g.mean_gain_pct, (97 * 2 - 33 - 3) / 4);
    assert.ok(g.ci95);
    assert.deepEqual(groupMetrics([], seededRng(3)), {
      n: 0, pct_x2_first: null, pct_sl_first: null, pct_neither: null, mean_gain_pct: null, ci95: null,
    });
  });
  it('verdict rules fixed in advance', () => {
    const ctl = metrics({ mean_gain_pct: -10, ci95: [-20, 0] });
    assert.equal(walletStudyVerdict(metrics({}), ctl, [5, 30]).label, 'piste confirmée');
    assert.equal(walletStudyVerdict(metrics({ n: 29 }), ctl, [5, 30]).label, 'piste incertaine');
    assert.equal(walletStudyVerdict(metrics({ ci95: [-1, 20] }), ctl, [5, 30]).label, 'piste incertaine');
    assert.equal(walletStudyVerdict(metrics({}), ctl, [-1, 30]).label, 'piste incertaine');
    assert.equal(walletStudyVerdict(metrics({}), ctl, null).label, 'piste incertaine');
    assert.equal(walletStudyVerdict(metrics({ mean_gain_pct: -12 }), ctl, [-5, 3]).label, 'piste réfutée');
    assert.equal(walletStudyVerdict(metrics({ mean_gain_pct: -10 }), ctl, [-5, 5]).label, 'piste réfutée'); // equal → not better
    assert.equal(walletStudyVerdict(metrics({ n: 0, mean_gain_pct: null, ci95: null }), ctl, null).label, 'piste réfutée');
    const empty = metrics({ n: 0, mean_gain_pct: null, ci95: null });
    assert.equal(walletStudyVerdict(metrics({}), empty, null).label, 'piste incertaine');
    assert.equal(walletStudyVerdict(metrics({ mean_gain_pct: -1 }), empty, null).label, 'piste réfutée');
  });
});

describe('wallet-study: delays', () => {
  it('measured from the first smart buy per token', () => {
    const t = tok(10, { hoursToX2: 2, hoursToX3: 5 }); // detected T0 + 10 h
    const buys = [buy(10, 1, { tsMs: T0 + 9 * H }), buy(10, 2, { tsMs: T0 + 8 * H }), buy(10, 3, { tsMs: T0 })];
    const d = smartDelays(
      [t, tok(11)],
      buys,
      new Set([wal(1), wal(2)]),
      new Map([[mint(10), T0 + 14 * H]]),
      new Map([[mint(10), T0 + 7 * H]]),
    );
    assert.equal(d.tokens, 1);
    assert.deepEqual(d.buy_to_detection, { n: 1, median_h: 2 });
    assert.equal(d.pct_bought_before_detection, 100);
    assert.deepEqual(d.buy_to_x2, { n: 1, median_h: 4 });
    assert.deepEqual(d.buy_to_x3, { n: 1, median_h: 7 });
    assert.deepEqual(d.buy_to_candle_peak, { n: 1, median_h: 6 });
    assert.deepEqual(d.buy_to_young_calm, { n: 1, median_h: -1 });
    assert.equal(d.pct_with_young_calm, 100);
    assert.equal(d.pct_bought_before_young_calm, 0);
    const undated = smartDelays([t], [buy(10, 1, { tsMs: null })], new Set([wal(1)]), new Map(), new Map());
    assert.equal(undated.tokens, 0);
    const empty = smartDelays([t], buys, new Set(), new Map(), new Map());
    assert.equal(empty.tokens, 0);
    assert.equal(empty.buy_to_detection.median_h, null);
    assert.equal(empty.pct_bought_before_detection, null);
  });
});

// Synthetic world: 100 tokens (A = 0–59, B = 60–99). On A, tokens 0–9 hit ×3 (base 1/6). Smart wallets 1 and 2,
// non-smart look-alikes, a launch bot in every token, activity-matched control candidates. On B the smart wallets
// buy tokens that mostly ×2 first, the control candidates buy tokens that hit the stop.
function world(smartEdge: boolean) {
  const tokens: StudyToken[] = [];
  for (let i = 0; i < 100; i++) {
    const inA = i < 60;
    const young = i % 2 === 0;
    const x2 = inA ? i < 10 : smartEdge ? i < 92 : i >= 92;
    tokens.push(tok(i, {
      hitX3: inA ? i < 10 : x2,
      x2First: x2,
      slFirst: !x2 && i % 3 !== 0,
      hoursToX2: x2 ? 3 : null,
      ageH: young ? 4 : 60,
    }));
  }
  tokens.push(tok(200)); // labelled but no early buyer → excluded
  const buys: EarlyBuy[] = [];
  for (let i = 0; i < 100; i++) buys.push(buy(i, 99, { rank: 1 })); // launch bot (100 %)
  for (let i = 0; i < 100; i++) buys.push(buy(i, 1000 + i, { rank: 20 })); // one-off wallets
  for (const m of [0, 1, 2, 3]) buys.push(buy(m, 1)); // smart 1: 4/4 ×3
  for (const m of [4, 5, 6, 20, 21, 22]) buys.push(buy(m, 2)); // smart 2: 3/6 = 50 % ≥ 2 × 16.7 %
  for (const m of [7, 8, 9, 23, 24, 25, 26, 27, 28, 29, 30, 31]) buys.push(buy(m, 3)); // 3/12 = 25 % → not smart
  for (const m of [40, 41, 42, 43]) buys.push(buy(m, 10)); // control candidates with 4 A tokens
  for (const m of [44, 45, 46, 47, 48, 49]) buys.push(buy(m, 11)); // … and with 6
  for (let i = 60; i < 92; i++) buys.push(buy(i, 1 + (i % 2), { tsMs: T0 + i * H - 2 * H })); // smart on 32 B tokens
  for (let i = 60; i < 64; i++) buys.push(buy(i, 2 - (i % 2))); // both smart → ≥ 2 on 60–63
  for (let i = 92; i < 100; i++) buys.push(buy(i, 10 + (i % 2))); // control on the 8 last B tokens
  buys.push(buy(60, 3, { tsMs: null })); // undated buy: membership only
  const youngCalm = new Map(tokens.filter((t) => t.ageH === 4).map((t) => [t.mint, t.detectedMs + H]));
  return { tokens, buys, youngCalmMs: youngCalm };
}

describe('wallet-study: runWalletStudy end to end (synthetic)', () => {
  it('finds the smart wallets on A only, confirms an obvious edge, deterministic', () => {
    const w = world(true);
    const r = runWalletStudy(w, { resamples: 500, robustnessDraws: 10 });
    assert.deepEqual(r, runWalletStudy(w, { resamples: 500, robustnessDraws: 10 }));
    assert.equal(r.n_tokens.labelled, 101);
    assert.equal(r.n_tokens.excluded_no_early_buyers, 1);
    assert.equal(r.n_tokens.a, 60);
    assert.equal(r.n_tokens.b, 40);
    assert.equal(r.n_tokens.b_young, 20);
    assert.equal(r.wallets.broad_excluded, 1);
    assert.ok(Math.abs((r.wallets.base_x3_rate_a ?? 0) - 1 / 6) < 1e-3);
    assert.deepEqual(r.wallets.smart.map((s) => s.wallet), [wal(1), wal(2)]);
    assert.equal(r.wallets.control.n, 2);
    assert.equal(r.wallets.control.exact_activity_match, 2);
    const t = r.b_table.all;
    assert.equal(t.smart_ge1.n, 32);
    assert.equal(t.smart_ge1.pct_x2_first, 100);
    assert.equal(t.smart_ge2.n, 4);
    assert.equal(t.none.n, 8);
    assert.equal(t.control.n, 8);
    assert.equal(t.smart_ge1_bought_before_detection.n, 32);
    assert.ok((t.diff_vs_control.ci95 as [number, number])[0] > 0);
    assert.equal(r.verdict.label, 'piste confirmée');
    assert.equal(r.b_table.young.smart_ge1.n, 16);
    assert.equal(r.verdict_young_informative.label, 'piste incertaine'); // < 30 tokens
    assert.equal(r.delays.b.tokens, 32);
    assert.equal(r.delays.b.buy_to_detection.median_h, 2);
    assert.equal(r.delays.b.buy_to_x2.median_h, 5);
    assert.equal(r.delays.b.pct_with_young_calm, 50);
    assert.equal(r.control_robustness.pct_draws_smart_better, 100);
  });
  it('refutes when the « smart » tokens do worse than the control', () => {
    const r = runWalletStudy(world(false), { resamples: 300, robustnessDraws: 5 });
    assert.equal(r.verdict.label, 'piste réfutée');
  });
  it('empty input does not throw', () => {
    const r = runWalletStudy({ tokens: [], buys: [] }, { resamples: 10, robustnessDraws: 2 });
    assert.equal(r.n_tokens.a, 0);
    assert.equal(r.wallets.n_smart, 0);
    assert.equal(r.verdict.label, 'piste réfutée');
  });
});
