import * as z from 'zod';
import type { UpstreamId } from './core/errors';

export interface SourceLimits {
  /** Débit autorisé (req/s). */
  readonly ratePerSecond: number;
  /** File d'attente maximale avant échec rapide. */
  readonly maxQueue: number;
  /** Délai par appel (ms). */
  readonly timeoutMs: number;
}

/**
 * Configuration des intégrations Solana. Les URL de base sont **fixes** (configurables, https
 * seulement, sans identifiants ni query string) : le mint validé est la seule donnée insérée
 * dans un chemin (anti-SSRF, ARCHITECTURE.md §9.8). Limites vérifiées dans la doc officielle :
 * README.md de la lib.
 */
export interface SolanaDataConfig {
  readonly heliusRpcBaseUrl: string;
  readonly publicRpcUrl: string;
  readonly dexscreenerBaseUrl: string;
  readonly geckoterminalBaseUrl: string;
  readonly jupiterBaseUrl: string;
  readonly rugcheckBaseUrl: string;
  readonly limits: Readonly<Record<UpstreamId, SourceLimits>>;
  /** Crédits Helius par jour UTC (API 22 000, banc 10 000). */
  readonly heliusDailyCreditBudget: number;
  /**
   * Plafond journalier de la voie `watch` (passes de suivi), compté dans le budget global
   * (ARCHITECTURE.md §11.4 : 12 000 sur 22 000, les analyses à la demande gardent au moins 10 000).
   */
  readonly watchDailyCreditBudget: number;
  /**
   * Plafond journalier de la voie `wallet` (scans de wallet), compté dans le budget global
   * (ARCHITECTURE.md §12.3 : 3 000 sur 22 000).
   */
  readonly walletDailyCreditBudget: number;
  /** Scan de wallet (ARCHITECTURE.md §12, variables `WALLET_SCAN_*` de docs/ENV.md). */
  readonly wallet: WalletScanConfig;
  /** Durée de cache des propriétaires de comptes de token et de leur programme (passe holders, s). */
  readonly holderOwnersCacheTtlSeconds: number;
  readonly maxResponseBytes: number;
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly maxRetryAfterMs: number;
  readonly breakerThreshold: number;
  readonly breakerCooldownMs: number;
  /** Échéance globale de `collectFacts` (ms). */
  readonly collectDeadlineMs: number;
  /** Montant du devis de vente de test (USD). Devis seulement : aucune transaction. */
  readonly sellTestAmountUsd: number;
  readonly sellSlippageBps: number;
  readonly signaturePageLimit: number;
  readonly maxSignaturePages: number;
  /** Pool existant avec une liquidité totale sous ce montant : LP considérée comme retirée (USD). */
  readonly lpRemovedMaxUsd: number;
  /** Token du créateur considéré comme mort : capitalisation sous ce montant (USD)… */
  readonly creatorDeadMarketCapUsd: number;
  /** … et plus vieux que ce délai (heures), pour ne pas compter un lancement en cours. */
  readonly creatorDeadMinAgeHours: number;
  readonly cacheTtlSeconds: {
    readonly tokenAge: number;
    readonly creator: number;
    readonly rugcheck: number;
  };
}

export interface WalletScanConfig {
  /** Au-delà de ce nombre de comptes de tokens (SPL + Token-2022) : `WalletTooLargeError`. */
  readonly maxAccounts: number;
  /** Tokens analysés par scan avec clé Helius (les suivants : `over_limit`). */
  readonly maxTokens: number;
  /** Tokens analysés par scan sans clé Helius (RPC public à 1 req/s). */
  readonly maxTokensNoKey: number;
  /** Mints dont le prix est demandé à DexScreener (lots de 30) ; au-delà, prix inconnu. */
  readonly priceLookupMax: number;
  /** Valeur connue sous ce seuil (USD) : poussière, non analysée. Prix inconnu ≠ poussière. */
  readonly dustUsd: number;
  /** Échéance de `collectFactsLightBatch` (ms). */
  readonly deadlineMs: number;
  /** Délai d'un appel `getTokenAccountsByOwner` (réponse jusqu'à 2 Mo, lente sur le RPC public). */
  readonly accountsTimeoutMs: number;
  /** Cache des faits `light` par mint (s) ; partagé entre scans, indépendant de la version du moteur. */
  readonly lightFactsCacheTtlSeconds: number;
  /** Cache des faits `light` dégradés (source manquante) : plus court (s). */
  readonly degradedLightFactsCacheTtlSeconds: number;
  /** Cache des paires DexScreener lues pour les prix, réutilisées pour la liquidité (s). */
  readonly pairsCacheTtlSeconds: number;
}

export const DEFAULT_SOLANA_DATA_CONFIG: SolanaDataConfig = {
  heliusRpcBaseUrl: 'https://mainnet.helius-rpc.com',
  publicRpcUrl: 'https://api.mainnet-beta.solana.com',
  dexscreenerBaseUrl: 'https://api.dexscreener.com',
  geckoterminalBaseUrl: 'https://api.geckoterminal.com/api/v2',
  jupiterBaseUrl: 'https://lite-api.jup.ag/swap/v1',
  rugcheckBaseUrl: 'https://api.rugcheck.xyz/v1',
  limits: {
    helius_rpc: { ratePerSecond: 7, maxQueue: 50, timeoutMs: 3_000 },
    helius_das: { ratePerSecond: 1.5, maxQueue: 10, timeoutMs: 3_000 },
    solana_rpc: { ratePerSecond: 1, maxQueue: 8, timeoutMs: 3_000 },
    dexscreener: { ratePerSecond: 4, maxQueue: 20, timeoutMs: 3_000 },
    geckoterminal: { ratePerSecond: 10 / 60, maxQueue: 2, timeoutMs: 3_000 },
    jupiter: { ratePerSecond: 0.5, maxQueue: 4, timeoutMs: 4_000 },
    rugcheck: { ratePerSecond: 1, maxQueue: 6, timeoutMs: 3_000 },
  },
  heliusDailyCreditBudget: 22_000,
  watchDailyCreditBudget: 12_000,
  walletDailyCreditBudget: 3_000,
  wallet: {
    maxAccounts: 1_000,
    maxTokens: 20,
    maxTokensNoKey: 8,
    priceLookupMax: 150,
    dustUsd: 1,
    deadlineMs: 15_000,
    accountsTimeoutMs: 10_000,
    lightFactsCacheTtlSeconds: 600,
    degradedLightFactsCacheTtlSeconds: 60,
    pairsCacheTtlSeconds: 300,
  },
  holderOwnersCacheTtlSeconds: 86_400,
  maxResponseBytes: 2_000_000,
  maxAttempts: 2,
  backoffBaseMs: 200,
  maxRetryAfterMs: 2_000,
  breakerThreshold: 5,
  breakerCooldownMs: 30_000,
  collectDeadlineMs: 8_000,
  sellTestAmountUsd: 100,
  sellSlippageBps: 500,
  signaturePageLimit: 1_000,
  maxSignaturePages: 3,
  lpRemovedMaxUsd: 100,
  creatorDeadMarketCapUsd: 5_000,
  creatorDeadMinAgeHours: 24,
  cacheTtlSeconds: { tokenAge: 86_400, creator: 3_600, rugcheck: 300 },
};

/** Fusion profonde (limites, TTL et scan de wallet) d'une configuration partielle. */
export function resolveSolanaDataConfig(
  partial: Partial<Omit<SolanaDataConfig, 'limits' | 'cacheTtlSeconds' | 'wallet'>> & {
    limits?: Partial<Record<UpstreamId, Partial<SourceLimits>>>;
    cacheTtlSeconds?: Partial<SolanaDataConfig['cacheTtlSeconds']>;
    wallet?: Partial<WalletScanConfig>;
  } = {},
): SolanaDataConfig {
  const base = DEFAULT_SOLANA_DATA_CONFIG;
  const limits = { ...base.limits };
  for (const [id, value] of Object.entries(partial.limits ?? {}) as Array<[UpstreamId, Partial<SourceLimits>]>) {
    limits[id] = { ...base.limits[id], ...value };
  }
  return {
    ...base,
    ...partial,
    limits,
    cacheTtlSeconds: { ...base.cacheTtlSeconds, ...partial.cacheTtlSeconds },
    wallet: { ...base.wallet, ...partial.wallet },
  };
}

export type SolanaDataConfigInput = Parameters<typeof resolveSolanaDataConfig>[0];

/** URL de base sûre : https, sans identifiants, query string ni fragment. */
const baseUrlSchema = z
  .string()
  .trim()
  .regex(/^https:\/\/[a-z0-9.-]+(?::\d{2,5})?(?:\/[A-Za-z0-9._~/-]*)?$/i, 'URL https sans query string attendue.')
  .transform((value) => value.replace(/\/+$/, ''));

const rateSchema = z.coerce.number().positive().max(1_000);

const envSchema = z.object({
  HELIUS_API_KEY: z.string().optional(),
  SOLANA_RPC_URL: baseUrlSchema.optional(),
  HELIUS_RPC_URL: baseUrlSchema.optional(),
  DEXSCREENER_API_URL: baseUrlSchema.optional(),
  GECKOTERMINAL_API_URL: baseUrlSchema.optional(),
  JUPITER_API_URL: baseUrlSchema.optional(),
  RUGCHECK_API_URL: baseUrlSchema.optional(),
  HELIUS_RPC_RPS: rateSchema.optional(),
  HELIUS_DAS_RPS: rateSchema.optional(),
  HELIUS_DAILY_CREDIT_BUDGET: z.coerce.number().int().min(0).optional(),
  WATCH_DAILY_CREDIT_BUDGET: z.coerce.number().int().min(0).optional(),
  WALLET_DAILY_CREDIT_BUDGET: z.coerce.number().int().min(0).optional(),
  WALLET_SCAN_MAX_ACCOUNTS: z.coerce.number().int().min(1).max(5_000).optional(),
  WALLET_SCAN_MAX_TOKENS: z.coerce.number().int().min(0).max(100).optional(),
  WALLET_SCAN_MAX_TOKENS_NO_KEY: z.coerce.number().int().min(0).max(100).optional(),
  WALLET_SCAN_PRICE_LOOKUP_MAX: z.coerce.number().int().min(0).max(1_000).optional(),
  WALLET_SCAN_DUST_USD: z.coerce.number().min(0).max(1_000_000).optional(),
  WALLET_SCAN_DEADLINE_MS: z.coerce.number().int().min(1_000).max(60_000).optional(),
  SOLANA_RPC_RPS: rateSchema.optional(),
});

/** Clé Helius exploitable : vide ou valeur factice de `.env.example` = absente. */
export function normaliseHeliusApiKey(raw: string | undefined | null): string | null {
  const value = (raw ?? '').trim();
  if (value === '' || /factice|changeme|example|placeholder/i.test(value)) return null;
  return /^[A-Za-z0-9-]{16,128}$/.test(value) ? value : null;
}

export interface LoadedSolanaDataConfig {
  readonly config: SolanaDataConfig;
  /** Clé Helius (jamais journalisée) ou `null` : RPC public 1 req/s, contrôles Helius « indisponible ». */
  readonly heliusApiKey: string | null;
}

/** Variables vides traitées comme absentes. */
function withoutEmpty(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== '') result[key] = value;
  }
  return result;
}

/**
 * Lit la configuration depuis l'environnement (docs/ENV.md). Une variable invalide lève une
 * erreur dont le message ne cite **que le nom** de la variable, jamais sa valeur.
 */
export function loadSolanaDataConfig(env: Readonly<Record<string, string | undefined>>): LoadedSolanaDataConfig {
  const parsed = envSchema.safeParse(withoutEmpty(env));
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))].join(', ');
    throw new Error(`Configuration Solana invalide : ${names}.`);
  }
  const e = parsed.data;
  const base = DEFAULT_SOLANA_DATA_CONFIG;
  const config = resolveSolanaDataConfig({
    publicRpcUrl: e.SOLANA_RPC_URL ?? base.publicRpcUrl,
    heliusRpcBaseUrl: e.HELIUS_RPC_URL ?? base.heliusRpcBaseUrl,
    dexscreenerBaseUrl: e.DEXSCREENER_API_URL ?? base.dexscreenerBaseUrl,
    geckoterminalBaseUrl: e.GECKOTERMINAL_API_URL ?? base.geckoterminalBaseUrl,
    jupiterBaseUrl: e.JUPITER_API_URL ?? base.jupiterBaseUrl,
    rugcheckBaseUrl: e.RUGCHECK_API_URL ?? base.rugcheckBaseUrl,
    heliusDailyCreditBudget: e.HELIUS_DAILY_CREDIT_BUDGET ?? base.heliusDailyCreditBudget,
    watchDailyCreditBudget: e.WATCH_DAILY_CREDIT_BUDGET ?? base.watchDailyCreditBudget,
    walletDailyCreditBudget: e.WALLET_DAILY_CREDIT_BUDGET ?? base.walletDailyCreditBudget,
    wallet: {
      maxAccounts: e.WALLET_SCAN_MAX_ACCOUNTS ?? base.wallet.maxAccounts,
      maxTokens: e.WALLET_SCAN_MAX_TOKENS ?? base.wallet.maxTokens,
      maxTokensNoKey: e.WALLET_SCAN_MAX_TOKENS_NO_KEY ?? base.wallet.maxTokensNoKey,
      priceLookupMax: e.WALLET_SCAN_PRICE_LOOKUP_MAX ?? base.wallet.priceLookupMax,
      dustUsd: e.WALLET_SCAN_DUST_USD ?? base.wallet.dustUsd,
      deadlineMs: e.WALLET_SCAN_DEADLINE_MS ?? base.wallet.deadlineMs,
    },
    limits: {
      helius_rpc: { ratePerSecond: e.HELIUS_RPC_RPS ?? base.limits.helius_rpc.ratePerSecond },
      helius_das: { ratePerSecond: e.HELIUS_DAS_RPS ?? base.limits.helius_das.ratePerSecond },
      solana_rpc: { ratePerSecond: e.SOLANA_RPC_RPS ?? base.limits.solana_rpc.ratePerSecond },
    },
  });
  return { config, heliusApiKey: normaliseHeliusApiKey(e.HELIUS_API_KEY) };
}
