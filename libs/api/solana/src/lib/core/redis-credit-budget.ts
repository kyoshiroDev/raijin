import { MemoryCreditBudget } from './memory';
import { SILENT_LOGGER, SYSTEM_CLOCK, type Clock, type CreditBudget, type CreditLane, type SolanaLogger } from './ports';
import { utcDay } from './usage';

/**
 * Sous-ensemble Redis utilisé (structurel : `ioredis` convient, la lib n'en dépend pas).
 * `eval` exécute un script Lua atomique ; `get` lit un compteur.
 */
export interface RedisScriptClient {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

/**
 * Réservation atomique sur le compteur global et, pour une voie plafonnée, sur celui de la voie :
 * tous deux doivent rester sous leur plafond, sinon rien n'est réservé. Expiration posée à la création.
 * KEYS : compteurs ; ARGV[1] : crédits ; ARGV[2..n+1] : plafonds ; ARGV[n+2] : TTL (s).
 */
export const PREFIXED_CONSUME_CREDITS_SCRIPT = `
local n = #KEYS
local credits = tonumber(ARGV[1])
local over = false
for i = 1, n do
  local used = redis.call('INCRBY', KEYS[i], credits)
  if redis.call('TTL', KEYS[i]) < 0 then redis.call('EXPIRE', KEYS[i], ARGV[n + 2]) end
  if used > tonumber(ARGV[i + 1]) then over = true end
end
if over then
  for i = 1, n do redis.call('DECRBY', KEYS[i], credits) end
  return 0
end
return 1
`;

const TWO_DAYS_S = 2 * 86_400;
const PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}:$/;

export interface PrefixedRedisCreditBudgetOptions {
  /** Préfixe des clés (`raijin:`, `raijin-bench:`) : chaque application a ses compteurs (ACL Redis). */
  readonly prefix: string;
  /** Plafond global du jour UTC (crédits Helius). */
  readonly dailyLimit: number;
  /** Plafonds propres de voies, comptées aussi dans le global (bornés au global). */
  readonly laneLimits?: Readonly<Partial<Record<Exclude<CreditLane, 'interactive'>, number>>>;
  readonly clock?: Clock;
  readonly logger?: SolanaLogger;
}

/**
 * Budget journalier de crédits Helius sur Redis, clés **préfixées** par application :
 * `<prefix>helius:credits:<jour>` (global) et `<prefix>helius:credits:<voie>:<jour>`.
 * Redis absent ou en panne : repli en mémoire (par processus), avertissement au plus une fois par minute,
 * jamais d'exception. Aucune clé d'API ni donnée de requête n'est journalisée.
 */
export class PrefixedRedisCreditBudget implements CreditBudget {
  readonly prefix: string;
  private readonly dailyLimit: number;
  private readonly laneLimits: Readonly<Partial<Record<CreditLane, number>>>;
  private readonly clock: Clock;
  private readonly logger: SolanaLogger;
  private readonly fallback: MemoryCreditBudget;
  private lastWarning = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly redis: RedisScriptClient | null,
    options: PrefixedRedisCreditBudgetOptions,
  ) {
    if (!PREFIX_PATTERN.test(options.prefix)) throw new RangeError('Préfixe Redis invalide.');
    if (!Number.isSafeInteger(options.dailyLimit) || options.dailyLimit < 0) throw new RangeError('Budget invalide.');
    this.prefix = options.prefix;
    this.dailyLimit = options.dailyLimit;
    const lanes: Partial<Record<CreditLane, number>> = {};
    for (const [lane, value] of Object.entries(options.laneLimits ?? {}) as Array<[CreditLane, number | undefined]>) {
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Plafond de voie invalide.');
      lanes[lane] = Math.min(value, options.dailyLimit);
    }
    this.laneLimits = lanes;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.logger = options.logger ?? SILENT_LOGGER;
    this.fallback = new MemoryCreditBudget(this.dailyLimit, this.clock, lanes);
  }

  /** Plafond journalier de la voie (le global pour une voie non plafonnée). */
  limit(lane: CreditLane): number {
    return this.laneLimits[lane] ?? this.dailyLimit;
  }

  /** Clé du compteur d'une voie (`interactive` : compteur global). */
  key(lane: CreditLane, day: string = utcDay(this.clock.now())): string {
    return lane === 'interactive' || this.laneLimits[lane] === undefined
      ? `${this.prefix}helius:credits:${day}`
      : `${this.prefix}helius:credits:${lane}:${day}`;
  }

  async tryConsume(credits: number, lane: CreditLane = 'interactive'): Promise<boolean> {
    if (!Number.isSafeInteger(credits) || credits <= 0) return credits === 0;
    if (this.redis) {
      const day = utcDay(this.clock.now());
      const keys = [this.key('interactive', day)];
      const limits = [this.dailyLimit];
      const laneLimit = this.laneLimits[lane];
      if (lane !== 'interactive' && laneLimit !== undefined) {
        keys.push(this.key(lane, day));
        limits.push(laneLimit);
      }
      try {
        const ok = await this.redis.eval(PREFIXED_CONSUME_CREDITS_SCRIPT, keys.length, ...keys, String(credits), ...limits.map(String), String(TWO_DAYS_S));
        return Number(ok) === 1;
      } catch {
        this.warn();
      }
    }
    return this.fallback.tryConsume(credits, lane);
  }

  /** Crédits consommés aujourd'hui (UTC) sur la voie (global pour `interactive`) ; 0 si Redis ne répond pas. */
  async used(lane: CreditLane = 'interactive'): Promise<number> {
    if (!this.redis) return 0;
    try {
      const raw = await this.redis.get(this.key(lane));
      const value = raw !== null && /^\d{1,15}$/.test(raw) ? Number(raw) : 0;
      return Number.isSafeInteger(value) ? value : 0;
    } catch {
      this.warn();
      return 0;
    }
  }

  private warn(): void {
    const now = this.clock.now();
    if (now - this.lastWarning < 60_000) return;
    this.lastWarning = now;
    this.logger.warn('helius_budget_redis_unavailable', { prefix: this.prefix });
  }
}
