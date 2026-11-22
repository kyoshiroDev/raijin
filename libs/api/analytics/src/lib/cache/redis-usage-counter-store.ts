import type Redis from 'ioredis';

/**
 * Stockage Redis des compteurs d'appels des sources Solana (port `UsageCounterStore` de `@raijin/api-solana`,
 * docs/ARCHITECTURE.md §14.1) : hashes `upstream:calls:<source>:<jour>` et `upstream:credits:<jour>`, `HINCRBY` puis
 * `EXPIRE` dans une même transaction, lecture `HGETALL` en pipeline. Les clés sont construites par `api-solana`
 * (jour validé, source fermée) ; aucune donnée sensible n'y est écrite. Les erreurs remontent à l'enregistreur, qui
 * les ignore (journal limité) : un comptage perdu ne fait jamais échouer un appel.
 */
export class RedisUsageCounterStore {
  constructor(private readonly redis: Pick<Redis, 'multi' | 'pipeline'>) {}

  async increment(key: string, fields: Readonly<Record<string, number>>, ttlSeconds: number): Promise<void> {
    const tx = this.redis.multi();
    for (const [field, value] of Object.entries(fields)) {
      if (Number.isSafeInteger(value) && value !== 0) tx.hincrby(key, field, value);
    }
    tx.expire(key, Math.max(1, Math.round(ttlSeconds)));
    await tx.exec();
  }

  async read(keys: readonly string[]): Promise<Array<Record<string, string> | null>> {
    if (keys.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const key of keys) pipeline.hgetall(key);
    const results = (await pipeline.exec()) ?? [];
    return keys.map((_, index) => {
      const [error, value] = results[index] ?? [null, null];
      if (error) throw error;
      const hash = value as Record<string, string> | null;
      return hash && Object.keys(hash).length > 0 ? hash : null;
    });
  }
}
