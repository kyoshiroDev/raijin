import { MemoryAnalyticsCache, RedisAnalyticsCache } from './analytics-cache';
import { RedisUsageCounterStore } from './redis-usage-counter-store';

describe('Caches et compteurs Redis', () => {
  it('cache mémoire : expiration et borne', async () => {
    let now = 0;
    const cache = new MemoryAnalyticsCache(() => now);
    await cache.set('a', '1', 10);
    expect(await cache.get('a')).toBe('1');
    now = 11_000;
    expect(await cache.get('a')).toBeNull();
    for (let i = 0; i < 205; i += 1) await cache.set(`k${i}`, 'v', 60);
    expect(await cache.get('k0')).toBeNull();
    expect(await cache.get('k204')).toBe('v');
  });

  it('cache Redis : EX en secondes, panne = null sans exception', async () => {
    const redis = { get: jest.fn(async () => 'x'), set: jest.fn(async () => 'OK'), disconnect: jest.fn() };
    const cache = new RedisAnalyticsCache(redis as never);
    await cache.set('k', 'v', 3600);
    expect(redis.set).toHaveBeenCalledWith('k', 'v', 'EX', 3600);
    redis.get.mockRejectedValueOnce(Object.assign(new Error('redis://secret'), { code: 'ECONNREFUSED' }));
    expect(await cache.get('k')).toBeNull();
    cache.close();
    expect(redis.disconnect).toHaveBeenCalled();
  });

  it('compteurs des sources : HINCRBY + EXPIRE en transaction, HGETALL en pipeline', async () => {
    const tx = { hincrby: jest.fn(), expire: jest.fn(), exec: jest.fn(async () => []) };
    const pipe = { hgetall: jest.fn(), exec: jest.fn(async () => [[null, { success: '3' }], [null, {}]]) };
    const store = new RedisUsageCounterStore({ multi: () => tx, pipeline: () => pipe } as never);
    await store.increment('upstream:calls:jupiter:2026-11-22', { success: 1, latency_ms: 120, zero: 0 }, 691_200);
    expect(tx.hincrby).toHaveBeenCalledTimes(2);
    expect(tx.expire).toHaveBeenCalledWith('upstream:calls:jupiter:2026-11-22', 691_200);
    expect(await store.read(['a', 'b'])).toEqual([{ success: '3' }, null]);
    expect(await store.read([])).toEqual([]);
    pipe.exec.mockResolvedValueOnce([[new Error('down'), null]] as never);
    await expect(store.read(['a'])).rejects.toThrow('down');
  });
});
