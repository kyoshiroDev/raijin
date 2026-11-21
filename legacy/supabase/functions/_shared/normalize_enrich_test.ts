// Row mapping and write payloads for scan-tokens / enrich-tokens (no zod needed).
// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEnrichmentUpdate,
  ENRICH_UPDATE_COLUMNS,
  ENRICHMENT_MAX_AGE_MS,
  ENRICHMENT_OWNED_COLUMNS,
  ENRICHMENT_SELECT,
  enrichmentFromRow,
  GENERATED_COLUMNS,
  rowToMetrics,
  flagColumns,
  type FlagOutput,
  type ScanItem,
  TOKEN_ROW_SELECT,
  type TokenRow,
  toTokenRow,
} from './normalize.ts';
import { finalFlags, flagItem } from './final-score.ts';
import type { TokenMetrics } from './types.ts';

const NOW = Date.parse('2026-11-16T22:00:00Z');
const MINT = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump';
const PAIR = 'B8a1mw1vfm5pnm4RgUd8zhbtBnkPB2fBMdikU33Z1jqv';
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

/** Shape of a PostgREST row (numeric columns may come back as strings). */
function row(over: Partial<TokenRow> = {}): TokenRow {
  return {
    mint: MINT,
    symbol: 'BAWSAQ',
    name: 'Bawsaq',
    pair_address: PAIR,
    dex_id: 'pumpswap',
    image_url: null,
    website_url: 'https://example.com/',
    x_url: 'https://x.com/bawsaq',
    telegram_url: null,
    price_usd: 0.001661,
    market_cap: '1661000',
    liquidity_usd: 94902.17,
    liquidity_jup_usd: '49063.02', // archived column: never read any more
    price_jup_usd: 0.001814,
    volume_24h: 2_500_000,
    change_5m: 1,
    change_1h: 4,
    change_6h: 12,
    change_24h: 60,
    buys_1h: 400,
    sells_1h: 300,
    buys_24h: 5000,
    sells_24h: 4000,
    pair_created_at: iso(30 * 3_600_000),
    score: 70, // archived column: never read any more
    volume_1h: '12345',
    liquidity_gecko_usd: '95340.4401',
    price_gecko_usd: 0.001652,
    roundtrip_cost_pct: 1.7572,
    roundtrip_fee_pct: 0.0488,
    buy_impact_pct: 0.6919,
    lp_locked_pct: 99.99,
    rugcheck_score: 1,
    rugcheck_dangers: [],
    quote_at: iso(60_000),
    rugcheck_at: iso(10 * 60_000),
    enriched_at: iso(60_000),
    ...over,
  };
}

const FLAGS: FlagOutput = { flags: ['a'], liquidity: 49063.02, divergence: 0.94, dataConfidence: 'medium' };

describe('rowToMetrics', () => {
  it('maps a full row, converting numeric strings', () => {
    const t = rowToMetrics(row(), NOW);
    assert.ok(t);
    assert.equal(t.mint, MINT);
    assert.equal(t.pairAddress, PAIR);
    assert.equal(t.marketCap, 1_661_000);
    assert.ok(!('liquidityJupUsd' in t), 'Jupiter liquidity is out of the plumbing');
    assert.equal(t.priceJupUsd, 0.001814);
    assert.equal(t.volume1h, 12345);
    assert.equal(t.liquidityGeckoUsd, 95340.4401);
    assert.equal(t.priceGeckoUsd, 0.001652);
    assert.equal(t.roundtripCostPct, 1.7572);
    assert.equal(t.buyImpactPct, 0.6919);
    assert.equal(t.lpLockedPct, 99.99);
    assert.deepEqual(t.rugcheckDangers, []);
    assert.equal(Math.round(t.ageHours ?? 0), 30);
    assert.equal(t.xUrl, 'https://x.com/bawsaq');
  });
  it('rejects rows whose mint or pair is not a Solana address, or without symbol', () => {
    assert.equal(rowToMetrics(row({ mint: 'not-a-mint' }), NOW), null);
    assert.equal(rowToMetrics(row({ pair_address: 42 }), NOW), null);
    assert.equal(rowToMetrics(row({ symbol: '' }), NOW), null);
  });
  it('drops non-https URLs and treats bad numbers as 0 / unknown', () => {
    const t = rowToMetrics(row({ website_url: 'javascript:alert(1)', market_cap: 'abc', volume_1h: 'x' }), NOW);
    assert.ok(t);
    assert.equal(t.websiteUrl, null);
    assert.equal(t.marketCap, 0);
    assert.equal(t.volume1h, undefined);
  });
  it('feeds the flags (round trip, Gecko and RugCheck reach them); liquidity = median DexScreener / GeckoTerminal', () => {
    const fresh = rowToMetrics(row({ roundtrip_cost_pct: 12 }), NOW);
    assert.ok(fresh);
    const r = finalFlags(fresh);
    assert.ok(r.flags.includes("Coût d'aller-retour élevé (> 10 %)"));
    assert.equal(r.liquidity, (94902.17 + 95340.4401) / 2);
  });
  it('ignores the archived zone / score columns of the row', () => {
    const t = rowToMetrics(row({ zone_status: 'broken', zone_source: 'candles' }), NOW);
    assert.ok(t);
    assert.ok(!('zoneStatus' in t) && !('zoneSource' in t));
  });
});

describe('enrichmentFromRow (staleness)', () => {
  it('ignores Gecko values older than the max age (as of enriched_at)', () => {
    const e = enrichmentFromRow(row({ enriched_at: iso(ENRICHMENT_MAX_AGE_MS.gecko + 1) }), NOW);
    assert.equal(e.liquidityGeckoUsd, null);
    assert.equal(e.priceGeckoUsd, null);
  });
  it('ignores a stale or missing round trip', () => {
    assert.equal(enrichmentFromRow(row({ quote_at: iso(ENRICHMENT_MAX_AGE_MS.quote + 1) }), NOW).roundtripCostPct, null);
    assert.equal(enrichmentFromRow(row({ quote_at: null }), NOW).buyImpactPct, null);
  });
  it('ignores a stale RugCheck and timestamps in the future', () => {
    const stale = enrichmentFromRow(row({ rugcheck_at: iso(ENRICHMENT_MAX_AGE_MS.rugcheck + 1), rugcheck_dangers: ['X'] }), NOW);
    assert.equal(stale.lpLockedPct, null);
    assert.deepEqual(stale.rugcheckDangers, []);
    assert.equal(enrichmentFromRow(row({ enriched_at: iso(-3_600_000) }), NOW).liquidityGeckoUsd, null);
  });
  it('re-sanitises persisted danger names and caps them', () => {
    const e = enrichmentFromRow(
      row({ rugcheck_dangers: ['<b>Rug</b>', '\u202Eevil', 'a', 'b', 'c', 'd', 'e', 42] }),
      NOW,
    );
    assert.deepEqual(e.rugcheckDangers, ['bRug/b', 'evil', 'a', 'b', 'c']);
  });
});

describe('select lists', () => {
  it('read every owned column and never the generated one', () => {
    for (const c of ENRICHMENT_OWNED_COLUMNS) {
      assert.ok(ENRICHMENT_SELECT.split(',').includes(c));
      assert.ok(TOKEN_ROW_SELECT.split(',').includes(c));
    }
    assert.ok(TOKEN_ROW_SELECT.split(',').includes('updated_at'), 'needed for the optimistic-concurrency update');
    assert.ok(TOKEN_ROW_SELECT.split(',').includes('volume_1h'), 'enrich-tokens ranks by 1 h volume');
    // Archived columns are not read any more.
    for (const c of ['score', 'zone_status', 'zone_source', 'liquidity_jup_usd', 'liquidity_dex_usd']) {
      assert.ok(!TOKEN_ROW_SELECT.split(',').includes(c), c);
    }
  });
});

describe('buildEnrichmentUpdate', () => {
  const allKeysAllowed = (o: Record<string, unknown>) =>
    Object.keys(o).forEach((k) => assert.ok(ENRICH_UPDATE_COLUMNS.has(k), `unexpected column ${k}`));

  it('contains only owned + flag columns, with everything fetched (no score)', () => {
    const u = buildEnrichmentUpdate(
      {
        gecko: { liquidityUsd: 95340.44, priceUsd: 0.00165 },
        rug: { lpLockedPct: 100, score: 33601, dangers: ['Creator history of rugged tokens'] },
        quote: { roundtripCostPct: 1.7572, roundtripFeePct: 0.0488, buyImpactPct: 0.6919 },
      },
      FLAGS,
      NOW,
    );
    allKeysAllowed(u);
    for (const c of GENERATED_COLUMNS) assert.ok(!(c in u));
    for (const k of ['mint', 'symbol', 'price_usd', 'liquidity_usd', 'updated_at', 'zone_status', 'price_jup_usd']) {
      assert.ok(!(k in u), `must not touch ${k}`);
    }
    assert.equal(u.liquidity_gecko_usd, 95340.44);
    assert.equal(u.rugcheck_score, 33601);
    assert.deepEqual(u.rugcheck_dangers, ['Creator history of rugged tokens']);
    assert.equal(u.roundtrip_cost_pct, 1.7572);
    assert.equal(u.quote_at, new Date(NOW).toISOString());
    assert.equal(u.rugcheck_at, new Date(NOW).toISOString());
    assert.equal(u.enriched_at, new Date(NOW).toISOString());
    assert.ok(!('score' in u));
    assert.deepEqual(u.flags, ['a']);
    assert.equal(u.liquidity_divergence, 0.94);
    assert.equal(u.data_confidence, 'medium');
  });
  it('leaves RugCheck and quote columns untouched when not fetched this run', () => {
    const u = buildEnrichmentUpdate({ gecko: null }, FLAGS, NOW);
    allKeysAllowed(u);
    for (const k of ['lp_locked_pct', 'rugcheck_score', 'rugcheck_dangers', 'rugcheck_at', 'roundtrip_cost_pct', 'quote_at']) {
      assert.ok(!(k in u), `${k} must be absent`);
    }
    assert.equal(u.liquidity_gecko_usd, null);
    assert.equal(u.price_gecko_usd, null);
  });
  it('writes RugCheck insiders / creator history only when known (x3 model)', () => {
    const rug = { lpLockedPct: 100, score: 5, dangers: [] as string[] };
    const known = buildEnrichmentUpdate({ gecko: null, rug: { ...rug, insidersDetected: true, creatorRugHistory: false } }, FLAGS, NOW);
    allKeysAllowed(known);
    assert.equal(known.insiders_detected, true);
    assert.equal(known.creator_rug_history, false);
    const unknown = buildEnrichmentUpdate({ gecko: null, rug: { ...rug, insidersDetected: null } }, FLAGS, NOW);
    assert.ok(!('insiders_detected' in unknown), 'unknown insiders keep the last value');
    assert.ok(!('creator_rug_history' in unknown));
    const none = buildEnrichmentUpdate({ gecko: null }, FLAGS, NOW);
    assert.ok(!('insiders_detected' in none) && !('creator_rug_history' in none));
  });
  it('writes a failed quote as unknown (all null, quote_at null)', () => {
    const u = buildEnrichmentUpdate({ gecko: null, quote: null }, FLAGS, NOW);
    assert.equal(u.roundtrip_cost_pct, null);
    assert.equal(u.roundtrip_fee_pct, null);
    assert.equal(u.buy_impact_pct, null);
    assert.equal(u.quote_at, null);
  });
  it('bounds values to the table CHECKs and sanitises dangers', () => {
    const u = buildEnrichmentUpdate(
      {
        gecko: { liquidityUsd: Number.POSITIVE_INFINITY, priceUsd: -1 },
        rug: { lpLockedPct: 150, score: Number.NaN, dangers: ['<x>', '\u2066a\u2069', 'b', 'c', 'd', 'e', 'f'] },
        quote: { roundtripCostPct: 250, roundtripFeePct: 1, buyImpactPct: 1 },
      },
      { flags: Array.from({ length: 20 }, (_, i) => `f${i}`), liquidity: Number.NaN, divergence: -1, dataConfidence: null },
      NOW,
    );
    assert.equal(u.liquidity_gecko_usd, null);
    assert.equal(u.price_gecko_usd, null);
    assert.equal(u.lp_locked_pct, null);
    assert.equal(u.rugcheck_score, null);
    assert.deepEqual(u.rugcheck_dangers, ['x', 'a', 'b', 'c', 'd']);
    assert.equal(u.roundtrip_cost_pct, null); // out of range → the whole quote is unknown
    assert.equal(u.quote_at, null);
    assert.equal((u.flags as string[]).length, 12);
    assert.equal(u.liquidity_effective_usd, null);
    assert.equal(u.liquidity_divergence, null);
    assert.equal(u.data_confidence, null);
  });
});

describe('toTokenRow (scan-tokens upsert)', () => {
  const t = rowToMetrics(row(), NOW) as TokenMetrics;
  const item: ScanItem = flagItem(t);
  const r = toTokenRow(item, undefined, NOW);

  it('never contains enrich-tokens columns, generated columns nor the archived ones', () => {
    for (const c of ENRICHMENT_OWNED_COLUMNS) assert.ok(!(c in r), `${c} must be left to enrich-tokens`);
    for (const c of GENERATED_COLUMNS) assert.ok(!(c in r));
    for (const c of ['score', 'zone_status', 'zone_source', 'swing_low', 'swing_high', 'zone_low', 'zone_high', 'invalidation', 'tp1', 'tp2', 'liquidity_jup_usd']) {
      assert.ok(!(c in r), `${c} is archived`);
    }
  });
  it('writes the Jupiter price, the 1 h volume and the flag / consensus columns', () => {
    assert.equal(r.price_jup_usd, 0.001814);
    assert.equal(r.liquidity_usd, 94902.17);
    assert.equal(r.volume_1h, 12345);
    assert.deepEqual(r.flags, item.flags);
    assert.equal(r.liquidity_effective_usd, item.liquidity);
    assert.equal(r.liquidity_divergence, item.divergence);
    assert.ok(['high', 'medium', 'low'].includes(String(r.data_confidence)));
    assert.equal(r.updated_at, new Date(NOW).toISOString());
  });
  it('keeps unknown audit fields null', () => {
    assert.equal(r.mint_authority_disabled, null);
    assert.equal(r.top10_pct, null);
  });
});

describe('flagColumns', () => {
  it('rejects invalid confidence values and non-finite numbers', () => {
    const c = flagColumns({ flags: [], liquidity: 1e14, divergence: Number.NaN, dataConfidence: 'bogus' as never });
    assert.ok(!('score' in c));
    assert.equal(c.liquidity_effective_usd, null);
    assert.equal(c.liquidity_divergence, null);
    assert.equal(c.data_confidence, null);
  });
});

describe('integration: scan then enrich re-flag give the same flags (single entry point finalFlags)', () => {
  /** Persisted row after scan-tokens (toTokenRow) + the enrichment columns already in the table. */
  const persisted = (t: TokenMetrics): TokenRow => {
    const scanRow = toTokenRow(flagItem(t), undefined, NOW);
    const enrichCols = Object.fromEntries(Object.entries(row()).filter(([k]) => (ENRICHMENT_OWNED_COLUMNS as readonly string[]).includes(k)));
    return { ...scanRow, ...enrichCols } as TokenRow;
  };
  /** enrich-tokens path: rowToMetrics → finalFlags → buildEnrichmentUpdate. */
  const enrich = (r: TokenRow) => {
    const t = rowToMetrics(r, NOW) as TokenMetrics;
    return buildEnrichmentUpdate({ gecko: { liquidityUsd: t.liquidityGeckoUsd, priceUsd: t.priceGeckoUsd } }, finalFlags(t), NOW);
  };
  it('« Structure cassée » (approximate swing) is written by scan and kept by enrich', () => {
    const healthy = rowToMetrics(row(), NOW) as TokenMetrics;
    const broken = rowToMetrics(row({ change_1h: -50, change_6h: 0, change_24h: 0, change_5m: 0 }), NOW) as TokenMetrics;
    const okRow = persisted(healthy);
    const brokenRow = persisted(broken);
    assert.ok(!(okRow.flags as string[]).includes('Structure cassée'));
    assert.ok((brokenRow.flags as string[]).includes('Structure cassée'));
    const u = enrich(brokenRow);
    assert.deepEqual(u.flags, brokenRow.flags);
    assert.ok(!('score' in u) && !('zone_status' in u));
  });
  it('finalFlags returns exactly the persisted flag columns', () => {
    const t = rowToMetrics(row(), NOW) as TokenMetrics;
    const out = finalFlags(t);
    assert.deepEqual(Object.keys(out).sort(), ['dataConfidence', 'divergence', 'flags', 'liquidity']);
    assert.deepEqual(Object.keys(flagColumns(out)).sort(), ['data_confidence', 'flags', 'liquidity_divergence', 'liquidity_effective_usd']);
  });
});
