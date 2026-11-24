// Runs with `deno test supabase/functions` (node:test is supported by Deno)
// and with `node --experimental-strip-types --test` for quick local checks.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSolanaAddress } from './solana';
import {
  applyAgeQuota,
  countBySource,
  DEFAULT_CAP_PER_SOURCE,
  detectMigrations,
  isSourceName,
  isYoungAge,
  LEGACY_SOURCE_NAMES,
  legacySourcesColumn,
  MAX_SOURCES_COLUMN,
  mergeSources,
  OLD_KEPT_MAX,
  OLD_KEPT_MIN,
  oldKeptCap,
  prioritizeMints,
  SOURCE_NAMES,
  sourcesColumn,
  type SourceName,
} from './sources';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Deterministic valid mint: base58 of 32 bytes derived from n. */
function mint(n: number): string {
  const bytes = new Uint8Array(32);
  bytes[0] = 1 + (n % 200);
  bytes[1] = Math.floor(n / 200) % 256;
  for (let i = 2; i < 32; i++) bytes[i] = (n * 31 + i * 7) % 256;
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let out = '';
  while (num > 0n) {
    out = ALPHABET[Number(num % 58n)] + out;
    num /= 58n;
  }
  return out;
}

const A = mint(1);
const B = mint(2);
const C = mint(3);
const D = mint(4);
const E = mint(5);

describe('test fixtures', () => {
  it('generates valid, distinct mints', () => {
    const all = Array.from({ length: 300 }, (_, i) => mint(i));
    for (const m of all) assert.ok(isSolanaAddress(m), m);
    assert.equal(new Set(all).size, all.length);
  });
});

describe('SOURCE_NAMES / isSourceName', () => {
  it('lists the 11 active sources (chore/slim-down: Jupiter toplists and GeckoTerminal trending removed, new pools / recent added)', () => {
    assert.deepEqual(
      [...SOURCE_NAMES],
      [
        'dex_profiles',
        'dex_boosts_latest',
        'dex_boosts_top',
        'dex_cto',
        'dex_search',
        'gecko_trending_1h',
        'gecko_pumpswap',
        'gecko_new_pools',
        'jup_recent',
        'migration',
        'young_watch',
      ],
    );
  });

  it('LEGACY_SOURCE_NAMES = the active names accepted before migration 20261121020000 (no new pools / recent)', () => {
    assert.equal(LEGACY_SOURCE_NAMES.size, 9);
    assert.equal(LEGACY_SOURCE_NAMES.has('gecko_new_pools'), false);
    assert.equal(LEGACY_SOURCE_NAMES.has('jup_recent'), false);
    assert.equal(LEGACY_SOURCE_NAMES.has('young_watch'), true);
    for (const s of LEGACY_SOURCE_NAMES) assert.ok(SOURCE_NAMES.includes(s));
  });

  it('removed sources are no longer allowlisted by the code (the SQL CHECK keeps them for the history)', () => {
    for (const s of ['gecko_trending', 'gecko_volume', 'jup_trending_1h', 'jup_organic_6h', 'jup_traded_1h']) assert.equal(isSourceName(s), false);
  });

  it('accepts every allowlisted name', () => {
    for (const s of SOURCE_NAMES) assert.equal(isSourceName(s), true);
  });

  it('rejects unknown, case variants, prototype keys and non-strings', () => {
    for (const x of ['', 'DEX_PROFILES', 'dex_profiles ', 'unknown', 'toString', '__proto__', null, undefined, 1, {}, ['migration']]) {
      assert.equal(isSourceName(x), false, String(x));
    }
  });
});

describe('mergeSources', () => {
  it('returns an empty map for no lists or empty lists', () => {
    assert.equal(mergeSources([]).size, 0);
    assert.equal(mergeSources([{ source: 'dex_profiles', mints: [] }]).size, 0);
  });

  it('dedups within and across lists, sources in SOURCE_NAMES order', () => {
    const m = mergeSources([
      { source: 'migration', mints: [A, A, B] },
      { source: 'dex_profiles', mints: [B, A] },
      { source: 'jup_recent', mints: [A] },
    ]);
    assert.deepEqual([...m.keys()], [A, B]);
    assert.deepEqual(m.get(A), ['dex_profiles', 'jup_recent', 'migration']);
    assert.deepEqual(m.get(B), ['dex_profiles', 'migration']);
  });

  it('keeps first-seen insertion order across lists', () => {
    const m = mergeSources([
      { source: 'dex_boosts_latest', mints: [C, A] },
      { source: 'dex_profiles', mints: [B, A, D] },
    ]);
    assert.deepEqual([...m.keys()], [C, A, B, D]);
  });

  it('drops invalid and hostile mints', () => {
    const hostile = [
      '',
      'not-a-mint',
      '<script>alert(1)</script>',
      `${A} `,
      ` ${A}`,
      `\u202E${A}`,
      `${A}\u0000`,
      'O0Il' + A.slice(4), // chars outside base58 alphabet
      A.slice(0, 20),
      A + A,
      '1111111111111111111111111111111', // 31 chars
    ];
    const m = mergeSources([
      { source: 'dex_search', mints: [...hostile, B, null as unknown as string, 42 as unknown as string] },
    ]);
    assert.deepEqual([...m.keys()], [B]);
  });

  it('ignores lists whose source is not allowlisted or whose mints is not an array', () => {
    const m = mergeSources([
      { source: 'evil' as SourceName, mints: [A] },
      { source: 'dex_cto', mints: 'nope' as unknown as string[] },
      { source: 'dex_cto', mints: [B] },
    ]);
    assert.deepEqual([...m.keys()], [B]);
    assert.deepEqual(m.get(B), ['dex_cto']);
  });

  it('applies the default cap of 100 per source', () => {
    assert.equal(DEFAULT_CAP_PER_SOURCE, 100);
    const many = Array.from({ length: 150 }, (_, i) => mint(i + 10));
    const m = mergeSources([{ source: 'dex_boosts_top', mints: many }]);
    assert.equal(m.size, 100);
    assert.deepEqual([...m.keys()], many.slice(0, 100));
  });

  it('counts the cap on distinct valid mints only (invalid and duplicates do not consume it)', () => {
    const m = mergeSources([{ source: 'dex_search', mints: ['bad', A, A, 'bad2', B, C] }], { capPerSource: 2 });
    assert.deepEqual([...m.keys()], [A, B]);
  });

  it('shares the cap across several lists of the same source', () => {
    const m = mergeSources(
      [
        { source: 'dex_search', mints: [A, B] },
        { source: 'dex_search', mints: [B, C, D] },
        { source: 'dex_profiles', mints: [D] },
      ],
      { capPerSource: 3 },
    );
    assert.deepEqual([...m.keys()], [A, B, C, D]);
    assert.deepEqual(m.get(C), ['dex_search']);
    assert.deepEqual(m.get(D), ['dex_profiles']);
  });

  it('cap applies per source independently', () => {
    const m = mergeSources(
      [
        { source: 'dex_profiles', mints: [A, B, C] },
        { source: 'migration', mints: [C, D, E] },
      ],
      { capPerSource: 1 },
    );
    assert.deepEqual([...m.keys()], [A, C]);
    assert.deepEqual(m.get(A), ['dex_profiles']);
    assert.deepEqual(m.get(C), ['migration']);
  });

  it('handles cap edge values (0, negative, fractional, NaN, Infinity)', () => {
    const lists = [{ source: 'dex_profiles' as const, mints: [A, B, C] }];
    assert.equal(mergeSources(lists, { capPerSource: 0 }).size, 0);
    assert.equal(mergeSources(lists, { capPerSource: -5 }).size, 0);
    assert.equal(mergeSources(lists, { capPerSource: 2.9 }).size, 2);
    assert.equal(mergeSources(lists, { capPerSource: Number.NaN }).size, 3);
    assert.equal(mergeSources(lists, { capPerSource: Infinity }).size, 3);
  });

  it('does not mutate inputs and is deterministic', () => {
    const mints = [B, A, B];
    const lists = [
      { source: 'migration' as const, mints },
      { source: 'dex_profiles' as const, mints: [A] },
    ];
    const r1 = mergeSources(lists);
    const r2 = mergeSources(lists);
    assert.deepEqual([...r1.entries()], [...r2.entries()]);
    assert.deepEqual(mints, [B, A, B]);
  });
});

describe('detectMigrations', () => {
  it('returns [] for empty maps', () => {
    assert.deepEqual(detectMigrations(new Map(), new Map()), []);
  });

  it('detects pumpfun -> pumpswap and pumpfun -> raydium variants, sorted', () => {
    const prev = new Map([
      [A, 'pumpfun'],
      [B, 'pumpfun'],
      [C, 'pumpfun'],
      [D, 'pumpfun'],
    ]);
    const cur = new Map([
      [D, 'pumpswap'],
      [C, 'raydium'],
      [B, 'Raydium-CLMM'],
      [A, 'PUMPSWAP'],
    ]);
    assert.deepEqual(detectMigrations(prev, cur), [A, B, C, D].sort());
  });

  it('requires previous dexId to be exactly pumpfun (case-sensitive)', () => {
    const prev = new Map([
      [A, 'PumpFun'],
      [B, 'pumpfun '],
      [C, 'raydium'],
      [D, 'pumpswap'],
    ]);
    const cur = new Map([
      [A, 'pumpswap'],
      [B, 'pumpswap'],
      [C, 'raydium'],
      [D, 'raydium'],
    ]);
    assert.deepEqual(detectMigrations(prev, cur), []);
  });

  it('ignores mints still on pumpfun, moved elsewhere, or missing on either side', () => {
    const prev = new Map([
      [A, 'pumpfun'],
      [B, 'pumpfun'],
      [C, 'pumpfun'],
    ]);
    const cur = new Map([
      [A, 'pumpfun'],
      [B, 'meteora'],
      [D, 'pumpswap'],
    ]);
    assert.deepEqual(detectMigrations(prev, cur), []);
  });

  it('rejects near-miss current dexIds', () => {
    const prev = new Map([
      [A, 'pumpfun'],
      [B, 'pumpfun'],
    ]);
    const cur = new Map([
      [A, 'pumpswap2'],
      [B, 'raydum'],
    ]);
    assert.deepEqual(detectMigrations(prev, cur), []);
  });

  it('ignores invalid mint keys', () => {
    const prev = new Map([
      ['<script>', 'pumpfun'],
      [A, 'pumpfun'],
    ]);
    const cur = new Map([
      ['<script>', 'pumpswap'],
      [A, 'pumpswap'],
    ]);
    assert.deepEqual(detectMigrations(prev, cur), [A]);
  });
});

describe('countBySource', () => {
  it('returns zeros for every source on empty input', () => {
    const c = countBySource(new Map(), new Set());
    assert.deepEqual(Object.keys(c), [...SOURCE_NAMES]);
    for (const s of SOURCE_NAMES) assert.deepEqual(c[s], { seen: 0, kept: 0, unique: 0, uniqueKept: 0 });
  });

  it('computes seen, kept, unique and uniqueKept', () => {
    const merged = new Map<string, SourceName[]>([
      [A, ['dex_profiles', 'migration']],
      [B, ['dex_profiles']],
      [C, ['migration']],
      [D, ['dex_profiles']],
      [E, ['dex_boosts_latest', 'migration']],
    ]);
    const kept = new Set([A, B, C]);
    const c = countBySource(merged, kept);
    assert.deepEqual(c.dex_profiles, { seen: 3, kept: 2, unique: 2, uniqueKept: 1 });
    assert.deepEqual(c.migration, { seen: 3, kept: 2, unique: 1, uniqueKept: 1 });
    assert.deepEqual(c.dex_boosts_latest, { seen: 1, kept: 0, unique: 0, uniqueKept: 0 });
    assert.deepEqual(c.jup_recent, { seen: 0, kept: 0, unique: 0, uniqueKept: 0 });
  });

  it('ignores kept mints absent from merged', () => {
    const merged = new Map<string, SourceName[]>([[A, ['dex_cto']]]);
    const c = countBySource(merged, new Set([B, C]));
    assert.deepEqual(c.dex_cto, { seen: 1, kept: 0, unique: 1, uniqueKept: 0 });
  });

  it('tolerates duplicate and non-allowlisted source entries', () => {
    const merged = new Map<string, SourceName[]>([
      [A, ['dex_cto', 'dex_cto', 'evil' as SourceName]],
    ]);
    const c = countBySource(merged, new Set([A]));
    assert.deepEqual(c.dex_cto, { seen: 1, kept: 1, unique: 1, uniqueKept: 1 });
    assert.equal(Object.keys(c).length, SOURCE_NAMES.length);
  });

  it('works on mergeSources output', () => {
    const merged = mergeSources([
      { source: 'dex_boosts_latest', mints: [A, B] },
      { source: 'dex_boosts_top', mints: [B] },
    ]);
    const c = countBySource(merged, new Set([B]));
    assert.deepEqual(c.dex_boosts_latest, { seen: 2, kept: 1, unique: 1, uniqueKept: 0 });
    assert.deepEqual(c.dex_boosts_top, { seen: 1, kept: 1, unique: 0, uniqueKept: 0 });
  });
});

describe('prioritizeMints', () => {
  it('returns [] for empty input or non-positive budget', () => {
    assert.deepEqual(prioritizeMints(new Map(), 10), []);
    const m = new Map<string, SourceName[]>([[A, ['dex_profiles']]]);
    assert.deepEqual(prioritizeMints(m, 0), []);
    assert.deepEqual(prioritizeMints(m, -1), []);
    assert.deepEqual(prioritizeMints(m, Number.NaN), []);
    assert.deepEqual(prioritizeMints(m, 0.5), []);
  });

  it('returns all mints in insertion order when within budget', () => {
    const m = new Map<string, SourceName[]>([
      [C, ['dex_profiles']],
      [A, ['dex_profiles', 'migration', 'dex_boosts_latest']],
      [B, ['jup_recent']],
    ]);
    assert.deepEqual(prioritizeMints(m, 3), [C, A, B]);
    assert.deepEqual(prioritizeMints(m, 10), [C, A, B]);
    assert.deepEqual(prioritizeMints(m, Infinity), [C, A, B]);
  });

  it('over budget: more sources first', () => {
    const m = new Map<string, SourceName[]>([
      [A, ['dex_profiles']],
      [B, ['dex_profiles', 'dex_boosts_latest']],
      [C, ['dex_profiles', 'dex_boosts_latest', 'dex_cto']],
    ]);
    assert.deepEqual(prioritizeMints(m, 2), [C, B]);
  });

  it('over budget: migration and Jupiter organic break ties before insertion order', () => {
    const m = new Map<string, SourceName[]>([
      [A, ['dex_profiles']],
      [B, ['dex_search']],
      [C, ['migration']],
      [D, ['gecko_new_pools']],
      [E, ['jup_recent']],
    ]);
    assert.deepEqual(prioritizeMints(m, 3), [C, D, E]);
    assert.deepEqual(prioritizeMints(m, 4), [C, D, E, A]);
  });

  it('source count outranks priority sources', () => {
    const m = new Map<string, SourceName[]>([
      [A, ['migration']],
      [B, ['dex_profiles', 'dex_boosts_top']],
    ]);
    assert.deepEqual(prioritizeMints(m, 1), [B]);
  });

  it('full ties keep insertion order', () => {
    const m = new Map<string, SourceName[]>([
      [D, ['dex_search']],
      [B, ['dex_search']],
      [A, ['dex_search']],
    ]);
    assert.deepEqual(prioritizeMints(m, 2), [D, B]);
  });

  it('counts distinct allowlisted sources only', () => {
    const m = new Map<string, SourceName[]>([
      [A, ['dex_cto', 'dex_cto', 'evil' as SourceName]],
      [B, ['dex_cto', 'dex_boosts_top']],
    ]);
    assert.deepEqual(prioritizeMints(m, 1), [B]);
  });

  it('floors fractional budgets and is deterministic', () => {
    const m = new Map<string, SourceName[]>(
      Array.from({ length: 20 }, (_, i) => [mint(i + 50), i % 3 === 0 ? ['migration'] : ['dex_profiles']] as [string, SourceName[]]),
    );
    const r1 = prioritizeMints(m, 5.9);
    assert.equal(r1.length, 5);
    assert.deepEqual(r1, prioritizeMints(m, 5));
    assert.deepEqual(r1, [0, 3, 6, 9, 12].map((i) => mint(i + 50)));
  });
});

describe('sourcesColumn', () => {
  it('returns [] for empty input', () => {
    assert.deepEqual(sourcesColumn([]), []);
  });

  it('dedups and sorts in SOURCE_NAMES order', () => {
    assert.deepEqual(sourcesColumn(['migration', 'dex_profiles', 'migration', 'dex_boosts_latest']), [
      'dex_profiles',
      'dex_boosts_latest',
      'migration',
    ]);
  });

  it('drops non-allowlisted entries', () => {
    assert.deepEqual(sourcesColumn(['<img src=x>' as SourceName, 'dex_cto', '' as SourceName]), ['dex_cto']);
  });

  it('caps at 10 entries, keeping the first ones in canonical order', () => {
    assert.equal(MAX_SOURCES_COLUMN, 10);
    const all = [...SOURCE_NAMES].reverse();
    const col = sourcesColumn(all);
    assert.equal(col.length, 10);
    assert.deepEqual(col, SOURCE_NAMES.slice(0, 10));
  });

  it('returns a new array', () => {
    const input: SourceName[] = ['dex_cto'];
    const out = sourcesColumn(input);
    assert.notEqual(out, input);
  });
});

describe('countBySource young counters (seen / kept / young / youngKept per source)', () => {
  it('adds young / youngKept only when youngMints is given', () => {
    const merged = new Map<string, SourceName[]>([
      [A, ['gecko_pumpswap', 'young_watch']],
      [B, ['gecko_pumpswap']],
      [C, ['dex_cto']],
    ]);
    const c = countBySource(merged, new Set([A, C]), new Set([A, B]));
    assert.deepEqual(c.gecko_pumpswap, { seen: 2, kept: 1, unique: 1, uniqueKept: 0, young: 2, youngKept: 1 });
    assert.deepEqual(c.young_watch, { seen: 1, kept: 1, unique: 0, uniqueKept: 0, young: 1, youngKept: 1 });
    assert.deepEqual(c.dex_cto, { seen: 1, kept: 1, unique: 1, uniqueKept: 1, young: 0, youngKept: 0 });
    assert.equal('young' in countBySource(merged, new Set([A]))[SOURCE_NAMES[0]], false);
  });

  it('17 sources × 6 counters fit the scan_runs.source_counts CHECK (≤ 8192 bytes)', () => {
    const big = Object.fromEntries(
      SOURCE_NAMES.map((n) => [n, { seen: 99_999, kept: 99_999, unique: 99_999, uniqueKept: 99_999, young: 99_999, youngKept: 99_999 }]),
    );
    assert.ok(new TextEncoder().encode(JSON.stringify(big)).length <= 8192);
  });
});

describe('prioritizeMints: young sources (fix/young-sources)', () => {
  it('gecko_trending_1h / gecko_pumpswap / young_watch beat the old toplists at equal source count', () => {
    const merged = new Map<string, SourceName[]>([
      [A, ['dex_cto']],
      [B, ['dex_boosts_top']],
      [C, ['gecko_pumpswap']],
      [D, ['young_watch']],
      [E, ['gecko_trending_1h']],
    ]);
    assert.deepEqual(prioritizeMints(merged, 3), [C, D, E]);
  });
});

describe('legacySourcesColumn', () => {
  it('drops the new names, keeps canonical order and the CHECK cap', () => {
    assert.deepEqual(
      legacySourcesColumn(['jup_recent', 'young_watch', 'migration', 'gecko_new_pools', 'gecko_pumpswap', 'dex_cto', 'evil']),
      ['dex_cto', 'gecko_pumpswap', 'migration', 'young_watch'],
    );
    assert.equal(legacySourcesColumn([...SOURCE_NAMES]).length, LEGACY_SOURCE_NAMES.size);
    assert.deepEqual(legacySourcesColumn([]), []);
  });
});

describe('age quota (fix/young-sources)', () => {
  it('isYoungAge: [0, 24) hours only', () => {
    assert.equal(isYoungAge(0), true);
    assert.equal(isYoungAge(23.99), true);
    assert.equal(isYoungAge(24), false);
    assert.equal(isYoungAge(-1), false);
    assert.equal(isYoungAge(null), false);
    assert.equal(isYoungAge(undefined), false);
    assert.equal(isYoungAge(Number.NaN), false);
  });

  it('oldKeptCap: 40 % young target, clamped to [OLD_KEPT_MIN, OLD_KEPT_MAX]', () => {
    assert.equal(oldKeptCap(0), OLD_KEPT_MIN);
    assert.equal(oldKeptCap(10), OLD_KEPT_MIN); // 15 wanted < floor
    assert.equal(oldKeptCap(40), 60); // 40 / (40 + 60) = 40 %
    assert.equal(oldKeptCap(50), 75);
    assert.equal(oldKeptCap(1000), OLD_KEPT_MAX);
    assert.equal(oldKeptCap(Number.NaN), OLD_KEPT_MIN);
    assert.equal(oldKeptCap(-5), OLD_KEPT_MIN);
    assert.equal(oldKeptCap(10, { target: 0.5, min: 0, max: 100 }), 10);
    assert.equal(oldKeptCap(10, { target: 0, min: 5, max: 7 }), 7); // invalid target → max
    assert.equal(oldKeptCap(10, { min: 50, max: 20 }), 50); // max never below min
    // Measured 21/11: 18–22 young tokens pass the filters with the new sources → 27–33 old slots → ≥ 40 % young.
    assert.equal(OLD_KEPT_MIN, 25);
    assert.equal(oldKeptCap(16), 25);
    assert.equal(oldKeptCap(18), 27);
    assert.equal(oldKeptCap(21), 31);
    for (const y of [17, 18, 19, 20, 21, 22, 40, 41, 47, 53, 60]) assert.ok(y / (y + oldKeptCap(y)) >= 0.4, String(y));
    for (const y of [5, 10, 16]) assert.ok(y / (y + oldKeptCap(y)) < 0.4, `floor wins at ${y}`);
  });

  const tok = (mint: string, ageHours: number | null) => ({ mint, ageHours });

  it('keeps every young token, then the best old ones up to the cap, input order preserved', () => {
    const ranked = [tok(A, 500), tok(B, 2), tok(C, 30), tok(D, null), tok(E, 10)];
    const r = applyAgeQuota(ranked, new Set(), 1);
    assert.deepEqual(r.kept.map((t) => t.mint), [A, B, E]);
    assert.deepEqual(r.dropped.map((t) => t.mint), [C, D]);
  });

  it('forced (tracked) mints are always kept and use old slots first', () => {
    const ranked = [tok(A, 500), tok(B, 300), tok(C, 30), tok(D, 1)];
    const r = applyAgeQuota(ranked, new Set([C]), 1);
    assert.deepEqual(r.kept.map((t) => t.mint), [C, D]);
    assert.deepEqual(r.dropped.map((t) => t.mint), [A, B]);
    // More forced old mints than the cap: all kept, no other old token.
    const r2 = applyAgeQuota(ranked, new Set([A, B, C]), 1);
    assert.deepEqual(r2.kept.map((t) => t.mint), [A, B, C, D]);
  });

  it('a forced young mint does not consume an old slot', () => {
    const r = applyAgeQuota([tok(A, 1), tok(B, 100), tok(C, 200)], new Set([A]), 1);
    assert.deepEqual(r.kept.map((t) => t.mint), [A, B]);
  });

  it('cap 0 / NaN keeps only young + forced; Infinity keeps everything; input not mutated', () => {
    const ranked = [tok(A, 100), tok(B, 1)];
    assert.deepEqual(applyAgeQuota(ranked, new Set(), 0).kept.map((t) => t.mint), [B]);
    assert.deepEqual(applyAgeQuota(ranked, new Set(), Number.NaN).kept.map((t) => t.mint), [B]);
    assert.deepEqual(applyAgeQuota(ranked, new Set(), Infinity).kept.map((t) => t.mint), [A, B]);
    assert.deepEqual(ranked, [tok(A, 100), tok(B, 1)]);
  });

  it('reaches the 40 % share when enough young tokens exist (166 kept / 14 young today → 50 young case)', () => {
    const ranked = [
      ...Array.from({ length: 150 }, (_, i) => tok(mint(100 + i), 200 + i)),
      ...Array.from({ length: 50 }, (_, i) => tok(mint(300 + i), i * 0.4)),
    ];
    const young = ranked.filter((t) => isYoungAge(t.ageHours)).length;
    const { kept } = applyAgeQuota(ranked, new Set(), oldKeptCap(young));
    const share = kept.filter((t) => isYoungAge(t.ageHours)).length / kept.length;
    assert.equal(kept.length, 50 + 75);
    assert.ok(share >= 0.4);
  });
});
