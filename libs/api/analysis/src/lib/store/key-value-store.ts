import { Logger } from '@nestjs/common';
import { errorCode } from '@raijin/api-core';
import Redis from 'ioredis';

/**
 * Stockage clé-valeur à expiration utilisé par l'analyse (cache des résultats, verrous,
 * anti-double-comptage du quota, cache de l'image OG). Les opérations ne lèvent jamais :
 * une panne renvoie `null` (lecture) ou `false` (écriture), et l'appelant se replie
 * (calcul sans cache, single-flight mémoire seul, quota compté en base).
 */
export abstract class KeyValueStore {
  abstract get(key: string): Promise<string | null>;
  abstract set(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** SET NX PX : `true` si posé, `false` si la clé existe déjà, `null` si le stockage est indisponible. */
  abstract setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean | null>;
  abstract delete(key: string): Promise<void>;
  /** Supprime la clé seulement si elle vaut encore `value` (libération d'un verrou qui nous appartient). */
  abstract deleteIfEquals(key: string, value: string): Promise<void>;
  close(): void {
    // Rien par défaut.
  }
}

const DELETE_IF_EQUALS_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** Implémentation Redis (partagée entre instances). */
export class RedisKeyValueStore extends KeyValueStore {
  private readonly logger = new Logger('AnalysisStore');
  private lastWarning = 0;

  constructor(private readonly redis: Pick<Redis, 'get' | 'set' | 'del' | 'eval' | 'disconnect'>) {
    super();
  }

  static connect(url: string): RedisKeyValueStore {
    const redis = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2_000 });
    const store = new RedisKeyValueStore(redis);
    redis.on('error', (error: Error) => store.warn(error));
    return store;
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch (error) {
      this.warn(error);
      return null;
    }
  }

  async set(key: string, value: string, ttlMs: number): Promise<boolean> {
    try {
      await this.redis.set(key, value, 'PX', Math.max(1, Math.round(ttlMs)));
      return true;
    } catch (error) {
      this.warn(error);
      return false;
    }
  }

  async setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean | null> {
    try {
      return (await this.redis.set(key, value, 'PX', Math.max(1, Math.round(ttlMs)), 'NX')) === 'OK';
    } catch (error) {
      this.warn(error);
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (error) {
      this.warn(error);
    }
  }

  async deleteIfEquals(key: string, value: string): Promise<void> {
    try {
      await this.redis.eval(DELETE_IF_EQUALS_SCRIPT, 1, key, value);
    } catch (error) {
      this.warn(error);
    }
  }

  override close(): void {
    this.redis.disconnect();
  }

  /** Avertissement limité à un par minute, code d'erreur seulement (jamais le message du pilote). */
  warn(error: unknown): void {
    const now = Date.now();
    if (now - this.lastWarning > 60_000) {
      this.lastWarning = now;
      this.logger.warn(`Redis indisponible, analyse sans cache partagé (${errorCode(error)})`);
    }
  }
}

/** Implémentation mémoire (développement sans Redis, tests). Limitée à une instance. */
export class MemoryKeyValueStore extends KeyValueStore {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {
    super();
  }

  private live(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key);
  }

  async set(key: string, value: string, ttlMs: number): Promise<boolean> {
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    return true;
  }

  async setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean | null> {
    if (this.live(key) !== null) return false;
    await this.set(key, value, ttlMs);
    return true;
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async deleteIfEquals(key: string, value: string): Promise<void> {
    if (this.live(key) === value) this.entries.delete(key);
  }

  override close(): void {
    this.entries.clear();
  }
}
