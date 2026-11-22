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

const TWO_DAYS_S = 2 * 86_400;

/**
 * Budget journalier de crédits Helius partagé entre instances (`HELIUS_DAILY_CREDIT_BUDGET`, jour UTC).
 * Redis indisponible : repli sur un budget en mémoire (par instance), journalisé.
 */
export class RedisCreditBudget implements CreditBudget {
  private readonly logger = new Logger('HeliusBudget');
  private readonly fallback: MemoryCreditBudget;
  private lastWarning = 0;

  constructor(
    private readonly redis: Pick<Redis, 'eval'> | null,
    private readonly dailyLimit: number,
    private readonly clock: Clock = { now: () => Date.now() },
  ) {
    this.fallback = new MemoryCreditBudget(dailyLimit, clock);
  }

  async tryConsume(credits: number): Promise<boolean> {
    if (this.redis) {
      const day = new Date(this.clock.now()).toISOString().slice(0, 10);
      try {
        const ok = await this.redis.eval(CONSUME_CREDITS_SCRIPT, 1, `helius:credits:${day}`, String(credits), String(this.dailyLimit), String(TWO_DAYS_S));
        return Number(ok) === 1;
      } catch (error) {
        const now = Date.now();
        if (now - this.lastWarning > 60_000) {
          this.lastWarning = now;
          this.logger.warn(`Redis indisponible, budget Helius en mémoire (${errorCode(error)})`);
        }
      }
    }
    return this.fallback.tryConsume(credits);
  }
}
