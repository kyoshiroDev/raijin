import type { ThrottlerStorage } from '@nestjs/throttler';
import { createThrottlerStorage, ResilientThrottlerStorage } from './throttler';

describe('ResilientThrottlerStorage', () => {
  it('utilise le stockage principal quand il répond', async () => {
    const record = { totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 };
    const primary = { increment: jest.fn().mockResolvedValue(record) } as unknown as ThrottlerStorage;
    const storage = new ResilientThrottlerStorage(primary);
    await expect(storage.increment('k', 60_000, 10, 0, 'default')).resolves.toBe(record);
    storage.onApplicationShutdown();
  });

  it('se replie en mémoire si Redis échoue (API disponible, incident journalisé une fois)', async () => {
    const primary = { increment: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) } as unknown as ThrottlerStorage;
    const storage = new ResilientThrottlerStorage(primary);
    const first = await storage.increment('k', 60_000, 10, 0, 'default');
    const second = await storage.increment('k', 60_000, 10, 0, 'default');
    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
    storage.onApplicationShutdown();
  });

  it('sans Redis : stockage mémoire seul', async () => {
    const storage = createThrottlerStorage(null);
    const record = await storage.increment('x', 60_000, 1, 0, 'auth');
    expect(record.totalHits).toBe(1);
    storage.onApplicationShutdown();
  });
});

describe('createThrottlerStorage avec Redis injoignable', () => {
  it('répond depuis la mémoire puis se ferme proprement', async () => {
    const storage = createThrottlerStorage('redis://127.0.0.1:1');
    const record = await storage.increment('k', 60_000, 5, 0, 'default');
    expect(record.totalHits).toBe(1);
    storage.onApplicationShutdown();
  });
});
