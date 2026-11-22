import { Logger } from '@nestjs/common';
import { errorCode } from '@raijin/api-core';
import { MemoryCreditBudget, type CacheStore, type Clock, type CreditBudget } from '@raijin/api-solana';
import type Redis from 'ioredis';
import { KeyValueStore } from '../store/key-value-store';

/** `CacheStore` de `@raijin/api-solana` (caches par source) sur le stockage de l'analyse (Redis ou mémoire). */
export class SolanaCacheStore implements CacheStore {
  constructor(private readonly store: KeyValueStore) {}

  get(key: string): Promise<string | null> {
    return this.store.get(`solana:${key}`);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.store.set(`solana:${key}`, value, ttlSeconds * 1000);
  }
}

/**
 * Réservation atomique de crédits Helius sur le compteur du jour (un seul aller-retour Redis) :
 * INCRBY, expiration posée à la création (ou si absente), annulation si le budget est dépassé.
 */
export const CONSUME_CREDITS_SCRIPT = `
local used = redis.call('INCRBY', KEYS[1], ARGV[1])
if used == tonumber(ARGV[1]) or redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
if used > tonumber(ARGV[2]) then
  redis.call('DECRBY', KEYS[1], ARGV[1])
  return 0
end
return 1
`;

/**
 * Variante à deux compteurs (voie `watch`) : le global et celui de la voie doivent tous deux rester
 * sous leur plafond, sinon rien n'est réservé.
 */
export const CONSUME_LANE_CREDITS_SCRIPT = `
local global = redis.call('INCRBY', KEYS[1], ARGV[1])
local lane = redis.call('INCRBY', KEYS[2], ARGV[1])
for i = 1, 2 do
  if redis.call('TTL', KEYS[i]) < 0 then redis.call('EXPIRE', KEYS[i], ARGV[4]) end
end
if global > tonumber(ARGV[2]) or lane > tonumber(ARGV[3]) then
  redis.call('DECRBY', KEYS[1], ARGV[1])
  redis.call('DECRBY', KEYS[2], ARGV[1])
  return 0
end
return 1
`;

const TWO_DAYS_S = 2 * 86_400;

/** Voie de crédits : analyses à la demande ou passes de suivi (docs/ARCHITECTURE.md §11.4). */
export type HeliusCreditLane = 'interactive' | 'watch';

/**
 * Budget journalier de crédits Helius partagé entre instances (`HELIUS_DAILY_CREDIT_BUDGET`, jour UTC),
 * avec la voie `watch` plafonnée à part (`WATCH_DAILY_CREDIT_BUDGET`, comptée aussi dans le global) :
 * compteurs `helius:credits:<jour>` et `helius:credits:watch:<jour>`.
 * Redis indisponible : repli sur un budget en mémoire (par instance), journalisé.
 */
export class RedisCreditBudget implements CreditBudget {
  private readonly logger = new Logger('HeliusBudget');
  private readonly fallback: MemoryCreditBudget;
  private readonly fallbackWatch: MemoryCreditBudget;
  private lastWarning = 0;

  constructor(
    private readonly redis: Pick<Redis, 'eval' | 'get'> | null,
    private readonly dailyLimit: number,
    private readonly clock: Clock = { now: () => Date.now() },
    private readonly watchDailyLimit: number = dailyLimit,
  ) {
    this.fallback = new MemoryCreditBudget(dailyLimit, clock);
    this.fallbackWatch = new MemoryCreditBudget(Math.min(watchDailyLimit, dailyLimit), clock);
  }

  /** Plafond journalier de la voie. */
  limit(lane: HeliusCreditLane): number {
    return lane === 'watch' ? Math.min(this.watchDailyLimit, this.dailyLimit) : this.dailyLimit;
  }

  async tryConsume(credits: number, lane: HeliusCreditLane = 'interactive'): Promise<boolean> {
    if (this.redis) {
      const day = this.day();
      try {
        const ok =
          lane === 'watch'
            ? await this.redis.eval(
                CONSUME_LANE_CREDITS_SCRIPT,
                2,
                `helius:credits:${day}`,
                `helius:credits:watch:${day}`,
                String(credits),
                String(this.dailyLimit),
                String(this.watchDailyLimit),
                String(TWO_DAYS_S),
              )
            : await this.redis.eval(CONSUME_CREDITS_SCRIPT, 1, `helius:credits:${day}`, String(credits), String(this.dailyLimit), String(TWO_DAYS_S));
        return Number(ok) === 1;
      } catch (error) {
        this.warn(error);
      }
    }
    if (lane === 'watch' && !(await this.fallbackWatch.tryConsume(credits))) return false;
    return this.fallback.tryConsume(credits);
  }

  /** Crédits déjà consommés aujourd'hui (UTC) sur la voie ; 0 si Redis ne répond pas. */
  async used(lane: HeliusCreditLane): Promise<number> {
    if (!this.redis) return 0;
    const day = this.day();
    try {
      const raw = await this.redis.get(lane === 'watch' ? `helius:credits:watch:${day}` : `helius:credits:${day}`);
      return raw ? Number(raw) || 0 : 0;
    } catch (error) {
      this.warn(error);
      return 0;
    }
  }

  private day(): string {
    return new Date(this.clock.now()).toISOString().slice(0, 10);
  }

  private warn(error: unknown): void {
    const now = Date.now();
    if (now - this.lastWarning > 60_000) {
      this.lastWarning = now;
      this.logger.warn(`Redis indisponible, budget Helius en mémoire (${errorCode(error)})`);
    }
  }
}
