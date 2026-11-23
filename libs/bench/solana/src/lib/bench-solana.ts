import {
  MemoryCacheStore,
  PrefixedRedisCreditBudget,
  SILENT_LOGGER,
  SYSTEM_CLOCK,
  SolanaDataService,
  type CacheStore,
  type Clock,
  type FetchLike,
  type SolanaLogger,
} from '@raijin/api-solana';
import { loadBenchSolanaSettings } from './config';
import { PublicSourceBackoff, withPublicBackoff, type PublicBackoffOptions } from './public-backoff';
import { PrefixedRedisCacheStore, type BenchRedisClient } from './redis-cache';
import { BenchWalletStudySource } from './wallet-study-source';

export interface BenchSolanaOptions {
  /** Environnement du banc (`process.env` de `raijin-bench-api`) : seules les variables `BENCH_*` sont lues. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Redis du banc (utilisateur ACL `raijin-bench`) ; `null` : compteurs et cache en mémoire. */
  readonly redis: BenchRedisClient | null;
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
  readonly logger?: SolanaLogger;
  readonly random?: () => number;
  readonly backoff?: PublicBackoffOptions;
}

export interface BenchHeliusCredits {
  readonly used: number;
  readonly budget: number;
  readonly ratio: number;
}

/** Intégrations Solana du banc, câblées (une instance par processus : files de débit partagées). */
export interface BenchSolana {
  readonly service: SolanaDataService;
  readonly budget: PrefixedRedisCreditBudget;
  readonly backoff: PublicSourceBackoff;
  readonly walletStudy: BenchWalletStudySource;
  /** Bloc `helius_credits` de `GET /api/status` ; `null` sans clé. */
  heliusCredits(): Promise<BenchHeliusCredits | null>;
}

/**
 * Instancie `SolanaDataService` (`@raijin/api-solana`) avec les paramètres **du banc** : clé
 * `BENCH_HELIUS_API_KEY`, 3 / 0,5 req/s, 10 000 crédits/jour UTC (dont wallet-study), compteurs et cache Redis
 * préfixés `raijin-bench:`, sources publiques à mi-débit avec recul sur 429. La clé ne sort jamais de l'instance.
 */
export function createBenchSolana(options: BenchSolanaOptions): BenchSolana {
  const settings = loadBenchSolanaSettings(options.env);
  const clock = options.clock ?? SYSTEM_CLOCK;
  const logger = options.logger ?? SILENT_LOGGER;
  const backoff = new PublicSourceBackoff({ clock, ...options.backoff });
  const baseFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const budget = new PrefixedRedisCreditBudget(options.redis, {
    prefix: settings.redisPrefix,
    dailyLimit: settings.dailyCreditBudget,
    laneLimits: { wallet: settings.walletStudyDailyCredits },
    clock,
    logger,
  });
  const cache: CacheStore = options.redis ? new PrefixedRedisCacheStore(options.redis, `${settings.redisPrefix}solana:`) : new MemoryCacheStore(clock);

  // La configuration résolue (URL de base) sert au routage du recul : construite une fois, sans la clé.
  let wrappedFetch: FetchLike = baseFetch;
  const service = new SolanaDataService({
    config: settings.solana,
    heliusApiKey: settings.heliusApiKey,
    fetch: (input, init) => wrappedFetch(input, init),
    cache,
    creditBudget: budget,
    clock,
    logger,
    random: options.random,
  });
  wrappedFetch = withPublicBackoff(baseFetch, service.config, backoff);

  const walletStudy = new BenchWalletStudySource({ service, budget, flags: cache, clock, logger });

  return {
    service,
    budget,
    backoff,
    walletStudy,
    async heliusCredits() {
      if (!service.heliusConfigured) return null;
      const used = await budget.used('interactive');
      const total = settings.dailyCreditBudget;
      return { used, budget: total, ratio: total === 0 ? 1 : Math.min(1, used / total) };
    },
  };
}
