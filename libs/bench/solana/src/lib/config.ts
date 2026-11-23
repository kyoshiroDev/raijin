import { DEFAULT_SOLANA_DATA_CONFIG, normaliseHeliusApiKey, type SolanaDataConfigInput, type UpstreamId } from '@raijin/api-solana';
import * as z from 'zod';

/**
 * Paramètres Solana du banc (docs/ARCHITECTURE.md §17.5, docs/BENCH.md §9 P1 et P6, docs/ENV.md « Banc »).
 *
 * - Clé **propre au banc** : `BENCH_HELIUS_API_KEY`. `HELIUS_API_KEY` (celle de Raijin) n'est jamais lue :
 *   seules les variables `BENCH_*` sont extraites de l'environnement.
 * - Helius : 3 req/s RPC, 0,5 req/s DAS, 10 000 crédits par jour UTC au plus (Raijin : 7 / 1,5 / 22 000,
 *   l'ensemble reste sous l'offre gratuite 10 / 2 req/s). Les variables ne peuvent que **baisser** ces valeurs.
 * - Sources publiques appelées depuis la même IP que Raijin (DexScreener, GeckoTerminal, Jupiter, RugCheck,
 *   RPC public) : **moitié** des débits de Raijin, valeur fixe (Raijin reste prioritaire), et recul exponentiel
 *   sur 429 (`PublicSourceBackoff`).
 */
export const BENCH_REDIS_PREFIX = 'raijin-bench:';
export const BENCH_HELIUS_RPC_RPS_MAX = 3;
export const BENCH_HELIUS_DAS_RPS_MAX = 0.5;
export const BENCH_HELIUS_DAILY_CREDITS_MAX = 10_000;
export const BENCH_WALLET_STUDY_DAILY_CREDITS_DEFAULT = 2_000;

/** Part des débits de Raijin accordée au banc sur les sources publiques à IP partagée. */
export const BENCH_PUBLIC_RATE_SHARE = 0.5;
export const BENCH_SHARED_IP_SOURCES = ['solana_rpc', 'dexscreener', 'geckoterminal', 'jupiter', 'rugcheck'] as const satisfies readonly UpstreamId[];
export type BenchSharedIpSource = (typeof BENCH_SHARED_IP_SOURCES)[number];

const envSchema = z.object({
  BENCH_HELIUS_API_KEY: z.string().max(256).optional(),
  BENCH_HELIUS_RPC_RPS: z.coerce.number().positive().max(BENCH_HELIUS_RPC_RPS_MAX).optional(),
  BENCH_HELIUS_DAS_RPS: z.coerce.number().positive().max(BENCH_HELIUS_DAS_RPS_MAX).optional(),
  BENCH_HELIUS_DAILY_CREDIT_BUDGET: z.coerce.number().int().min(0).max(BENCH_HELIUS_DAILY_CREDITS_MAX).optional(),
  BENCH_WALLET_STUDY_DAILY_CREDITS: z.coerce.number().int().min(0).max(BENCH_HELIUS_DAILY_CREDITS_MAX).optional(),
});

const ENV_KEYS = Object.keys(envSchema.shape) as Array<keyof z.infer<typeof envSchema>>;

export interface BenchSolanaSettings {
  /** Configuration passée à `SolanaDataService` (débits, budgets). */
  readonly solana: NonNullable<SolanaDataConfigInput>;
  /** Clé Helius du banc (jamais journalisée) ou `null` : RPC public, contrôles Helius « indisponible ». */
  readonly heliusApiKey: string | null;
  readonly dailyCreditBudget: number;
  /** Plafond journalier de wallet-study (voie `wallet`), compris dans `dailyCreditBudget`. */
  readonly walletStudyDailyCredits: number;
  readonly redisPrefix: typeof BENCH_REDIS_PREFIX;
}

/** Débits du banc sur les sources à IP partagée : moitié de ceux de Raijin. */
export function benchSharedIpLimits(): Record<BenchSharedIpSource, { ratePerSecond: number; maxQueue: number }> {
  const base = DEFAULT_SOLANA_DATA_CONFIG.limits;
  return Object.fromEntries(
    BENCH_SHARED_IP_SOURCES.map((source) => [
      source,
      { ratePerSecond: base[source].ratePerSecond * BENCH_PUBLIC_RATE_SHARE, maxQueue: Math.max(1, Math.ceil(base[source].maxQueue / 2)) },
    ]),
  ) as Record<BenchSharedIpSource, { ratePerSecond: number; maxQueue: number }>;
}

/**
 * Lit les paramètres depuis l'environnement du banc (`infra/.env.bench-api`). Seules les variables `BENCH_*`
 * listées ici sont lues ; une valeur invalide lève une erreur qui ne cite **que le nom** de la variable.
 */
export function loadBenchSolanaSettings(env: Readonly<Record<string, string | undefined>>): BenchSolanaSettings {
  const picked: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') picked[key] = value;
  }
  const parsed = envSchema.safeParse(picked);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))].join(', ');
    throw new Error(`Configuration Solana du banc invalide : ${names}.`);
  }
  const e = parsed.data;
  const dailyCreditBudget = e.BENCH_HELIUS_DAILY_CREDIT_BUDGET ?? BENCH_HELIUS_DAILY_CREDITS_MAX;
  const walletStudyDailyCredits = e.BENCH_WALLET_STUDY_DAILY_CREDITS ?? Math.min(BENCH_WALLET_STUDY_DAILY_CREDITS_DEFAULT, dailyCreditBudget);
  if (walletStudyDailyCredits > dailyCreditBudget) {
    throw new Error('Configuration Solana du banc invalide : BENCH_WALLET_STUDY_DAILY_CREDITS.');
  }
  return {
    solana: {
      heliusDailyCreditBudget: dailyCreditBudget,
      // Le banc ne scanne pas de wallets : la voie `wallet` est celle de wallet-study ; `watch` sans plafond propre.
      walletDailyCreditBudget: walletStudyDailyCredits,
      watchDailyCreditBudget: dailyCreditBudget,
      limits: {
        helius_rpc: { ratePerSecond: e.BENCH_HELIUS_RPC_RPS ?? BENCH_HELIUS_RPC_RPS_MAX, maxQueue: 25 },
        helius_das: { ratePerSecond: e.BENCH_HELIUS_DAS_RPS ?? BENCH_HELIUS_DAS_RPS_MAX, maxQueue: 5 },
        ...benchSharedIpLimits(),
      },
    },
    heliusApiKey: normaliseHeliusApiKey(e.BENCH_HELIUS_API_KEY),
    dailyCreditBudget,
    walletStudyDailyCredits,
    redisPrefix: BENCH_REDIS_PREFIX,
  };
}
