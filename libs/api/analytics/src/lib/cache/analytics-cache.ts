import { Logger } from '@nestjs/common';
import { errorCode } from '@raijin/api-core';
import type Redis from 'ioredis';

/**
 * Cache des réponses Google (`analytics:v1:<service>:<sha256(requête)>`). Les opérations ne lèvent jamais : une
 * panne de Redis renvoie `null` (lecture) et l'appel Google est refait. Le jeton OAuth n'y est **jamais** stocké.
 */
export abstract class AnalyticsCache {
  abstract get(key: string): Promise<string | null>;
  abstract set(key: string, value: string, ttlSeconds: number): Promise<void>;
  close(): void {
    // Rien par défaut.
  }
}

/** Cache Redis partagé entre instances. */
export class RedisAnalyticsCache extends AnalyticsCache {
  private readonly logger = new Logger('AnalyticsCache');
  private lastWarning = 0;

  constructor(private readonly redis: Pick<Redis, 'get' | 'set' | 'disconnect'>) {
    super();
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

  override close(): void {
    this.redis.disconnect();
  }

  private warn(error: unknown): void {
    if (Date.now() - this.lastWarning < 60_000) return;
    this.lastWarning = Date.now();
    this.logger.warn(`Cache Google indisponible (${errorCode(error)})`);
  }
}

/** Cache mémoire (tests, dev sans Redis) : borné à 200 entrées. */
export class MemoryAnalyticsCache extends AnalyticsCache {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {
    super();
  }

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.entries.size >= 200) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }
}
