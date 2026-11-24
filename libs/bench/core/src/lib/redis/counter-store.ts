/** Compteur à expiration (tentatives de connexion). */
export interface CounterStore {
  increment(key: string, ttlMs: number): Promise<number>;
  get(key: string): Promise<number>;
  reset(key: string): Promise<void>;
}

/** Repli en mémoire (dev/test sans Redis, ou Redis indisponible). */
export class MemoryCounterStore implements CounterStore {
  private readonly entries = new Map<string, { count: number; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string): { count: number; expiresAt: number } | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  async increment(key: string, ttlMs: number): Promise<number> {
    const entry = this.live(key) ?? { count: 0, expiresAt: this.now() + ttlMs };
    entry.count += 1;
    this.entries.set(key, entry);
    return entry.count;
  }

  async get(key: string): Promise<number> {
    return this.live(key)?.count ?? 0;
  }

  async reset(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

/** INCR + PEXPIRE atomiques : l'expiration est toujours posée (jamais de verrouillage permanent). */
export const INCREMENT_WITH_TTL_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

export interface CounterRedis {
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
}

/** Compteur Redis (connexion préfixée `raijin-bench:`, le préfixe s'applique aussi aux `KEYS` du script). */
export class RedisCounterStore implements CounterStore {
  constructor(private readonly redis: CounterRedis) {}

  async increment(key: string, ttlMs: number): Promise<number> {
    return Number(await this.redis.eval(INCREMENT_WITH_TTL_SCRIPT, 1, key, String(Math.max(1, Math.round(ttlMs)))));
  }

  async get(key: string): Promise<number> {
    return Number((await this.redis.get(key)) ?? 0);
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

/** Redis en priorité, mémoire si Redis échoue (avertissement limité par l'appelant). */
export class ResilientCounterStore implements CounterStore {
  private readonly memory: MemoryCounterStore;

  constructor(
    private readonly primary: CounterStore | null,
    private readonly onFallback: (error: unknown) => void,
    now: () => number = Date.now,
  ) {
    this.memory = new MemoryCounterStore(now);
  }

  private async run<T>(operation: (store: CounterStore) => Promise<T>): Promise<T> {
    if (this.primary) {
      try {
        return await operation(this.primary);
      } catch (error) {
        this.onFallback(error);
      }
    }
    return operation(this.memory);
  }

  increment(key: string, ttlMs: number): Promise<number> {
    return this.run((store) => store.increment(key, ttlMs));
  }

  get(key: string): Promise<number> {
    return this.run((store) => store.get(key));
  }

  reset(key: string): Promise<void> {
    return this.run((store) => store.reset(key));
  }
}
