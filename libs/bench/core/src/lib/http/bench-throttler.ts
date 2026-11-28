import { ExecutionContext, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { ThrottlerGuard, ThrottlerStorage, ThrottlerStorageService, type ThrottlerModuleOptions } from '@nestjs/throttler';
import Redis from 'ioredis';
import type { BenchConfig } from '../config/bench-config';
import { BENCH_REDIS_KEY_PREFIX, benchRedisOptions } from '../redis/bench-redis';
import { errorCodeOf } from '../security/redact';
import { ipBucket } from '../security/ip-bucket';
import { BENCH_LOGIN_THROTTLE } from './decorators';

type StorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/** Limite globale par IP (requêtes par minute) : un seul utilisateur, déjà derrière le basicAuth et Traefik. */
export const BENCH_RATE_LIMIT_PER_MINUTE = 240;
/** Limite renforcée de `POST /api/auth/login` par IP (par minute). */
export const BENCH_LOGIN_PER_MINUTE = 10;

/** Stockage Redis (`raijin-bench:` + clé du throttler) avec repli en mémoire si Redis ne répond pas. */
export class ResilientBenchThrottlerStorage implements ThrottlerStorage, OnApplicationShutdown {
  private readonly logger = new Logger('BenchThrottler');
  private readonly memory = new ThrottlerStorageService();
  private lastWarning = 0;

  constructor(
    private readonly primary: ThrottlerStorage | null,
    private readonly close: () => void = () => undefined,
  ) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<StorageRecord> {
    if (this.primary) {
      try {
        return await this.primary.increment(key, ttl, limit, blockDuration, throttlerName);
      } catch (error) {
        this.warn(`Redis indisponible, limites en mémoire (${errorCodeOf(error)})`);
      }
    }
    return this.memory.increment(key, ttl, limit, blockDuration, throttlerName);
  }

  warn(message: string): void {
    const now = Date.now();
    if (now - this.lastWarning > 60_000) {
      this.lastWarning = now;
      this.logger.warn(message);
    }
  }

  onApplicationShutdown(): void {
    this.memory.onApplicationShutdown();
    this.close();
  }
}

export function createBenchThrottlerStorage(redisUrl: string | null): ResilientBenchThrottlerStorage {
  if (!redisUrl) return new ResilientBenchThrottlerStorage(null);
  const redis = new Redis(redisUrl, benchRedisOptions({ keyPrefix: BENCH_REDIS_KEY_PREFIX }));
  const storage = new ResilientBenchThrottlerStorage(new ThrottlerStorageRedisService(redis), () => redis.disconnect());
  redis.on('error', (error: Error) => storage.warn(`Redis indisponible (${errorCodeOf(error)})`));
  return storage;
}

function hasLoginThrottle(context: ExecutionContext): boolean {
  return Reflect.getMetadata(BENCH_LOGIN_THROTTLE, context.getHandler()) === true || Reflect.getMetadata(BENCH_LOGIN_THROTTLE, context.getClass()) === true;
}

export function benchThrottlerOptions(config: BenchConfig): ThrottlerModuleOptions {
  return {
    storage: createBenchThrottlerStorage(config.redisUrl),
    throttlers: [
      { name: 'default', ttl: 60_000, limit: BENCH_RATE_LIMIT_PER_MINUTE },
      { name: 'login', ttl: 60_000, limit: BENCH_LOGIN_PER_MINUTE, skipIf: (context: ExecutionContext) => !hasLoginThrottle(context) },
    ],
  };
}

/** Garde de rate limiting : suivi par IP (IPv6 regroupée par /64), 429 `RATE_LIMITED` (rendu par le filtre). */
@Injectable()
export class BenchThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    return ipBucket(typeof req['ip'] === 'string' ? req['ip'] : null);
  }
}
