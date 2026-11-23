import { Command } from 'ioredis';
import { REDIS_KEY_PREFIX, raijinRedisOptions } from './redis';

describe('options Redis de l’API', () => {
  it('préfixe raijin: (ACL ~raijin:*), distinct de celui du banc, échec rapide', () => {
    expect(REDIS_KEY_PREFIX).toBe('raijin:');
    expect(REDIS_KEY_PREFIX.startsWith('raijin-bench')).toBe(false);
    expect(raijinRedisOptions()).toEqual({ keyPrefix: 'raijin:', maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2_000 });
    expect(raijinRedisOptions()).not.toBe(raijinRedisOptions());
  });
});

describe('keyPrefix appliqué par ioredis', () => {
  // `Command` est le point où ioredis préfixe les clés : couvre GET/SET, MULTI, pipelines et les KEYS[] d'EVAL
  // (y compris `call('eval', …)` du stockage du throttler).
  const prefixed = (name: string, args: Array<string | number>) => new Command(name, args, { keyPrefix: REDIS_KEY_PREFIX }).args;

  it('clés simples et scripts Lua : seules les clés sont préfixées', () => {
    expect(prefixed('get', ['helius:credits:2026-11-24'])).toEqual(['raijin:helius:credits:2026-11-24']);
    expect(prefixed('set', ['lock:trial-tick', 'v', 'PX', '1000', 'NX'])).toEqual(['raijin:lock:trial-tick', 'v', 'PX', '1000', 'NX']);
    expect(prefixed('eval', ['return 1', '2', 'hit', 'block', 'auth', '60'])).toEqual(['return 1', '2', 'raijin:hit', 'raijin:block', 'auth', '60']);
  });
});
