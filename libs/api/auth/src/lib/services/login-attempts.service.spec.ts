import { testConfig } from '@raijin/api-core';
import type Redis from 'ioredis';
import { LoginAttemptsService, MemoryAttemptStore, RedisAttemptStore, type AttemptStore } from './login-attempts.service';

describe('LoginAttemptsService', () => {
  const config = testConfig({ AUTH_LOCKOUT_THRESHOLD: '3' });

  it('verrouille au seuil puis se réinitialise', async () => {
    const service = new LoginAttemptsService(config, new MemoryAttemptStore());
    expect(await service.recordFailure('a@b.fr')).toBe(false);
    expect(await service.recordFailure('a@b.fr')).toBe(false);
    await expect(service.isLocked('a@b.fr')).resolves.toBe(false);
    expect(await service.recordFailure('a@b.fr')).toBe(true);
    await expect(service.isLocked('a@b.fr')).resolves.toBe(true);
    await expect(service.isLocked('autre@b.fr')).resolves.toBe(false);
    await service.reset('a@b.fr');
    await expect(service.isLocked('a@b.fr')).resolves.toBe(false);
    service.onModuleDestroy();
  });

  it('le compteur expire', async () => {
    const store = new MemoryAttemptStore();
    await store.increment('k', 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(store.get('k')).resolves.toBe(0);
  });

  it('se replie en mémoire si le stockage principal échoue', async () => {
    const failing: AttemptStore = {
      increment: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      get: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      reset: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      close: jest.fn(),
    };
    const service = new LoginAttemptsService(config, failing);
    await service.recordFailure('a@b.fr');
    await service.recordFailure('a@b.fr');
    await service.recordFailure('a@b.fr');
    await expect(service.isLocked('a@b.fr')).resolves.toBe(true);
    await service.reset('a@b.fr');
    service.onModuleDestroy();
    expect(failing.close).toHaveBeenCalled();
  });

  it('RedisAttemptStore : INCR, PEXPIRE au premier échec, clé jamais en clair', async () => {
    const redis = {
      incr: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2),
      pexpire: jest.fn(),
      get: jest.fn().mockResolvedValueOnce('2').mockResolvedValueOnce(null),
      del: jest.fn(),
      disconnect: jest.fn(),
    };
    const store = new RedisAttemptStore(redis as unknown as Redis);
    const service = new LoginAttemptsService(config, store);
    await service.recordFailure('jean@exemple.fr');
    await service.recordFailure('jean@exemple.fr');
    expect(redis.pexpire).toHaveBeenCalledTimes(1);
    const key = redis.incr.mock.calls[0][0] as string;
    expect(key).toMatch(/^rj:auth-fail:/);
    expect(key).not.toContain('jean');
    await expect(service.isLocked('jean@exemple.fr')).resolves.toBe(false);
    await expect(store.get('x')).resolves.toBe(0);
    await service.reset('jean@exemple.fr');
    expect(redis.del).toHaveBeenCalledWith(key);
    service.onModuleDestroy();
    expect(redis.disconnect).toHaveBeenCalled();
  });

  it('sans Redis configuré : mémoire seule ; avec Redis injoignable : repli', async () => {
    const memoryOnly = new LoginAttemptsService(config);
    await memoryOnly.recordFailure('a@b.fr');
    memoryOnly.onModuleDestroy();
    const unreachable = new LoginAttemptsService(testConfig({ REDIS_URL: 'redis://127.0.0.1:1' }));
    await unreachable.recordFailure('a@b.fr');
    await expect(unreachable.isLocked('a@b.fr')).resolves.toBe(false);
    unreachable.onModuleDestroy();
  });
});
