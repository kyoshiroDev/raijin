import { MemoryKeyValueStore, RedisKeyValueStore } from './key-value-store';

function fakeRedis() {
  const data = new Map<string, string>();
  return {
    data,
    get: jest.fn(async (key: string) => data.get(key) ?? null),
    set: jest.fn(async (key: string, value: string, _px: string, _ttl: number, nx?: string) => {
      if (nx === 'NX' && data.has(key)) return null;
      data.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key: string) => Number(data.delete(key))),
    eval: jest.fn(async (_script: string, _n: number, key: string, value: string) => {
      if (data.get(key) === value) return Number(data.delete(key));
      return 0;
    }),
    disconnect: jest.fn(),
  };
}

describe('RedisKeyValueStore', () => {
  it('SET PX, SET NX PX, suppression conditionnelle d’un verrou', async () => {
    const redis = fakeRedis();
    const store = new RedisKeyValueStore(redis as never);
    await expect(store.set('k', 'v', 1500)).resolves.toBe(true);
    expect(redis.set).toHaveBeenCalledWith('k', 'v', 'PX', 1500);
    await expect(store.get('k')).resolves.toBe('v');
    await expect(store.setIfAbsent('lock', 'moi', 15_000)).resolves.toBe(true);
    await expect(store.setIfAbsent('lock', 'autre', 15_000)).resolves.toBe(false);
    await store.deleteIfEquals('lock', 'autre');
    expect(redis.data.get('lock')).toBe('moi');
    await store.deleteIfEquals('lock', 'moi');
    expect(redis.data.has('lock')).toBe(false);
    await store.delete('k');
    await expect(store.get('k')).resolves.toBeNull();
    store.close();
    expect(redis.disconnect).toHaveBeenCalled();
  });

  it('panne Redis : jamais d’exception, valeurs neutres', async () => {
    const failing = {
      get: jest.fn().mockRejectedValue(new Error('ECONNREFUSED redis://secret@host')),
      set: jest.fn().mockRejectedValue(new Error('x')),
      del: jest.fn().mockRejectedValue(new Error('x')),
      eval: jest.fn().mockRejectedValue(new Error('x')),
      disconnect: jest.fn(),
    };
    const store = new RedisKeyValueStore(failing as never);
    await expect(store.get('k')).resolves.toBeNull();
    await expect(store.set('k', 'v', 1)).resolves.toBe(false);
    await expect(store.setIfAbsent('k', 'v', 1)).resolves.toBeNull();
    await expect(store.delete('k')).resolves.toBeUndefined();
    await expect(store.deleteIfEquals('k', 'v')).resolves.toBeUndefined();
  });

  it('connexion réelle injoignable : opérations neutres', async () => {
    const store = RedisKeyValueStore.connect('redis://127.0.0.1:1');
    await expect(store.get('k')).resolves.toBeNull();
    store.close();
  });
});

describe('MemoryKeyValueStore', () => {
  it('expiration, NX et suppression conditionnelle', async () => {
    let now = 0;
    const store = new MemoryKeyValueStore(() => now);
    await store.set('k', 'v', 100);
    await expect(store.setIfAbsent('k', 'w', 100)).resolves.toBe(false);
    now = 100;
    await expect(store.get('k')).resolves.toBeNull();
    await expect(store.setIfAbsent('k', 'w', 100)).resolves.toBe(true);
    await store.deleteIfEquals('k', 'autre');
    await expect(store.get('k')).resolves.toBe('w');
    await store.deleteIfEquals('k', 'w');
    await expect(store.get('k')).resolves.toBeNull();
    await store.set('x', '1', 10);
    await store.delete('x');
    store.close();
    await expect(store.get('x')).resolves.toBeNull();
  });
});
