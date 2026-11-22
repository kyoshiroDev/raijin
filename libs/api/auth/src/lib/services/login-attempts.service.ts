import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { APP_CONFIG, hmac, type AppConfig } from '@raijin/api-core';
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

/** Compteur Redis partagé entre instances (INCR + PEXPIRE au premier échec). */
export class RedisAttemptStore implements AttemptStore {
  constructor(private readonly redis: Redis) {}

  async increment(key: string, ttlMs: number): Promise<number> {
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.pexpire(key, ttlMs);
    return count;
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
      const redis = new Redis(config.redisUrl, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: 2_000,
      });
      redis.on('error', (error: Error) => this.warn(`Redis : ${error.message}`));
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
        this.warn(`Redis indisponible, compteur en mémoire : ${(error as Error).message}`);
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
