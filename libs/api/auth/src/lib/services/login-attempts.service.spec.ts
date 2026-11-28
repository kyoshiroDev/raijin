import { testConfig } from '@raijin/api-core';
import {
  AUTH_EMAIL_MAX_PER_SOURCE,
  AUTH_EMAIL_MAX_PER_WINDOW,
  INCREMENT_WITH_TTL_SCRIPT,
  LoginAttemptsService,
  MemoryAttemptStore,
  RedisAttemptStore,
  type AttemptRedis,
  type AttemptStore,
} from './login-attempts.service';

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

  it('reserve (n3) : tentative comptée d’avance, dernière autorisée signalée, refus au-delà du seuil', async () => {
    const service = new LoginAttemptsService(config, new MemoryAttemptStore());
    await expect(service.reserve('a@b.fr')).resolves.toEqual({ attempt: 1, locked: false, lockedNow: false });
    await service.reserve('a@b.fr');
    await expect(service.reserve('a@b.fr')).resolves.toEqual({ attempt: 3, locked: false, lockedNow: true });
    await expect(service.reserve('a@b.fr')).resolves.toEqual({ attempt: 4, locked: true, lockedNow: false });
    await expect(service.isLocked('a@b.fr')).resolves.toBe(true);
    service.onModuleDestroy();
  });

  it('e-mails d’authentification : une IP n’épuise que sa part, le plafond global par adresse reste borné', async () => {
    const service = new LoginAttemptsService(config, new MemoryAttemptStore());
    const allow = async (email: string, ip: string | null, times: number): Promise<boolean[]> => {
      const results: boolean[] = [];
      for (let i = 0; i < times; i++) results.push(await service.allowAuthEmail(email, ip));
      return results;
    };
    // Un tiers sur une seule IP : bloqué après sa part, même en insistant longuement.
    expect(await allow('v@b.fr', '203.0.113.9', AUTH_EMAIL_MAX_PER_SOURCE)).toEqual(Array(AUTH_EMAIL_MAX_PER_SOURCE).fill(true));
    expect(await allow('v@b.fr', '203.0.113.9', 50)).toEqual(Array(50).fill(false));
    // Les refus de sa paire n'entament pas le plafond global : la victime, depuis son IP, reçoit toujours ses liens.
    expect(await allow('v@b.fr', '198.51.100.7', AUTH_EMAIL_MAX_PER_SOURCE)).toEqual(Array(AUTH_EMAIL_MAX_PER_SOURCE).fill(true));
    // Autre adresse depuis l'IP bloquée : indépendante.
    await expect(service.allowAuthEmail('autre@b.fr', '203.0.113.9')).resolves.toBe(true);
    // Plafond global : IP tournantes, au plus AUTH_EMAIL_MAX_PER_WINDOW envois par adresse et par heure.
    const flood: boolean[] = [];
    for (let i = 0; i < AUTH_EMAIL_MAX_PER_WINDOW + 5; i++) flood.push(await service.allowAuthEmail('w@b.fr', `192.0.2.${i}`));
    expect(flood.filter(Boolean)).toHaveLength(AUTH_EMAIL_MAX_PER_WINDOW);
    // IP inconnue (action admin) : seul le plafond global s'applique, déjà atteint ici.
    await expect(service.allowAuthEmail('w@b.fr', null)).resolves.toBe(false);
    await expect(service.allowAuthEmail('x@b.fr', null)).resolves.toBe(true);
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

  it('RedisAttemptStore : INCR + PEXPIRE atomiques (script Lua), clé jamais en clair', async () => {
    // Faux Redis qui rejoue la sémantique du script (INCR, PEXPIRE si premier échec ou clé sans TTL).
    const counts = new Map<string, { count: number; ttl: number }>();
    const redis = {
      eval: jest.fn(async (script: string, _keys: number, key: string, ttl: string) => {
        expect(script).toBe(INCREMENT_WITH_TTL_SCRIPT);
        const entry = counts.get(key) ?? { count: 0, ttl: -1 };
        entry.count += 1;
        if (entry.count === 1 || entry.ttl < 0) entry.ttl = Number(ttl);
        counts.set(key, entry);
        return entry.count;
      }),
      get: jest.fn().mockResolvedValueOnce('2').mockResolvedValueOnce(null),
      del: jest.fn(),
      disconnect: jest.fn(),
    };
    const store = new RedisAttemptStore(redis as unknown as AttemptRedis);
    const service = new LoginAttemptsService(config, store);
    await service.recordFailure('jean@exemple.fr');
    await service.recordFailure('jean@exemple.fr');
    expect(redis.eval).toHaveBeenCalledTimes(2);
    const [, , key, ttl] = redis.eval.mock.calls[0] ?? [];
    expect(ttl).toBe(String(config.auth.lockoutMs));
    if (!key) throw new Error('clé absente');
    expect(counts.get(key)).toEqual({ count: 2, ttl: config.auth.lockoutMs });
    expect(key).toMatch(/^rj:auth-fail:/);
    expect(key).not.toContain('jean');
    await expect(service.isLocked('jean@exemple.fr')).resolves.toBe(false);
    await expect(store.get('x')).resolves.toBe(0);
    await service.reset('jean@exemple.fr');
    expect(redis.del).toHaveBeenCalledWith(key);
    service.onModuleDestroy();
    expect(redis.disconnect).toHaveBeenCalled();
  });

  it('le script Lua pose toujours une expiration (premier échec ou clé héritée sans TTL)', () => {
    expect(INCREMENT_WITH_TTL_SCRIPT).toContain("redis.call('INCR', KEYS[1])");
    expect(INCREMENT_WITH_TTL_SCRIPT).toMatch(/count == 1 or redis\.call\('PTTL', KEYS\[1\]\) < 0/);
    expect(INCREMENT_WITH_TTL_SCRIPT).toContain("redis.call('PEXPIRE', KEYS[1], ARGV[1])");
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
