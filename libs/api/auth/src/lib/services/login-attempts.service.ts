import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { APP_CONFIG, errorCode, hmac, raijinRedisOptions, type AppConfig } from '@raijin/api-core';
import Redis from 'ioredis';

/** Stockage minimal d'un compteur à expiration. */
export interface AttemptStore {
  /** Incrémente et renvoie la nouvelle valeur ; l'expiration est posée au premier échec. */
  increment(key: string, ttlMs: number): Promise<number>;
  get(key: string): Promise<number>;
  reset(key: string): Promise<void>;
  close(): void;
}

/** Jeton d'injection optionnel d'un stockage (tests). */
export const ATTEMPT_STORE = Symbol('ATTEMPT_STORE');

/** Repli en mémoire (dev sans Redis, ou Redis indisponible). */
export class MemoryAttemptStore implements AttemptStore {
  private readonly entries = new Map<string, { count: number; expiresAt: number }>();

  private live(key: string): { count: number; expiresAt: number } | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  async increment(key: string, ttlMs: number): Promise<number> {
    const entry = this.live(key) ?? { count: 0, expiresAt: Date.now() + ttlMs };
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

  close(): void {
    this.entries.clear();
  }
}

/**
 * INCR + PEXPIRE atomiques (script Lua exécuté d'un bloc par Redis) : l'expiration est posée au
 * premier échec, ou reposée si la clé n'en a pas (clé héritée d'une ancienne version non atomique),
 * pour qu'un compteur ne puisse jamais rester sans expiration (verrouillage permanent).
 */
export const INCREMENT_WITH_TTL_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

/** Sous-ensemble d'ioredis utilisé (tests sans serveur). */
export type AttemptRedis = Pick<Redis, 'eval' | 'get' | 'del' | 'disconnect'>;

/** Compteur Redis partagé entre instances (INCR + PEXPIRE atomiques). */
export class RedisAttemptStore implements AttemptStore {
  constructor(private readonly redis: AttemptRedis) {}

  async increment(key: string, ttlMs: number): Promise<number> {
    const count = await this.redis.eval(INCREMENT_WITH_TTL_SCRIPT, 1, key, String(Math.max(1, Math.round(ttlMs))));
    return Number(count);
  }

  async get(key: string): Promise<number> {
    return Number((await this.redis.get(key)) ?? 0);
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(key);
  }

  close(): void {
    this.redis.disconnect();
  }
}

/**
 * Verrouillage temporaire par adresse (connexion, confirmation par mot de passe) : compteur
 * d'échecs indexé par HMAC(emailNormalized), appliqué aussi aux adresses sans compte, pour que
 * la réponse et le temps de traitement ne révèlent jamais si un compte existe.
 * Redis en priorité ; repli en mémoire (journalisé) si Redis ne répond pas.
 */
@Injectable()
export class LoginAttemptsService implements OnModuleDestroy {
  private readonly logger = new Logger('LoginAttempts');
  private readonly memory = new MemoryAttemptStore();
  private readonly primary: AttemptStore | null;
  private lastWarning = 0;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(ATTEMPT_STORE) store?: AttemptStore,
  ) {
    if (store) {
      this.primary = store;
    } else if (config.redisUrl) {
      const redis = new Redis(config.redisUrl, raijinRedisOptions());
      redis.on('error', (error: Error) => this.warn(`Redis indisponible (${errorCode(error)})`));
      this.primary = new RedisAttemptStore(redis);
    } else {
      this.primary = null;
    }
  }

  private key(emailNormalized: string): string {
    return `rj:auth-fail:${hmac(this.config.auth.cookieSecret, `login:${emailNormalized}`)}`;
  }

  private async run<T>(operation: (store: AttemptStore) => Promise<T>): Promise<T> {
    if (this.primary) {
      try {
        return await operation(this.primary);
      } catch (error) {
        this.warn(`Redis indisponible, compteur en mémoire (${errorCode(error)})`);
      }
    }
    return operation(this.memory);
  }

  /** Vrai si l'adresse a atteint le seuil d'échecs (verrouillage en cours). */
  async isLocked(emailNormalized: string): Promise<boolean> {
    const count = await this.run((store) => store.get(this.key(emailNormalized)));
    return count >= this.config.auth.lockoutThreshold;
  }

  /** Enregistre un échec ; renvoie vrai si ce échec déclenche le verrouillage. */
  async recordFailure(emailNormalized: string): Promise<boolean> {
    const count = await this.run((store) =>
      store.increment(this.key(emailNormalized), this.config.auth.lockoutMs),
    );
    return count === this.config.auth.lockoutThreshold;
  }

  async reset(emailNormalized: string): Promise<void> {
    await this.run((store) => store.reset(this.key(emailNormalized)));
  }

  /**
   * Compteurs à expiration d'autres usages (codes 2FA admin…), même stockage (Redis, script Lua atomique,
   * repli mémoire). `key` est construit par l'appelant, sans donnée personnelle en clair.
   */
  readonly counters = {
    get: (key: string): Promise<number> => this.run((store) => store.get(key)),
    increment: (key: string, ttlMs: number): Promise<number> => this.run((store) => store.increment(key, ttlMs)),
    reset: (key: string): Promise<void> => this.run((store) => store.reset(key)),
  };

  onModuleDestroy(): void {
    this.primary?.close();
    this.memory.close();
  }

  private warn(message: string): void {
    const now = Date.now();
    if (now - this.lastWarning > 60_000) {
      this.lastWarning = now;
      this.logger.warn(message);
    }
  }
}
