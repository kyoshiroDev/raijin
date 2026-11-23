import { DEFAULT_SOLANA_DATA_CONFIG } from '@raijin/api-solana';
import { FakeRedis, jsonResponse } from '../test/fake-redis';
import { createBenchSolana } from './bench-solana';
import { PUBLIC_BACKOFF_BASE_MS, PUBLIC_BACKOFF_MAX_MS, PublicSourceBackoff, withPublicBackoff } from './public-backoff';

const PAIR = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function manualClock(start = Date.parse('2026-11-24T10:00:00Z')) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('PublicSourceBackoff', () => {
  it('recul exponentiel 30 s, 60 s, 120 s… plafonné à 15 min ; remise à zéro sur réponse non-429', () => {
    const clock = manualClock();
    const backoff = new PublicSourceBackoff({ clock });
    expect(backoff.record429('dexscreener', null)).toBe(PUBLIC_BACKOFF_BASE_MS);
    expect(backoff.isPaused('dexscreener')).toBe(true);
    expect(backoff.isPaused('jupiter')).toBe(false);
    expect(backoff.record429('dexscreener', null)).toBe(60_000);
    expect(backoff.record429('dexscreener', null)).toBe(120_000);
    for (let i = 0; i < 40; i += 1) backoff.record429('dexscreener', null);
    expect(backoff.record429('dexscreener', null)).toBe(PUBLIC_BACKOFF_MAX_MS);
    expect(backoff.snapshot()).toEqual([{ source: 'dexscreener', consecutive429: 44, pausedUntil: clock.now() + PUBLIC_BACKOFF_MAX_MS }]);
    clock.advance(PUBLIC_BACKOFF_MAX_MS);
    expect(backoff.isPaused('dexscreener')).toBe(false);
    expect(backoff.snapshot()[0]?.pausedUntil).toBeNull();
    backoff.recordOk('dexscreener');
    expect(backoff.snapshot()).toEqual([]);
    expect(backoff.record429('dexscreener', null)).toBe(PUBLIC_BACKOFF_BASE_MS);
  });

  it('Retry-After plus long respecté (borné au maximum)', () => {
    const backoff = new PublicSourceBackoff({ clock: manualClock() });
    expect(backoff.record429('geckoterminal', 90_000)).toBe(90_000);
    expect(backoff.record429('jupiter', 10 * 3_600_000)).toBe(PUBLIC_BACKOFF_MAX_MS);
    expect(() => new PublicSourceBackoff({ baseMs: 0 })).toThrow(RangeError);
    expect(() => new PublicSourceBackoff({ baseMs: 10, maxMs: 5 })).toThrow(RangeError);
  });
});

describe('withPublicBackoff', () => {
  it('pause sans requête pendant le recul, URL Helius et inconnues non concernées', async () => {
    const clock = manualClock();
    const backoff = new PublicSourceBackoff({ clock });
    const urls: string[] = [];
    const wrapped = withPublicBackoff(
      async (url) => {
        urls.push(url);
        return url.includes('dexscreener') ? jsonResponse({}, 429, { 'retry-after': '45' }) : jsonResponse({}, 429);
      },
      DEFAULT_SOLANA_DATA_CONFIG,
      backoff,
    );
    expect((await wrapped('https://api.dexscreener.com/latest/dex/pairs/solana/x')).status).toBe(429);
    await expect(wrapped('https://api.dexscreener.com/tokens/v1/solana/x')).rejects.toMatchObject({ source: 'dexscreener', kind: 'circuit_open' });
    expect(backoff.snapshot()[0]?.pausedUntil).toBe(clock.now() + 45_000);
    // Helius (clé dans l'URL), autre hôte, URL invalide, chemin hors base : jamais mis en pause.
    await wrapped('https://mainnet.helius-rpc.com/?api-key=x');
    await wrapped('https://mainnet.helius-rpc.com/?api-key=x');
    await wrapped('https://example.org/');
    await wrapped('pas une url');
    await wrapped('https://api.geckoterminal.com/autre');
    await wrapped('https://api.geckoterminal.com/autre');
    expect(urls).toHaveLength(7);
    expect(backoff.snapshot().map((s) => s.source)).toEqual(['dexscreener']);
    // Chemin de base exact, et RPC public (base sans chemin).
    await wrapped('https://api.geckoterminal.com/api/v2');
    await wrapped(DEFAULT_SOLANA_DATA_CONFIG.publicRpcUrl);
    expect(backoff.snapshot().map((s) => s.source).sort()).toEqual(['dexscreener', 'geckoterminal', 'solana_rpc']);
  });

  it('bout en bout : 1er 429 DexScreener → une seule requête, le banc s’arrête puis reprend après le recul', async () => {
    const clock = manualClock();
    let status = 429;
    const urls: string[] = [];
    const bench = createBenchSolana({
      env: {},
      redis: new FakeRedis(),
      clock,
      random: () => 0,
      fetch: async (url) => {
        urls.push(url);
        return status === 429 ? jsonResponse({}, 429) : jsonResponse({ schemaVersion: '1', pairs: null });
      },
    });
    expect(await bench.service.resolveToken(PAIR)).toEqual({ mint: PAIR, resolvedFromPair: false });
    // Rejeu du gate (maxAttempts 2) bloqué par la pause : aucune 2e requête.
    expect(urls).toHaveLength(1);
    clock.advance(10_000);
    await bench.service.resolveToken(PAIR);
    expect(urls).toHaveLength(1);
    expect(bench.service.breakerStates()['dexscreener']).toBe('closed');
    status = 200;
    clock.advance(PUBLIC_BACKOFF_BASE_MS);
    await bench.service.resolveToken(PAIR);
    expect(urls).toHaveLength(2);
    expect(bench.backoff.snapshot()).toEqual([]);
  });
});
