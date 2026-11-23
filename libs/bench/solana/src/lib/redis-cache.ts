import type { CacheStore, RedisScriptClient } from '@raijin/api-solana';

/** Client Redis du banc (structurel : `ioredis` convient) : script de budget, lecture, écriture avec TTL. */
export interface BenchRedisClient extends RedisScriptClient {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

/**
 * Cache des intégrations Solana sur Redis, clés préfixées (`raijin-bench:solana:…`, ACL Redis du banc).
 * Une panne Redis vaut un défaut de cache (lecture `null`, écriture ignorée) : jamais d'exception.
 */
export class PrefixedRedisCacheStore implements CacheStore {
  constructor(
    private readonly redis: BenchRedisClient,
    readonly prefix: string,
  ) {
    if (!/^[a-z0-9][a-z0-9:-]{0,60}:$/.test(prefix)) throw new RangeError('Préfixe Redis invalide.');
  }

  async get(key: string): Promise<string | null> {
    try {
      const value = await this.redis.get(this.prefix + key);
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    const seconds = Math.max(1, Math.ceil(ttlSeconds));
    try {
      await this.redis.set(this.prefix + key, value, 'EX', seconds);
    } catch {
      // Défaut de cache : sans effet sur la collecte.
    }
  }
}
