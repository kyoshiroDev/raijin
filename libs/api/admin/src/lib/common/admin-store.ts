import { Logger } from '@nestjs/common';
import { errorCode, raijinRedisOptions, type AppConfig } from '@raijin/api-core';
import Redis from 'ioredis';

/**
 * Stockage Redis de l'espace admin : compteurs journaliers (hash `HINCRBY` + `EXPIRE`), petits caches JSON et verrous.
 * Les opérations ne lèvent jamais : une panne renvoie `null` / `{}` et l'appelant se replie (calcul sans cache,
 * compteurs perdus pour la durée de la panne, journalisé au plus une fois par minute).
 */
export abstract class AdminStore {
  abstract increment(key: string, fields: Readonly<Record<string, number>>, ttlSeconds: number): Promise<void>;
  /** Lit des hashes, dans l'ordre des clés ; `null` pour une clé absente. Lève si le stockage ne répond pas. */
  abstract readHashes(keys: readonly string[]): Promise<Array<Record<string, string> | null>>;
  abstract get(key: string): Promise<string | null>;
  abstract set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** SET NX : `true` si posé, `false` si la clé existe, `null` si le stockage est indisponible. */
  abstract setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean | null>;
  abstract deleteIfEquals(key: string, value: string): Promise<void>;
  close(): void {
    // Rien par défaut.
  }
}

const DELETE_IF_EQUALS = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

export class RedisAdminStore extends AdminStore {
  private readonly logger = new Logger('AdminStore');
  private lastWarning = 0;

  constructor(private readonly redis: Redis) {
    super();
  }

  async increment(key: string, fields: Readonly<Record<string, number>>, ttlSeconds: number): Promise<void> {
    try {
      const pipeline = this.redis.multi();
      for (const [field, value] of Object.entries(fields)) pipeline.hincrby(key, field, value);
      pipeline.expire(key, ttlSeconds);
      await pipeline.exec();
    } catch (error) {
      this.warn(error);
    }
  }

  async readHashes(keys: readonly string[]): Promise<Array<Record<string, string> | null>> {
    const pipeline = this.redis.pipeline();
    for (const key of keys) pipeline.hgetall(key);
    const results = (await pipeline.exec()) ?? [];
    return results.map(([error, value]) => {
      if (error) throw error;
      const hash = value as Record<string, string> | null;
      return hash && Object.keys(hash).length > 0 ? hash : null;
    });
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch (error) {
      this.warn(error);
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, value, 'EX', Math.max(1, Math.round(ttlSeconds)));
    } catch (error) {
      this.warn(error);
    }
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean | null> {
    try {
      return (await this.redis.set(key, value, 'EX', Math.max(1, Math.round(ttlSeconds)), 'NX')) === 'OK';
    } catch (error) {
      this.warn(error);
      return null;
    }
  }

  async deleteIfEquals(key: string, value: string): Promise<void> {
    try {
      await this.redis.eval(DELETE_IF_EQUALS, 1, key, value);
    } catch (error) {
      this.warn(error);
    }
  }

  override close(): void {
    this.redis.disconnect();
  }

  private warn(error: unknown): void {
    if (Date.now() - this.lastWarning < 60_000) return;
    this.lastWarning = Date.now();
    this.logger.warn(`Redis de l'admin indisponible (${errorCode(error)})`);
  }
}

/** Stockage mémoire (tests, dev sans Redis), propre au processus. */
export class MemoryAdminStore extends AdminStore {
  private readonly hashes = new Map<string, Map<string, number>>();
  private readonly values = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {
    super();
  }

  async increment(key: string, fields: Readonly<Record<string, number>>): Promise<void> {
    const hash = this.hashes.get(key) ?? new Map<string, number>();
    for (const [field, value] of Object.entries(fields)) hash.set(field, (hash.get(field) ?? 0) + value);
    this.hashes.set(key, hash);
  }

  async readHashes(keys: readonly string[]): Promise<Array<Record<string, string> | null>> {
    return keys.map((key) => {
      const hash = this.hashes.get(key);
      return hash ? Object.fromEntries([...hash].map(([field, value]) => [field, String(value)])) : null;
    });
  }

  async get(key: string): Promise<string | null> {
    const entry = this.values.get(key);
    if (!entry || entry.expiresAt <= this.now()) return null;
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.values.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if ((await this.get(key)) !== null) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async deleteIfEquals(key: string, value: string): Promise<void> {
    if (this.values.get(key)?.value === value) this.values.delete(key);
  }
}

/** Connexion Redis dédiée de l'admin (échec rapide) ; mémoire sans `REDIS_URL`. */
export function createAdminStore(config: AppConfig): AdminStore {
  if (!config.redisUrl) return new MemoryAdminStore();
  const redis = new Redis(config.redisUrl, raijinRedisOptions());
  const logger = new Logger('AdminRedis');
  let lastWarning = 0;
  redis.on('error', (error: Error) => {
    if (Date.now() - lastWarning > 60_000) {
      lastWarning = Date.now();
      logger.warn(`Redis indisponible (${errorCode(error)})`);
    }
  });
  return new RedisAdminStore(redis);
}

/** JSON mis en cache `ttlSeconds` (lecture ratée ou entrée illisible : recalcul). */
export async function cached<T>(store: AdminStore, key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T> {
  const hit = await store.get(key);
  if (hit) {
    try {
      return JSON.parse(hit) as T;
    } catch {
      // Recalcul.
    }
  }
  const value = await compute();
  await store.set(key, JSON.stringify(value), ttlSeconds);
  return value;
}
