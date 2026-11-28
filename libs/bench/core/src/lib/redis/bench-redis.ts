import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Redis, { type RedisOptions } from 'ioredis';
import type { BenchConfig } from '../config/bench-config';
import { BENCH_CONFIG } from '../config/tokens';
import { errorCodeOf } from '../security/redact';

/** Préfixe de toutes les clés Redis du banc (ACL `~raijin-bench:*`, docs/ARCHITECTURE.md §17.5). */
export const BENCH_REDIS_KEY_PREFIX = 'raijin-bench:';

/** Options communes : échec rapide (l'API reste disponible, repli en mémoire), jamais d'URL journalisée. */
export function benchRedisOptions(extra: RedisOptions = {}): RedisOptions {
  return { maxRetriesPerRequest: 1, connectTimeout: 2_000, enableOfflineQueue: true, ...extra };
}

/**
 * Connexions Redis du banc :
 * - `prefixed` (`keyPrefix: 'raijin-bench:'`) : verrous de jobs, tentatives de connexion, limites ;
 * - `plain` (sans `keyPrefix`) : intégrations Solana (`@raijin/bench-solana` préfixe lui-même ses clés,
 *   sinon `raijin-bench:raijin-bench:…`).
 * `null` sans `REDIS_URL` (dev/test) : chaque utilisateur se replie en mémoire.
 */
@Injectable()
export class BenchRedis implements OnApplicationShutdown {
  private readonly logger = new Logger('BenchRedis');
  readonly prefixed: Redis | null;
  readonly plain: Redis | null;
  private lastWarning = 0;

  constructor(@Inject(BENCH_CONFIG) config: BenchConfig) {
    this.prefixed = config.redisUrl ? this.connect(config.redisUrl, { keyPrefix: BENCH_REDIS_KEY_PREFIX }) : null;
    this.plain = config.redisUrl ? this.connect(config.redisUrl, {}) : null;
  }

  private connect(url: string, options: RedisOptions): Redis {
    const redis = new Redis(url, benchRedisOptions(options));
    redis.on('error', (error: Error) => this.warn(`Redis du banc indisponible (${errorCodeOf(error)})`));
    return redis;
  }

  /** `up` si Redis répond à PING en moins de 1 s. */
  async ping(): Promise<boolean> {
    if (!this.plain) return false;
    try {
      const reply = await Promise.race([this.plain.ping(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000).unref())]);
      return reply === 'PONG';
    } catch {
      return false;
    }
  }

  warn(message: string): void {
    const now = Date.now();
    if (now - this.lastWarning > 60_000) {
      this.lastWarning = now;
      this.logger.warn(message);
    }
  }

  onApplicationShutdown(): void {
    this.prefixed?.disconnect();
    this.plain?.disconnect();
  }
}
