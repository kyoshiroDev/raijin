import {
  ExecutionContext,
  HttpStatus,
  Injectable,
  Logger,
  Module,
  OnApplicationShutdown,
  SetMetadata,
} from '@nestjs/common';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import {
  ThrottlerGuard,
  ThrottlerModule,
  ThrottlerStorage,
  ThrottlerStorageService,
} from '@nestjs/throttler';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { ApiException } from '../errors/api-exception';

type StorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

export const AUTH_THROTTLE = 'raijin:auth-throttle';

/**
 * Applique en plus la limite renforcée des routes d'auth (`RATE_LIMIT_AUTH_PER_MINUTE` par IP et
 * par route) : connexion, inscription, liens par e-mail, réinitialisation.
 */
export const AuthThrottle = (): MethodDecorator & ClassDecorator => SetMetadata(AUTH_THROTTLE, true);

function hasAuthThrottle(context: ExecutionContext): boolean {
  return (
    Reflect.getMetadata(AUTH_THROTTLE, context.getHandler()) === true ||
    Reflect.getMetadata(AUTH_THROTTLE, context.getClass()) === true
  );
}

/**
 * Stockage Redis (partagé entre instances) avec repli en mémoire si Redis ne répond pas :
 * l'API reste disponible (limites par instance) et l'incident est journalisé.
 */
export class ResilientThrottlerStorage implements ThrottlerStorage, OnApplicationShutdown {
  private readonly logger = new Logger('Throttler');
  private readonly memory = new ThrottlerStorageService();
  private lastWarning = 0;

  constructor(
    private readonly primary: ThrottlerStorage | null,
    private readonly close: () => void = () => undefined,
  ) {}

  onApplicationShutdown(): void {
    this.memory.onApplicationShutdown();
    this.close();
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<StorageRecord> {
    if (this.primary) {
      try {
        return await this.primary.increment(key, ttl, limit, blockDuration, throttlerName);
      } catch (error) {
        const now = Date.now();
        this.warn(`Redis indisponible, limites en mémoire : ${(error as Error).message}`);
      }
    }
    return this.memory.increment(key, ttl, limit, blockDuration, throttlerName);
  }

  /** Avertissement limité à un par minute (pas d'inondation des journaux). */
  warn(message: string): void {
    const now = Date.now();
    if (now - this.lastWarning > 60_000) {
      this.lastWarning = now;
      this.logger.warn(message);
    }
  }
}

export function createThrottlerStorage(redisUrl: string | null): ResilientThrottlerStorage {
  if (!redisUrl) return new ResilientThrottlerStorage(null);
  const redis = new ThrottlerStorageRedisService(redisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2_000,
  });
  const storage = new ResilientThrottlerStorage(redis, () => redis.redis.disconnect());
  redis.redis.on('error', (error: Error) => storage.warn(`Redis : ${error.message}`));
  return storage;
}

/** Garde de rate limiting globale : 429 au format `{code: 'RATE_LIMITED', message}`. */
@Injectable()
export class ApiThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    return typeof req['ip'] === 'string' ? req['ip'] : 'unknown';
  }

  protected override async throwThrottlingException(): Promise<void> {
    throw new ApiException('RATE_LIMITED', HttpStatus.TOO_MANY_REQUESTS);
  }
}

/** Module de rate limiting : limite globale + limite d'auth (activée par `@AuthThrottle()`). */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        storage: createThrottlerStorage(config.redisUrl),
        throttlers: [
          { name: 'default', ttl: 60_000, limit: config.rateLimit.perMinute },
          {
            name: 'auth',
            ttl: 60_000,
            limit: config.rateLimit.authPerMinute,
            skipIf: (context: ExecutionContext) => !hasAuthThrottle(context),
          },
        ],
      }),
    }),
  ],
  exports: [ThrottlerModule],
})
export class ApiThrottlerModule {}
