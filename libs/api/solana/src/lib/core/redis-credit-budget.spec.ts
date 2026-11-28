import { PREFIXED_CONSUME_CREDITS_SCRIPT, PrefixedRedisCreditBudget, type RedisScriptClient } from './redis-credit-budget';
import type { LogFields } from './ports';

/** Redis simulé : exécute la sémantique du script Lua (INCRBY + plafonds + annulation) en mémoire. */
class FakeRedis implements RedisScriptClient {
  readonly values = new Map<string, number>();
  readonly ttls = new Map<string, number>();
  failing = false;

  async eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown> {
    if (this.failing) throw new Error('ECONNREFUSED redis://secret@host');
    expect(script).toBe(PREFIXED_CONSUME_CREDITS_SCRIPT);
    const keys = args.slice(0, numKeys).map(String);
    const credits = Number(args[numKeys]);
    const limits = args.slice(numKeys + 1, numKeys + 1 + numKeys).map(Number);
    const ttl = Number(args[numKeys + 1 + numKeys]);
    let over = false;
    keys.forEach((key, i) => {
      const used = (this.values.get(key) ?? 0) + credits;
      this.values.set(key, used);
      if (!this.ttls.has(key)) this.ttls.set(key, ttl);
      if (used > (limits[i] as number)) over = true;
    });
    if (over) {
      for (const key of keys) this.values.set(key, (this.values.get(key) as number) - credits);
      return 0;
    }
    return 1;
  }

  async get(key: string): Promise<string | null> {
    if (this.failing) throw new Error('down');
    const value = this.values.get(key);
    return value === undefined ? null : String(value);
  }
}

const DAY_MS = Date.parse('2026-11-24T10:00:00Z');

describe('PrefixedRedisCreditBudget', () => {
  it('compte sous le préfixe, plafonne le global puis refuse (repli : contrôle « indisponible »)', async () => {
    const redis = new FakeRedis();
    const budget = new PrefixedRedisCreditBudget(redis, { prefix: 'raijin-bench:', dailyLimit: 30, clock: { now: () => DAY_MS } });
    expect(await budget.tryConsume(10)).toBe(true);
    expect(await budget.tryConsume(20, 'watch')).toBe(true);
    expect(await budget.tryConsume(1)).toBe(false);
    expect(redis.values.get('raijin-bench:helius:credits:2026-11-24')).toBe(30);
    expect(redis.ttls.get('raijin-bench:helius:credits:2026-11-24')).toBe(172_800);
    expect(await budget.used()).toBe(30);
    // Voie non plafonnée : compteur global.
    expect(await budget.used('watch')).toBe(30);
    expect(budget.limit('watch')).toBe(30);
  });

  it('voie plafonnée : comptée dans le global et dans son propre compteur', async () => {
    const redis = new FakeRedis();
    const budget = new PrefixedRedisCreditBudget(redis, {
      prefix: 'raijin-bench:',
      dailyLimit: 100,
      laneLimits: { wallet: 20, watch: 500 },
      clock: { now: () => DAY_MS },
    });
    expect(budget.limit('watch')).toBe(100);
    expect(await budget.tryConsume(10, 'wallet')).toBe(true);
    expect(await budget.tryConsume(10, 'wallet')).toBe(true);
    expect(await budget.tryConsume(10, 'wallet')).toBe(false);
    expect(await budget.tryConsume(50)).toBe(true);
    expect(await budget.used('wallet')).toBe(20);
    expect(await budget.used()).toBe(70);
    expect(budget.key('wallet', '2026-11-24')).toBe('raijin-bench:helius:credits:wallet:2026-11-24');
  });

  it('compteurs isolés par préfixe sur le même Redis', async () => {
    const redis = new FakeRedis();
    const clock = { now: () => DAY_MS };
    const raijin = new PrefixedRedisCreditBudget(redis, { prefix: 'raijin:', dailyLimit: 22_000, clock });
    const bench = new PrefixedRedisCreditBudget(redis, { prefix: 'raijin-bench:', dailyLimit: 10, clock });
    expect(await bench.tryConsume(10)).toBe(true);
    expect(await bench.tryConsume(10)).toBe(false);
    expect(await raijin.tryConsume(10)).toBe(true);
    expect(await raijin.used()).toBe(10);
    expect(await bench.used()).toBe(10);
    expect([...redis.values.keys()].sort()).toEqual(['raijin-bench:helius:credits:2026-11-24', 'raijin:helius:credits:2026-11-24']);
  });

  it('Redis en panne : repli mémoire, avertissement sans détail, au plus une fois par minute', async () => {
    const redis = new FakeRedis();
    redis.failing = true;
    const warnings: Array<[string, LogFields]> = [];
    const budget = new PrefixedRedisCreditBudget(redis, {
      prefix: 'raijin-bench:',
      dailyLimit: 15,
      laneLimits: { wallet: 10 },
      clock: { now: () => DAY_MS },
      logger: { debug: () => undefined, warn: (event, fields) => warnings.push([event, fields]) },
    });
    expect(await budget.tryConsume(10, 'wallet')).toBe(true);
    expect(await budget.tryConsume(10, 'wallet')).toBe(false);
    expect(await budget.tryConsume(5)).toBe(true);
    expect(await budget.tryConsume(1)).toBe(false);
    expect(await budget.used()).toBe(0);
    expect(warnings).toEqual([['helius_budget_redis_unavailable', { prefix: 'raijin-bench:' }]]);
    expect(JSON.stringify(warnings)).not.toContain('secret');
  });

  it('sans Redis : budget en mémoire ; entrées invalides refusées', async () => {
    const budget = new PrefixedRedisCreditBudget(null, { prefix: 'raijin-bench:', dailyLimit: 10 });
    expect(await budget.tryConsume(0)).toBe(true);
    expect(await budget.tryConsume(-1)).toBe(false);
    expect(await budget.tryConsume(Number.NaN)).toBe(false);
    expect(await budget.tryConsume(10)).toBe(true);
    expect(await budget.tryConsume(1)).toBe(false);
    expect(await budget.used()).toBe(0);
    expect(() => new PrefixedRedisCreditBudget(null, { prefix: 'raijin-bench', dailyLimit: 10 })).toThrow(RangeError);
    expect(() => new PrefixedRedisCreditBudget(null, { prefix: 'Raijin:*', dailyLimit: 10 })).toThrow(RangeError);
    expect(() => new PrefixedRedisCreditBudget(null, { prefix: 'raijin:', dailyLimit: -1 })).toThrow(RangeError);
    expect(() => new PrefixedRedisCreditBudget(null, { prefix: 'raijin:', dailyLimit: 10, laneLimits: { wallet: 1.5 } })).toThrow(RangeError);
  });

  it('valeur illisible dans Redis : 0', async () => {
    const redis = new FakeRedis();
    const budget = new PrefixedRedisCreditBudget(redis, { prefix: 'raijin-bench:', dailyLimit: 10, clock: { now: () => DAY_MS } });
    redis.get = async () => 'abc';
    expect(await budget.used()).toBe(0);
  });
});
