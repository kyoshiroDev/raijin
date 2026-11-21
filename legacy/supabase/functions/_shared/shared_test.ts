// Runs with `deno test supabase/functions` (node:test is supported by Deno)
// and with `node --experimental-strip-types --test` for quick local checks.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { base58Decode, isSolanaAddress } from './solana.ts';
import { constantTimeEqual, safeHttpsUrl, sanitizeText, TELEGRAM_HOSTS, X_HOSTS } from './sanitize.ts';
import {
  FLAG_INCOHERENT_DATA, FLAG_LP_UNLOCKED, FLAG_PRICE_DIVERGENT, FLAG_ZONE_BROKEN, isBondingCurve, MAX_FLAGS, SIZE_FLAGS,
  tokenFlags, YOUNG_FRENZY_1H_PCT,
} from './flags.ts';
import { compareActivity, finalFlags, flagItem, rankByActivity, rankYoungFirst } from './final-score.ts';
import { ROUNDTRIP_FLAGS } from './consensus.ts';
import type { TokenMetrics } from './types.ts';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

describe('isSolanaAddress', () => {
  it('accepts a real mint', () => assert.equal(isSolanaAddress(SOL_MINT), true));
  it('accepts the USDC mint and decodes it to 32 bytes', () => {
    const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    assert.equal(isSolanaAddress(usdc), true);
    assert.equal(base58Decode(usdc)?.length, 32);
  });
  it('rejects a look-alike with one character changed to an invalid one', () => {
    assert.equal(isSolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDtlv'), false);
  });
  it('rejects invalid base58 characters (0, O, I, l)', () => {
    assert.equal(isSolanaAddress('So1111111111111111111111111111111111111111O'), false);
    assert.equal(isSolanaAddress('0o11111111111111111111111111111111111111112'), false);
  });
  it('rejects wrong lengths and non-strings', () => {
    assert.equal(isSolanaAddress('So111'), false);
    assert.equal(isSolanaAddress(SOL_MINT + '1111'), false);
    assert.equal(isSolanaAddress(42), false);
    assert.equal(isSolanaAddress(null), false);
  });
});

describe('sanitizeText', () => {
  it('strips bidi overrides and zero-width chars', () => {
    assert.equal(sanitizeText('GTA\u202E6\u200B', 32), 'GTA6');
  });
  it('removes angle brackets (defense in depth)', () => {
    assert.equal(sanitizeText('<img src=x onerror=alert(1)>', 64), 'img src=x onerror=alert(1)');
  });
  it('strips the Arabic letter mark (U+061C) and interlinear annotation controls (U+FFF9–U+FFFB)', () => {
    assert.equal(sanitizeText('GT\u061CA6', 32), 'GTA6');
    assert.equal(sanitizeText('\uFFF9GTA\uFFFA6\uFFFB', 32), 'GTA6');
    // Previously covered ranges still stripped (U+200E LRM, U+2066 LRI, U+2069 PDI, U+FEFF BOM).
    assert.equal(sanitizeText('\u200EG\u2066T\u2069A\uFEFF6', 32), 'GTA6');
    // Neighbours are kept: U+061B (Arabic semicolon), U+FFFC (object replacement) are visible characters.
    assert.equal(sanitizeText('a\u061Bb', 32), 'a\u061Bb');
  });
  it('caps length and handles non-strings', () => {
    assert.equal(sanitizeText('A'.repeat(100), 32).length, 32);
    assert.equal(sanitizeText(undefined, 32), '');
  });
});

describe('safeHttpsUrl', () => {
  it('accepts https', () => assert.equal(safeHttpsUrl('https://example.com/a'), 'https://example.com/a'));
  it('rejects javascript:, data:, http:', () => {
    assert.equal(safeHttpsUrl('javascript:alert(1)'), null);
    assert.equal(safeHttpsUrl('data:text/html,<script>'), null);
    assert.equal(safeHttpsUrl('http://example.com'), null);
  });
  it('rejects credentials, IPs and localhost', () => {
    assert.equal(safeHttpsUrl('https://user:pw@example.com'), null);
    assert.equal(safeHttpsUrl('https://127.0.0.1/x'), null);
    assert.equal(safeHttpsUrl('https://localhost/x'), null);
  });
  it('enforces host allowlists', () => {
    assert.equal(safeHttpsUrl('https://x.com/token', X_HOSTS), 'https://x.com/token');
    assert.equal(safeHttpsUrl('https://x.com.evil.io/token', X_HOSTS), null);
    assert.equal(safeHttpsUrl('https://t.me/group', TELEGRAM_HOSTS), 'https://t.me/group');
  });
});

describe('constantTimeEqual', () => {
  it('compares correctly', () => {
    assert.equal(constantTimeEqual('abc', 'abc'), true);
    assert.equal(constantTimeEqual('abc', 'abd'), false);
    assert.equal(constantTimeEqual('abc', 'abcd'), false);
  });
});

const base: TokenMetrics = {
  mint: SOL_MINT, symbol: 'GTA6', name: 'GTA VI', pairAddress: SOL_MINT, dexId: 'raydium',
  imageUrl: null, websiteUrl: 'https://gta6.example', xUrl: 'https://x.com/gta6', telegramUrl: null,
  priceUsd: 0.01217, marketCap: 12_000_000, liquidityUsd: 385_000, volume24h: 3_450_000,
  change5m: 1.2, change1h: 5, change6h: 20, change24h: 77.95,
  buys1h: 420, sells1h: 300, buys24h: 9000, sells24h: 7000,
  pairCreatedAt: null, ageHours: 24 * 90,
  liquidityGeckoUsd: null, priceJupUsd: null, priceGeckoUsd: null, roundtripCostPct: null, roundtripFeePct: null, buyImpactPct: null, lpLockedPct: null, rugcheckScore: null, rugcheckDangers: [],
};
const f = (over: Partial<TokenMetrics> = {}) => tokenFlags({ ...base, ...over });

describe('tokenFlags (chore/slim-down: flags + consensus, no score)', () => {
  it('returns flags, effective liquidity, divergence, price divergence and confidence — no score / cap', () => {
    const r = f();
    assert.deepEqual(Object.keys(r).sort(), ['dataConfidence', 'divergence', 'flags', 'liquidity', 'priceDivergent']);
    assert.ok(r.flags.includes('Liquidité faible vs MC'));
    assert.equal(r.liquidity, 385_000);
    assert.ok(Number.isFinite(f({ marketCap: 0 }).liquidity));
  });
  it('no flag mentions a score any more', () => {
    const r = f({ liquidityUsd: 5_000, marketCap: 60_000, roundtripCostPct: 12, dexId: 'pumpfun', change1h: -40, change24h: -60 });
    for (const flag of r.flags) assert.ok(!/score/i.test(flag), flag);
  });
  it('liquidity: median of DexScreener and GeckoTerminal (Jupiter is not a liquidity source)', () => {
    const r = f({ liquidityUsd: 400_000, liquidityGeckoUsd: 300_000 });
    assert.equal(r.liquidity, 350_000);
    assert.ok(Math.abs((r.divergence ?? 0) - 1 / 3) < 1e-9);
  });
  it('divergence exactly 0.5 → no flag; above → « Données incohérentes » first, confidence low', () => {
    assert.ok(!f({ liquidityUsd: 300_000, liquidityGeckoUsd: 200_000 }).flags.includes(FLAG_INCOHERENT_DATA));
    const over = f({ liquidityUsd: 300_010, liquidityGeckoUsd: 200_000 });
    assert.equal(over.flags[0], FLAG_INCOHERENT_DATA);
    assert.equal(over.dataConfidence, 'low');
  });
  it('price deviation above 5 % → « Prix divergent entre sources » (Jupiter price still counts)', () => {
    assert.ok(!f({ priceUsd: 100, priceJupUsd: 100, priceGeckoUsd: 105 }).flags.includes(FLAG_PRICE_DIVERGENT));
    const over = f({ priceUsd: 100, priceJupUsd: 100, priceGeckoUsd: 105.01 });
    assert.equal(over.priceDivergent, true);
    assert.ok(over.flags.includes(FLAG_PRICE_DIVERGENT));
  });
  it('confidence high with 2 agreeing liquidity sources, aligned prices and a known round trip', () => {
    assert.equal(f({ liquidityUsd: 400_000, liquidityGeckoUsd: 380_000, roundtripCostPct: 2 }).dataConfidence, 'high');
    assert.equal(f({}).dataConfidence, 'low');
  });
  it('size flags (former caps) without any cap: liquidity buckets are exclusive, small MC flagged', () => {
    assert.ok(f({ liquidityUsd: 9_999 }).flags.includes(SIZE_FLAGS.liqUnder10k.flag));
    const r = f({ liquidityUsd: 15_000 });
    assert.ok(r.flags.includes(SIZE_FLAGS.liqUnder20k.flag));
    assert.ok(!r.flags.includes(SIZE_FLAGS.liqUnder10k.flag));
    assert.ok(f({ liquidityUsd: 49_999 }).flags.includes(SIZE_FLAGS.liqUnder50k.flag));
    assert.ok(!f({ liquidityUsd: 50_000 }).flags.some((x) => x.startsWith('Liquidité') && x.includes('k$)')));
    assert.ok(f({ marketCap: 99_999 }).flags.includes(SIZE_FLAGS.mcUnder100k.flag));
  });
  it('round trip > 5 % / > 10 % flagged (one of them)', () => {
    assert.ok(f({ roundtripCostPct: 6 }).flags.includes(ROUNDTRIP_FLAGS.high.flag));
    const x = f({ roundtripCostPct: 11 }).flags;
    assert.ok(x.includes(ROUNDTRIP_FLAGS.extreme.flag) && !x.includes(ROUNDTRIP_FLAGS.high.flag));
    assert.ok(!f({ roundtripCostPct: 5 }).flags.some((x) => x.startsWith("Coût d'aller-retour")));
  });
  it('« Structure cassée » from the approximate swing (no candles), right after the incoherent-data flag', () => {
    // Came from +100 % 1 h ago (price halved): under the 0.786 retracement.
    const broken = f({ change5m: 0, change1h: -50, change6h: 0, change24h: 0 });
    assert.ok(broken.flags.includes(FLAG_ZONE_BROKEN));
    assert.equal(broken.flags[0], FLAG_ZONE_BROKEN);
    assert.ok(!f().flags.includes(FLAG_ZONE_BROKEN));
  });
  it('bonding curve (pumpfun only, never pumpswap), crashes, sells > buys, over-extension, < 1 h, no socials', () => {
    assert.ok(f({ dexId: 'pumpfun' }).flags.includes('Bonding curve'));
    assert.ok(!f({ dexId: 'pumpswap' }).flags.includes('Bonding curve'));
    assert.equal(isBondingCurve('pumpfun'), true);
    assert.ok(f({ change1h: -26 }).flags.includes('Chute -26 % en 1 h'));
    assert.ok(!f({ change1h: -25 }).flags.some((x) => x.includes('en 1 h') && x.startsWith('Chute')));
    assert.ok(f({ change24h: -51, change1h: 0, change6h: 0, change5m: 0 }).flags.includes('Chute -51 % en 24 h'));
    assert.ok(f({ buys1h: 100, sells1h: 131 }).flags.includes('Ventes > achats (1 h)'));
    assert.ok(f({ change24h: 301 }).flags.some((x) => x.includes('sur-extension')));
    assert.ok(f({ ageHours: 0.5 }).flags.includes("Moins d'1 h"));
    assert.ok(f({ websiteUrl: null, xUrl: null }).flags.includes('Aucun réseau social'));
  });
  it('« Frénésie » flag for a young token (< 24 h) above +150 % in 1 h only', () => {
    assert.ok(f({ ageHours: 5, change1h: YOUNG_FRENZY_1H_PCT + 1 }).flags.some((x) => x.startsWith('Frénésie')));
    assert.ok(!f({ ageHours: 5, change1h: YOUNG_FRENZY_1H_PCT }).flags.some((x) => x.startsWith('Frénésie')));
    assert.ok(!f({ ageHours: 30, change1h: 400 }).flags.some((x) => x.startsWith('Frénésie')));
  });
  it('LP < 50 % flagged; RugCheck dangers re-sanitised, at most 2', () => {
    assert.ok(f({ lpLockedPct: 49 }).flags.includes(FLAG_LP_UNLOCKED));
    assert.ok(!f({ lpLockedPct: 50 }).flags.includes(FLAG_LP_UNLOCKED));
    const r = f({ rugcheckDangers: ['\u202EMint <b>authority</b>', 'Freeze', 'Third'] });
    const rc = r.flags.filter((x) => x.startsWith('RugCheck'));
    assert.equal(rc.length, 2);
    for (const x of rc) assert.doesNotMatch(x, /[<>\u202E]/);
  });
  it('at most MAX_FLAGS flags, most important first', () => {
    const r = f({
      liquidityUsd: 300_010, liquidityGeckoUsd: 200_000, change1h: -50, change24h: -60, lpLockedPct: 10, roundtripCostPct: 20,
      dexId: 'pumpfun', marketCap: 50_000, buys1h: 1, sells1h: 100, ageHours: 0.2, websiteUrl: null, xUrl: null,
      rugcheckDangers: ['A', 'B'], priceUsd: 1, priceGeckoUsd: 2,
    });
    assert.equal(r.flags.length, MAX_FLAGS);
    assert.equal(r.flags[0], FLAG_INCOHERENT_DATA);
  });
});

describe('final-score.ts: finalFlags / ranking by activity', () => {
  it('finalFlags = tokenFlags without priceDivergent; flagItem wraps the metrics', () => {
    const t = { ...base };
    const { flags, liquidity, divergence, dataConfidence } = tokenFlags(t);
    assert.deepEqual(finalFlags(t), { flags, liquidity, divergence, dataConfidence });
    assert.deepEqual(flagItem(t), { t, flags, liquidity, divergence, dataConfidence });
  });
  it('rankByActivity: 1 h volume desc (unknown = 0), then liquidity desc, then mint; input untouched', () => {
    const a = { mint: 'A', volume1h: 10, liquidityUsd: 5 };
    const b = { mint: 'B', volume1h: 50, liquidityUsd: 1 };
    const c = { mint: 'C', volume1h: 10, liquidityUsd: 9 };
    const d = { mint: 'D', liquidityUsd: 100 };
    const input = [a, b, c, d];
    assert.deepEqual(rankByActivity(input).map((x) => x.mint), ['B', 'C', 'A', 'D']);
    assert.deepEqual(input.map((x) => x.mint), ['A', 'B', 'C', 'D']);
    assert.equal(compareActivity(a, { ...a }), 0);
  });
  it('rankYoungFirst: tokens < 24 h first, then the activity order', () => {
    const old = { mint: 'O', volume1h: 1e9, liquidityUsd: 1e9, ageHours: 100 };
    const y1 = { mint: 'Y1', volume1h: 1, liquidityUsd: 1, ageHours: 2 };
    const y2 = { mint: 'Y2', volume1h: 5, liquidityUsd: 1, ageHours: 23 };
    const unknown = { mint: 'U', volume1h: 2e9, liquidityUsd: 1, ageHours: null };
    assert.deepEqual(rankYoungFirst([old, y1, unknown, y2]).map((x) => x.mint), ['Y2', 'Y1', 'U', 'O']);
  });
});

import { bestPairPerToken, toMetrics } from './normalize.ts';
import type { DexPair } from './schemas.ts';

describe('toMetrics (hostile payload)', () => {
  const hostile = {
    chainId: 'solana', dexId: 'raydium', pairAddress: SOL_MINT,
    baseToken: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', name: '<script>x</script>\u202Eevil', symbol: 'GTA\u200B6' },
    priceUsd: 0.01,
    marketCap: 1_000_000,
    info: {
      imageUrl: 'https://evil.example/pixel.png',
      websites: [{ url: 'javascript:alert(1)' }, { url: 'https://site.example' }],
      socials: [{ type: 'twitter', url: 'https://x.com.evil.io/a' }, { type: 'telegram', url: 'https://t.me/real' }],
    },
  } as unknown as DexPair;

  it('sanitises names and rejects unsafe URLs', () => {
    const m = toMetrics(hostile, Date.now());
    assert.ok(m);
    assert.equal(m.symbol, 'GTA6');
    assert.ok(!m.name.includes('<') && !m.name.includes('\u202E'));
    assert.equal(m.imageUrl, null);
    assert.equal(m.websiteUrl, 'https://site.example/');
    assert.equal(m.xUrl, null);
    assert.equal(m.telegramUrl, 'https://t.me/real');
  });
  it('no zone, no Jupiter liquidity field any more; 1 h volume kept', () => {
    const m = toMetrics({ ...hostile, volume: { h1: 1234 } } as DexPair, Date.now());
    assert.ok(m);
    assert.ok(!('zoneStatus' in m) && !('liquidityJupUsd' in m));
    assert.equal(m.volume1h, 1234);
  });
  it('drops non-Solana chains and invalid addresses', () => {
    assert.equal(toMetrics({ ...hostile, chainId: 'ethereum' } as DexPair, Date.now()), null);
    assert.equal(toMetrics({ ...hostile, pairAddress: 'not-an-address' } as DexPair, Date.now()), null);
  });
  it('keeps the most liquid pair per token', () => {
    const a = { ...hostile, liquidity: { usd: 10 } } as DexPair;
    const b = { ...hostile, liquidity: { usd: 99 } } as DexPair;
    assert.equal(bestPairPerToken([a, b])[0].liquidity?.usd, 99);
  });
});

describe('sanitizeText length cap (code points)', () => {
  it('never leaves half of a surrogate pair at the cut', () => {
    const out = sanitizeText('a'.repeat(31) + '\u{1F680}' + 'zz', 32);
    assert.equal(out, 'a'.repeat(31) + '\u{1F680}');
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), 'no lone high surrogate');
    assert.equal(sanitizeText('\u{1F680}\u{1F680}', 1), '\u{1F680}');
  });
});
