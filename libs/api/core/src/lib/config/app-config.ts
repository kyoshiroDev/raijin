import { createECDH, randomBytes } from 'node:crypto';
import * as z from 'zod';
import { PUBLIC_PLAN_CATALOG } from '@raijin/shared-contracts';
import { parseDuration } from './duration';

/**
 * Défauts des prix et quotas publics : **une seule source**, le catalogue affiché par la landing
 * (`PUBLIC_PLAN_CATALOG`, docs/ARCHITECTURE.md §15.2). Une variable d'environnement peut s'en écarter ; en production,
 * l'écart est journalisé au démarrage (`catalogDriftWarnings`).
 */
const CATALOG = PUBLIC_PLAN_CATALOG;
/** Plafonds d'analyses du catalogue (`null` = illimité, refusé pour ces plans : repli sur 1). */
const CATALOG_FREE_ANALYSES = CATALOG.free.entitlements.analysesPerDay ?? 1;
const CATALOG_TRIAL_ANALYSES = CATALOG.trial.entitlements.analysesPerDay ?? 1;

/** Variables de `loadConfig` dont la valeur par défaut vient du catalogue public. */
export const CATALOG_DEFAULTS: Readonly<Record<string, number>> = {
  ANON_ANALYSIS_DAILY_LIMIT: CATALOG.anonAnalysesPerDay,
  FREE_ANALYSIS_DAILY_LIMIT: CATALOG_FREE_ANALYSES,
  TRIAL_ANALYSIS_DAILY_LIMIT: CATALOG_TRIAL_ANALYSES,
  FREE_WATCH_LIMIT: CATALOG.free.entitlements.maxActiveWatches,
  PRO_WATCH_LIMIT: CATALOG.pro.entitlements.maxActiveWatches,
  FREE_ALERT_HISTORY_DAYS: CATALOG.free.entitlements.alertHistoryDays,
  PRO_ALERT_HISTORY_DAYS: CATALOG.pro.entitlements.alertHistoryDays,
  WALLET_SCAN_DAILY_LIMIT_PRO: CATALOG.pro.entitlements.walletScansPerDay,
  WALLET_SCAN_DAILY_LIMIT_TRIAL: CATALOG.trial.entitlements.walletScansPerDay,
  TRIAL_DAYS: CATALOG.trial.days,
};

/**
 * Variables qui s'écartent du catalogue public (valeur effective ≠ défaut) : noms seulement, jamais la valeur.
 * Partagée avec `api-billing` (prix).
 */
export function catalogDriftWarnings(effective: Readonly<Record<string, number | string>>, defaults: Readonly<Record<string, number | string>>): string[] {
  return Object.keys(defaults)
    .filter((name) => effective[name] !== undefined && effective[name] !== defaults[name])
    .map((name) => `${name} diffère du catalogue public (PUBLIC_PLAN_CATALOG) : la landing affiche une autre valeur (à aligner, puis reconstruire API et landing).`);
}

/** Configuration typée de l'API, construite une seule fois au démarrage depuis `process.env`. */
export interface AppConfig {
  readonly env: 'development' | 'test' | 'production';
  readonly isProduction: boolean;
  readonly port: number;
  readonly appUrl: string;
  readonly landingUrl: string;
  readonly apiUrl: string;
  /** Origines autorisées (CORS et vérification `Origin` des mutations). */
  readonly allowedOrigins: readonly string[];
  readonly databaseUrl: string;
  /** `null` : pas de Redis (stockage mémoire du throttler, développement uniquement). */
  readonly redisUrl: string | null;
  /** Valeur de `trust proxy` d'Express (nombre de proxys de confiance), `false` si vide. */
  readonly trustProxy: number | false;
  /**
   * Secret partagé avec Traefik (`EDGE_SHARED_SECRET`) : si défini, toute requête sans en-tête `X-Raijin-Edge` valide
   * reçoit 403 (sauf santé) et `X-Forwarded-For` n'est pris en compte qu'avec cet en-tête
   * (docs/SECURITY.md §17). `null` : contrôle désactivé (local, tests, dev ; avertissement en production).
   */
  readonly edgeSharedSecret: string | null;
  readonly swaggerEnabled: boolean;
  readonly auth: {
    readonly accessSecret: string;
    readonly accessTtlMs: number;
    readonly refreshTtlMs: number;
    readonly cookieSecret: string;
    readonly cookieSecure: boolean;
    /**
     * Date limite d'acceptation de l'ancien refresh `__Secure-rj_rt` (migration vers `__Host-rj_rt`) ;
     * au-delà il est seulement effacé (`LEGACY_REFRESH_COOKIE_UNTIL`, ISO 8601 ; défaut : mise en service + JWT_REFRESH_TTL).
     */
    readonly legacyRefreshUntil: Date;
    /**
     * Domaine parent de l'hôte qui reçoit les cookies (ex. `raijinshield.com` pour `app.raijinshield.com`,
     * l'API étant servie sous `/api` de l'app), dérivé de APP_URL (jamais d'un en-tête) : sert uniquement à effacer un ancien refresh posé avec `Domain=`
     * par un sous-domaine. `null` en dev ou si l'hôte n'a pas de parent.
     */
    readonly cookieParentDomain: string | null;
    readonly emailVerifyTtlMs: number;
    readonly passwordResetTtlMs: number;
    readonly magicLinkTtlMs: number;
    /** Échecs de connexion consécutifs avant verrouillage temporaire. */
    readonly lockoutThreshold: number;
    readonly lockoutMs: number;
  };
  readonly rateLimit: {
    /** Requêtes par minute et par IP, toutes routes. */
    readonly perMinute: number;
    /** Requêtes par minute et par IP sur chaque route sensible de `/auth`. */
    readonly authPerMinute: number;
    /** Requêtes par minute et par IP sur `POST /analyses` (en plus du quota journalier). */
    readonly analysisPerMinute: number;
    /** Scans de wallet par minute et **par utilisateur** (`POST /wallet-scans`, en plus du quota journalier). */
    readonly walletScanPerMinute: number;
  };
  /** Analyse de token (phase 3, docs/ARCHITECTURE.md §9). */
  readonly analysis: {
    /** Clé HMAC de l'empreinte d'IP des visiteurs anonymes (l'IP n'est jamais stockée en clair). */
    readonly ipHashSecret: string;
    /** Analyses par jour (UTC) : visiteur anonyme, plan Gratuit, essai Pro. Pro : illimité. */
    readonly anonDailyLimit: number;
    readonly freeDailyLimit: number;
    readonly trialDailyLimit: number;
    /**
     * Analyses en échec par jour et par sujet (token inexistant…) remboursées sur le quota ; au-delà,
     * l'échec n'est plus remboursé et le sujet est refusé (429) jusqu'à minuit UTC : chaque échec
     * coûte des crédits Helius.
     */
    readonly failedDailyLimit: number;
    /** Pannes des sources (`UPSTREAM_UNAVAILABLE`) remboursées par jour et par sujet ; au-delà, consommées. */
    readonly upstreamFailedDailyLimit: number;
    /** Durée de cache d'un résultat (s) ; portée à `cacheTtlNoKeyS` sans clé Helius. */
    readonly cacheTtlS: number;
    readonly cacheTtlNoKeyS: number;
    /** `index.html` du build web servi pour `/t/:mint` (balises OG injectées) ; `null` : HTML minimal. */
    readonly webIndexHtmlPath: string | null;
    /** Dossier des polices WOFF de l'image OG ; `null` : recherche automatique. */
    readonly ogFontsDir: string | null;
    /** Sources simulées par des fixtures (tests e2e, démonstration) ; refusé en production. */
    readonly fixtures: boolean;
    /** Dossier des fixtures rejouées ; `null` : `libs/api/solana/src/fixtures` depuis le répertoire courant. */
    readonly fixturesDir: string | null;
  };
  /** Suivis et alertes (phase 4, docs/ARCHITECTURE.md §11). */
  readonly watch: {
    /** Suivis actifs autorisés : Gratuit, Pro (et essai). */
    readonly freeLimit: number;
    readonly proLimit: number;
    /** Historique des alertes affiché, en jours. */
    readonly freeAlertHistoryDays: number;
    readonly proAlertHistoryDays: number;
    /** Intervalles des passes, en minutes (rapide, holders, complète). */
    readonly fastIntervalMin: number;
    readonly holdersIntervalMin: number;
    readonly fullIntervalMin: number;
    /** Crédits Helius par jour réservés aux suivis (voie `watch`) et budget global de l'API. */
    readonly dailyCreditBudget: number;
    readonly heliusDailyCreditBudget: number;
    /** Une alerte du même type pour un mint au plus toutes les N minutes (sauf aggravation). */
    readonly alertCooldownMinutes: number;
    /** Regroupement des e-mails d'alerte (secondes) et plafond journalier par utilisateur. */
    readonly emailBatchDelayS: number;
    readonly emailDailyMax: number;
  };
  /** Scan de wallet (phase 5, docs/ARCHITECTURE.md §12). Aucune adresse n'est stockée en base. */
  readonly wallet: {
    /** Scans par jour (UTC) : Pro, essai Pro. Gratuit : aucun (403 `WALLET_SCAN_PLAN_REQUIRED`). */
    readonly dailyLimitPro: number;
    readonly dailyLimitTrial: number;
    /** Crédits Helius par jour réservés aux scans (voie `wallet`). */
    readonly dailyCreditBudget: number;
    /** Tokens analysés au plus par scan, avec et sans clé Helius. */
    readonly maxTokens: number;
    readonly maxTokensNoKey: number;
    /** Au-delà : 422 `WALLET_TOO_LARGE`. */
    readonly maxAccounts: number;
    /** Prix demandés à DexScreener au plus par scan. */
    readonly priceLookupMax: number;
    /** Valeur (USD, prix connu) sous laquelle un token est « poussière » (non analysé). */
    readonly dustUsd: number;
    /** Échéance globale d'un scan (ms). */
    readonly deadlineMs: number;
    /** Cache du résultat d'un wallet (s), avec et sans clé Helius ; 600 s au plus (RGPD). */
    readonly cacheTtlS: number;
    readonly cacheTtlNoKeyS: number;
    /** Cache du verdict rapide par mint (s). */
    readonly tokenVerdictTtlS: number;
    /** Âge maximal (s) d'une analyse complète réutilisée telle quelle. */
    readonly reuseAnalysisMaxAgeS: number;
  };
  /** Essai Pro sans carte (phase 6, docs/ARCHITECTURE.md §13). Droits de l'essai : `analysis.trialDailyLimit`, `wallet.dailyLimitTrial`, limites Pro des suivis. */
  readonly trial: {
    readonly days: number;
    /** Cron UTC du job `trial-tick` (file maintenance). */
    readonly jobCron: string;
    /** Heure de Paris (0-23) à partir de laquelle partent les e-mails J+1 et J-2. */
    readonly emailHour: number;
    readonly fingerprintRetentionDays: number;
    readonly claimRetentionDays: number;
    readonly conversionWindowDays: number;
  };
  /** Jobs BullMQ (réanalyses, envois, purges). */
  readonly jobs: {
    readonly enabled: boolean;
    readonly prefix: string;
    /** `POST internal/jobs/:name/run` (tests e2e) ; refusé en production. */
    readonly testTrigger: boolean;
    readonly tickSeconds: number;
    /** Cron UTC de la purge quotidienne. */
    readonly purgeCron: string;
    /** Rétention des analyses, alertes, événements… en jours. */
    readonly retentionDays: number;
  };
  /** Push web VAPID. `publicKey`/`privateKey` à `null` : push indisponible (`PUSH_NOT_SUPPORTED`). */
  readonly push: {
    readonly provider: 'webpush' | 'fake';
    readonly publicKey: string | null;
    readonly privateKey: string | null;
    readonly subject: string;
  };
  /** `MAINTENANCE_MODE=1` : toutes les routes sauf `health` répondent 503 `MAINTENANCE`. */
  readonly maintenance: boolean;
  readonly mail: {
    readonly provider: 'smtp' | 'resend';
    readonly from: string;
    readonly smtpHost: string;
    readonly smtpPort: number;
    readonly smtpUser: string | null;
    readonly smtpPassword: string | null;
    readonly resendApiKey: string | null;
    /** Logo PNG affiché en en-tête des e-mails (les clients mail bloquent le SVG). */
    readonly logoUrl: string;
    /** URL de base des images des e-mails (Rai en PNG 2x), sans `/` final. */
    readonly assetsBaseUrl: string;
  };
  /** Espace admin (phase 6 bis, docs/ARCHITECTURE.md §14) : 2FA, session admin, agrégats, alertes, audit. */
  readonly admin: {
    /** Clé AES-256-GCM des secrets TOTP (32 octets) ; éphémère en développement si absente. Jamais journalisée. */
    readonly totpEncryptionKey: Buffer;
    readonly totpIssuer: string;
    readonly totpMaxAttempts: number;
    readonly totpLockoutMs: number;
    /** Session admin : inactivité maximale et durée absolue après la saisie du code. */
    readonly sessionIdleMs: number;
    readonly sessionMaxMs: number;
    /** Throttler `admin` : requêtes par minute et par utilisateur sur `admin/*`. */
    readonly perMinute: number;
    readonly metricsCron: string;
    readonly alertsCron: string;
    readonly alertJobFailures: number;
    readonly alertQuotaRatio: number;
    readonly auditLogRetentionDays: number;
    /** Plafonds d'appels journaliers (ratio des alertes de quota) ; `null` = sans plafond. */
    readonly jupiterDailyCallBudget: number | null;
    readonly rugcheckDailyCallBudget: number | null;
  };
  /** Lecture GA4 / Search Console (docs/ARCHITECTURE.md §14.6). `none` : « Non connecté ». */
  readonly analytics: {
    readonly provider: 'google' | 'fake' | 'none';
    readonly ga4PropertyId: string | null;
    readonly searchConsoleSiteUrl: string | null;
    /** JSON du compte de service (brut ou base64), jamais journalisé ; `null` si absent. */
    readonly serviceAccountJson: string | null;
    readonly cacheTtlS: number;
  };
  /** Services externes configurés ou non (jamais la valeur) : écran Santé de l'admin (`GET admin/health`). */
  readonly services: Readonly<Record<string, boolean>>;
}

/** Valeurs factices de `.env.example` : traitées comme absentes. */
const PLACEHOLDER = /changeme|factice|^re_factice$|^sk_test_factice$|^whsec_factice$|^pk_test_factice$/i;

/**
 * Variables vides (`NOM=` ou espaces seuls, cas de `.env.example`) traitées comme **absentes** : la valeur par défaut
 * s'applique. Sans cela, `z.coerce.number()` convertit `''` en `0` (« Too small ») et un booléen ou une liste vide
 * ne retombe pas sur son défaut. Appliqué à tous les chargeurs de configuration de l'API.
 */
export function withoutEmptyEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== '') result[key] = value;
  }
  return result;
}

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined));

const urlString = z.url({ protocol: /^https?$/ });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  APP_URL: urlString.default('http://localhost:4200'),
  LANDING_URL: urlString.default('http://localhost:4321'),
  API_URL: urlString.default('http://localhost:3100'),
  CORS_ORIGINS: optionalString,
  DATABASE_URL: optionalString,
  REDIS_URL: optionalString,
  TRUST_PROXY: optionalString,
  EDGE_SHARED_SECRET: optionalString,
  JWT_ACCESS_SECRET: optionalString,
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  COOKIE_SECRET: optionalString,
  COOKIE_SECURE: optionalString,
  LEGACY_REFRESH_COOKIE_UNTIL: optionalString,
  EMAIL_VERIFY_TTL: z.string().default('24h'),
  PASSWORD_RESET_TTL: z.string().default('30m'),
  MAGIC_LINK_TTL: z.string().default('15m'),
  AUTH_LOCKOUT_THRESHOLD: z.coerce.number().int().min(3).max(50).default(5),
  AUTH_LOCKOUT_DURATION: z.string().default('15m'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().min(1).optional(),
  RATE_LIMIT_ANALYSIS_PER_MINUTE: z.coerce.number().int().min(1).optional(),
  RATE_LIMIT_WALLET_SCAN_PER_MINUTE: z.coerce.number().int().min(1).max(600).optional(),
  IP_HASH_SECRET: optionalString,
  ANON_ANALYSIS_DAILY_LIMIT: z.coerce.number().int().min(1).max(10_000).default(CATALOG.anonAnalysesPerDay),
  FREE_ANALYSIS_DAILY_LIMIT: z.coerce.number().int().min(1).max(10_000).default(CATALOG_FREE_ANALYSES),
  TRIAL_ANALYSIS_DAILY_LIMIT: z.coerce.number().int().min(1).max(10_000).default(CATALOG_TRIAL_ANALYSES),
  ANALYSIS_FAILED_DAILY_LIMIT: z.coerce.number().int().min(1).max(10_000).default(20),
  ANALYSIS_UPSTREAM_FAILED_DAILY_LIMIT: z.coerce.number().int().min(0).max(10_000).default(10),
  ANALYSIS_CACHE_TTL_S: z.coerce.number().int().min(5).max(3_600).default(60),
  ANALYSIS_CACHE_TTL_NO_KEY_S: z.coerce.number().int().min(5).max(3_600).default(300),
  WEB_INDEX_HTML_PATH: optionalString,
  OG_FONTS_DIR: optionalString,
  ANALYSIS_FIXTURES: optionalString,
  ANALYSIS_FIXTURES_DIR: optionalString,
  MAIL_PROVIDER: z.enum(['smtp', 'resend']).default('smtp'),
  MAIL_FROM: z.string().trim().min(3).default('Raijin <noreply@raijinshield.com>'),
  SMTP_HOST: z.string().trim().min(1).default('localhost'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1026),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  RESEND_API_KEY: optionalString,
  MAIL_LOGO_URL: optionalString,
  MAIL_ASSETS_BASE_URL: optionalString,
  // Suivis, alertes et jobs (docs/ENV.md, docs/ARCHITECTURE.md §11).
  JOBS_ENABLED: optionalString,
  BULLMQ_PREFIX: z.string().trim().regex(/^[a-z0-9-]{1,32}$/).default('raijin'),
  JOBS_TEST_TRIGGER: optionalString,
  FREE_WATCH_LIMIT: z.coerce.number().int().min(0).max(1_000).default(CATALOG.free.entitlements.maxActiveWatches),
  PRO_WATCH_LIMIT: z.coerce.number().int().min(1).max(1_000).default(CATALOG.pro.entitlements.maxActiveWatches),
  FREE_ALERT_HISTORY_DAYS: z.coerce.number().int().min(1).max(366).default(CATALOG.free.entitlements.alertHistoryDays),
  PRO_ALERT_HISTORY_DAYS: z.coerce.number().int().min(1).max(366).default(CATALOG.pro.entitlements.alertHistoryDays),
  WATCH_TICK_SECONDS: z.coerce.number().int().min(5).max(3_600).default(60),
  WATCH_FAST_INTERVAL_MIN: z.coerce.number().int().min(1).max(1_440).default(5),
  WATCH_HOLDERS_INTERVAL_MIN: z.coerce.number().int().min(1).max(10_080).default(30),
  WATCH_FULL_INTERVAL_MIN: z.coerce.number().int().min(5).max(10_080).default(360),
  WATCH_DAILY_CREDIT_BUDGET: z.coerce.number().int().min(0).max(10_000_000).default(12_000),
  HELIUS_DAILY_CREDIT_BUDGET: z.coerce.number().int().min(0).max(10_000_000).default(22_000),
  // Scan de wallet (docs/ENV.md, docs/ARCHITECTURE.md §12).
  WALLET_SCAN_DAILY_LIMIT_PRO: z.coerce.number().int().min(1).max(10_000).default(CATALOG.pro.entitlements.walletScansPerDay),
  WALLET_SCAN_DAILY_LIMIT_TRIAL: z.coerce.number().int().min(1).max(10_000).default(CATALOG.trial.entitlements.walletScansPerDay),
  WALLET_DAILY_CREDIT_BUDGET: z.coerce.number().int().min(0).max(10_000_000).default(3_000),
  WALLET_SCAN_MAX_TOKENS: z.coerce.number().int().min(1).max(100).default(20),
  WALLET_SCAN_MAX_TOKENS_NO_KEY: z.coerce.number().int().min(1).max(100).default(8),
  WALLET_SCAN_MAX_ACCOUNTS: z.coerce.number().int().min(1).max(10_000).default(1_000),
  WALLET_SCAN_PRICE_LOOKUP_MAX: z.coerce.number().int().min(0).max(1_000).default(150),
  WALLET_SCAN_DUST_USD: z.coerce.number().min(0).max(1_000_000).default(1),
  WALLET_SCAN_DEADLINE_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  WALLET_SCAN_CACHE_TTL_S: z.coerce.number().int().min(5).max(600).default(120),
  WALLET_SCAN_CACHE_TTL_NO_KEY_S: z.coerce.number().int().min(5).max(600).default(600),
  WALLET_TOKEN_VERDICT_TTL_S: z.coerce.number().int().min(5).max(86_400).default(3_600),
  WALLET_REUSE_ANALYSIS_MAX_AGE_S: z.coerce.number().int().min(0).max(86_400).default(3_600),
  ALERT_COOLDOWN_MINUTES: z.coerce.number().int().min(0).max(10_080).default(360),
  ALERT_EMAIL_BATCH_DELAY_S: z.coerce.number().int().min(0).max(3_600).default(120),
  ALERT_EMAIL_DAILY_MAX: z.coerce.number().int().min(0).max(500).default(20),
  RETENTION_DAYS: z.coerce.number().int().min(7).max(3_650).default(90),
  TRIAL_DAYS: z.coerce.number().int().min(1).max(30).default(CATALOG.trial.days),
  TRIAL_JOB_CRON: z
    .string()
    .trim()
    .regex(/^(?:[0-9*/,-]+\s+){4}[0-9*/,-]+$/, { message: 'cron à 5 champs attendu (ex. 5 * * * *)' })
    .default('5 * * * *'),
  TRIAL_EMAIL_HOUR: z.coerce.number().int().min(0).max(23).default(10),
  TRIAL_FINGERPRINT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3_650).default(90),
  TRIAL_CLAIM_RETENTION_DAYS: z.coerce.number().int().min(30).max(3_650).default(730),
  TRIAL_CONVERSION_WINDOW_DAYS: z.coerce.number().int().min(0).max(365).default(30),
  PURGE_CRON: z
    .string()
    .trim()
    .regex(/^(?:[0-9*/,-]+\s+){4}[0-9*/,-]+$/, { message: 'cron à 5 champs attendu (ex. 30 3 * * *)' })
    .default('30 3 * * *'),
  VAPID_PUBLIC_KEY: optionalString,
  VAPID_SUBJECT: z
    .string()
    .trim()
    .regex(/^(?:mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/, { message: 'mailto: ou https: attendu' })
    .default('mailto:support@raijinshield.com'),
  PUSH_PROVIDER: z.enum(['webpush', 'fake']).default('webpush'),
  MAINTENANCE_MODE: optionalString,
  // Espace admin (docs/ENV.md « Espace admin », docs/ARCHITECTURE.md §14).
  TOTP_ENCRYPTION_KEY: optionalString,
  ADMIN_SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).max(240).default(30),
  ADMIN_SESSION_MAX_HOURS: z.coerce.number().int().min(1).max(24).default(8),
  ADMIN_TOTP_ISSUER: z.string().trim().min(1).max(64).regex(/^[^:]+$/, { message: 'sans « : »' }).default('Raijin Shield'),
  ADMIN_TOTP_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
  ADMIN_TOTP_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1_440).default(15),
  RATE_LIMIT_ADMIN_PER_MINUTE: z.coerce.number().int().min(10).max(10_000).default(120),
  METRICS_CRON: z
    .string()
    .trim()
    .regex(/^(?:[0-9*/,-]+\s+){4}[0-9*/,-]+$/, { message: 'cron à 5 champs attendu (ex. 15 2 * * *)' })
    .default('15 2 * * *'),
  ADMIN_ALERTS_CRON: z
    .string()
    .trim()
    .regex(/^(?:[0-9*/,-]+\s+){4}[0-9*/,-]+$/, { message: 'cron à 5 champs attendu (ex. */10 * * * *)' })
    .default('*/10 * * * *'),
  ADMIN_ALERT_JOB_FAILURES: z.coerce.number().int().min(1).max(50).default(3),
  ADMIN_ALERT_QUOTA_RATIO: z.coerce.number().min(0.1).max(1).default(0.8),
  AUDIT_LOG_RETENTION_DAYS: z.coerce.number().int().min(30).max(3_650).default(365),
  JUPITER_DAILY_CALL_BUDGET: z.coerce.number().int().min(1).max(100_000_000).optional().or(z.literal('').transform(() => undefined)),
  RUGCHECK_DAILY_CALL_BUDGET: z.coerce.number().int().min(1).max(100_000_000).optional().or(z.literal('').transform(() => undefined)),
  ANALYTICS_PROVIDER: z.enum(['google', 'fake', '']).optional(),
  ANALYTICS_CACHE_TTL_S: z.coerce.number().int().min(60).max(86_400).default(3_600),
  GA4_PROPERTY_ID: z.string().trim().regex(/^\d{1,20}$/, { message: 'identifiant numérique attendu' }).optional().or(z.literal('').transform(() => undefined)),
  SEARCH_CONSOLE_SITE_URL: z
    .string()
    .trim()
    .regex(/^(?:sc-domain:[a-z0-9.-]{1,253}|https:\/\/[^\s]{1,253})$/, { message: 'sc-domain:… ou https://… attendu' })
    .optional()
    .or(z.literal('').transform(() => undefined)),
  // Services consultés seulement pour l'écran Santé de l'admin (présence, jamais la valeur).
  HELIUS_API_KEY: optionalString,
  STRIPE_SECRET_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,
  VAPID_PRIVATE_KEY: optionalString,
  GA4_MEASUREMENT_ID: optionalString,
  GOOGLE_SERVICE_ACCOUNT_JSON: optionalString,
  SENTRY_DSN_API: optionalString,
});

export class ConfigError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`Configuration invalide :\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

/** Clé VAPID : base64url (publique 65 octets ≈ 87 caractères, privée 32 octets ≈ 43). */
const VAPID_PUBLIC_PATTERN = /^[A-Za-z0-9_-]{86,88}$/;
const VAPID_PRIVATE_PATTERN = /^[A-Za-z0-9_-]{42,44}$/;

/** Paire VAPID P-256 (format de `web-push generate-vapid-keys`) : développement seulement. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url') };
}

const DEV_DATABASE_URL = 'postgresql://raijin:changeme-factice@localhost:5433/raijin?schema=public';
const DEV_REDIS_URL = 'redis://localhost:6380';
const MIN_SECRET_LENGTH = 32;

function isReal(value: string | undefined): value is string {
  return !!value && !PLACEHOLDER.test(value);
}

/** URL Redis valide (schéma, hôte, port facultatif), identifiants compris. */
export function isRedisUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'redis:' || url.protocol === 'rediss:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/** Mise en service du refresh `__Host-rj_rt` : point de départ de la fenêtre de migration par défaut. */
export const LEGACY_REFRESH_MIGRATION_START = new Date('2026-11-26T00:00:00Z');

/** Domaine parent d'un hôte (`app.raijinshield.com` → `raijinshield.com`) ; `null` pour localhost, une IP ou un domaine nu. */
export function parentDomainOf(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (/^[\d.]+$/.test(host) || host.includes(':')) return null;
  const labels = host.split('.').filter(Boolean);
  return labels.length >= 3 ? labels.slice(1).join('.') : null;
}

function originOf(url: string): string {
  return new URL(url).origin;
}

/**
 * Valide les variables d'environnement et construit la configuration.
 * - Production : toute variable sensible absente, factice ou trop courte fait échouer le démarrage.
 * - Développement / test : valeurs de repli sûres et non secrètes ; les secrets absents sont générés
 *   aléatoirement à chaque démarrage (sessions perdues au redémarrage), avec un avertissement.
 * Aucune valeur secrète n'est jamais incluse dans les messages d'erreur ou d'avertissement.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = () => undefined,
): AppConfig {
  const parsed = envSchema.safeParse(withoutEmptyEnv(env));
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'} : ${issue.message}`),
    );
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';
  const problems: string[] = [];

  const secret = (name: 'JWT_ACCESS_SECRET' | 'COOKIE_SECRET' | 'IP_HASH_SECRET'): string => {
    const value = e[name];
    if (isReal(value) && value.length >= MIN_SECRET_LENGTH) return value;
    if (isProduction) {
      problems.push(`${name} : absente, factice ou plus courte que ${MIN_SECRET_LENGTH} caractères`);
      return '';
    }
    warn(`${name} absente ou factice : secret aléatoire généré pour ce démarrage (développement seulement).`);
    return randomBytes(48).toString('base64url');
  };

  const duration = (name: string, raw: string): number => {
    const ms = parseDuration(raw);
    if (ms === null) problems.push(`${name} : durée invalide (exemples : 15m, 24h, 30d)`);
    return ms ?? 1;
  };

  let databaseUrl = e.DATABASE_URL;
  if (!databaseUrl) {
    if (isProduction) problems.push('DATABASE_URL : obligatoire en production');
    databaseUrl = DEV_DATABASE_URL;
  }

  let redisUrl: string | null = e.REDIS_URL ?? null;
  // URL redis:// ou rediss://, mot de passe accepté (`redis://:<hex>@raijin-redis:6379`) ; jamais citée dans l'erreur.
  if (redisUrl && !isRedisUrl(redisUrl)) {
    problems.push('REDIS_URL : URL redis:// ou rediss:// attendue (ex. redis://:mot-de-passe@raijin-redis:6379)');
    redisUrl = null;
  }
  if (!redisUrl) {
    if (isProduction) problems.push('REDIS_URL : obligatoire en production (rate limiting partagé)');
    redisUrl = e.NODE_ENV === 'development' ? DEV_REDIS_URL : null;
  }

  let trustProxy: number | false = false;
  if (!e.TRUST_PROXY && isProduction) {
    // Sans valeur explicite, Express verrait l'IP de Traefik : rate limiting et verrouillage
    // s'appliqueraient à tous les visiteurs à la fois (ou, mal réglé, l'IP serait falsifiable).
    problems.push('TRUST_PROXY : obligatoire en production (1 derrière Traefik, 0 si l’API est exposée directement)');
  }
  if (e.TRUST_PROXY) {
    const hops = Number(e.TRUST_PROXY);
    if (Number.isInteger(hops) && hops >= 0 && hops <= 10) trustProxy = hops === 0 ? false : hops;
    else problems.push('TRUST_PROXY : nombre de proxys de confiance attendu (0 à 10)');
  }

  // En-tête secret posé par Traefik (docs/SECURITY.md §17). Absente ou factice : contrôle désactivé ; en production,
  // le démarrage reste autorisé (ne casse pas un déploiement existant) mais un avertissement est journalisé.
  let edgeSharedSecret: string | null = null;
  if (isReal(e.EDGE_SHARED_SECRET)) {
    if (e.EDGE_SHARED_SECRET.length < MIN_SECRET_LENGTH || e.EDGE_SHARED_SECRET.length > 256 || !/^[\x21-\x7e]+$/.test(e.EDGE_SHARED_SECRET)) {
      problems.push(`EDGE_SHARED_SECRET : ${MIN_SECRET_LENGTH} à 256 caractères ASCII imprimables sans espace attendus (ex. openssl rand -hex 32)`);
    } else {
      edgeSharedSecret = e.EDGE_SHARED_SECRET;
    }
  } else if (isProduction) {
    warn('EDGE_SHARED_SECRET absente : en-tête X-Raijin-Edge non exigé, X-Forwarded-For accepté de tout appelant du réseau Docker (docs/SECURITY.md §17).');
  }

  const cookieSecure = parseBoolean(e.COOKIE_SECURE, isProduction);
  let legacyRefreshUntil = new Date(
    LEGACY_REFRESH_MIGRATION_START.getTime() + duration('JWT_REFRESH_TTL', e.JWT_REFRESH_TTL),
  );
  if (e.LEGACY_REFRESH_COOKIE_UNTIL) {
    const parsed = new Date(e.LEGACY_REFRESH_COOKIE_UNTIL);
    if (Number.isNaN(parsed.getTime())) problems.push('LEGACY_REFRESH_COOKIE_UNTIL : date ISO 8601 attendue');
    else legacyRefreshUntil = parsed;
  }
  if (isProduction && !cookieSecure) problems.push('COOKIE_SECURE : doit valoir true en production');

  const extraOrigins = (e.CORS_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const allowedOrigins: string[] = [];
  for (const candidate of [e.APP_URL, e.LANDING_URL, ...extraOrigins]) {
    const parsedOrigin = urlString.safeParse(candidate);
    if (!parsedOrigin.success) {
      problems.push(`CORS_ORIGINS : origine invalide « ${candidate.slice(0, 80)} »`);
      continue;
    }
    const origin = originOf(parsedOrigin.data);
    if (isProduction && !origin.startsWith('https://')) {
      problems.push(`CORS_ORIGINS : origine non HTTPS refusée en production (${origin})`);
    }
    if (!allowedOrigins.includes(origin)) allowedOrigins.push(origin);
  }

  const resendApiKey = isReal(e.RESEND_API_KEY) ? e.RESEND_API_KEY : null;
  let provider = e.MAIL_PROVIDER;
  if (provider === 'resend' && !resendApiKey) {
    if (isProduction) problems.push('RESEND_API_KEY : obligatoire quand MAIL_PROVIDER=resend');
    else warn('MAIL_PROVIDER=resend sans RESEND_API_KEY réelle : envoi via SMTP (Mailpit).');
    provider = 'smtp';
  }

  const analysisFixtures = parseBoolean(e.ANALYSIS_FIXTURES, false);
  if (isProduction && analysisFixtures) {
    problems.push('ANALYSIS_FIXTURES : interdit en production (sources simulées)');
  }

  const jobsTestTrigger = parseBoolean(e.JOBS_TEST_TRIGGER, false);
  if (isProduction && jobsTestTrigger) problems.push('JOBS_TEST_TRIGGER : interdit en production (déclenchement manuel des jobs)');
  if (isProduction && e.PUSH_PROVIDER === 'fake') problems.push('PUSH_PROVIDER : fake interdit en production');
  if (e.WATCH_DAILY_CREDIT_BUDGET > e.HELIUS_DAILY_CREDIT_BUDGET) {
    problems.push('WATCH_DAILY_CREDIT_BUDGET : ne doit pas dépasser HELIUS_DAILY_CREDIT_BUDGET');
  } else if (e.WATCH_DAILY_CREDIT_BUDGET + e.WALLET_DAILY_CREDIT_BUDGET > e.HELIUS_DAILY_CREDIT_BUDGET) {
    problems.push('WATCH_DAILY_CREDIT_BUDGET + WALLET_DAILY_CREDIT_BUDGET : ne doit pas dépasser HELIUS_DAILY_CREDIT_BUDGET');
  }

  // VAPID : les deux clés ou aucune. Sans clés : push indisponible en production ; paire
  // éphémère générée en développement (abonnements perdus au redémarrage), jamais affichée.
  let vapidPublic = isReal(e.VAPID_PUBLIC_KEY) ? e.VAPID_PUBLIC_KEY : null;
  let vapidPrivate = isReal(e.VAPID_PRIVATE_KEY) ? e.VAPID_PRIVATE_KEY : null;
  if ((vapidPublic === null) !== (vapidPrivate === null)) {
    problems.push('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY : fournir les deux clés ou aucune');
    vapidPublic = null;
    vapidPrivate = null;
  } else if (vapidPublic && vapidPrivate) {
    if (!VAPID_PUBLIC_PATTERN.test(vapidPublic)) problems.push('VAPID_PUBLIC_KEY : clé base64url P-256 attendue');
    if (!VAPID_PRIVATE_PATTERN.test(vapidPrivate)) problems.push('VAPID_PRIVATE_KEY : clé base64url P-256 attendue');
  } else if (!isProduction) {
    const pair = generateVapidKeys();
    vapidPublic = pair.publicKey;
    vapidPrivate = pair.privateKey;
    warn('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY absentes : paire VAPID éphémère générée pour ce démarrage (développement seulement).');
  } else {
    warn('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY absentes : notifications push indisponibles (alertes par e-mail seulement).');
  }

  // Clé TOTP : 32 octets en base64. Obligatoire en production ; éphémère en développement (2FA à refaire).
  let totpEncryptionKey: Buffer;
  const rawTotpKey = isReal(e.TOTP_ENCRYPTION_KEY) ? e.TOTP_ENCRYPTION_KEY : undefined;
  const decodedTotpKey = rawTotpKey && /^[A-Za-z0-9+/_-]+={0,2}$/.test(rawTotpKey) ? Buffer.from(rawTotpKey, 'base64') : null;
  if (decodedTotpKey && decodedTotpKey.length === 32) {
    totpEncryptionKey = decodedTotpKey;
  } else {
    if (isProduction) problems.push('TOTP_ENCRYPTION_KEY : absente, factice ou ne décode pas 32 octets (openssl rand -base64 32)');
    else if (rawTotpKey) problems.push('TOTP_ENCRYPTION_KEY : 32 octets en base64 attendus (openssl rand -base64 32)');
    else warn('TOTP_ENCRYPTION_KEY absente ou factice : clé TOTP éphémère générée pour ce démarrage (développement seulement).');
    totpEncryptionKey = randomBytes(32);
  }

  const serviceAccountJson = isReal(e.GOOGLE_SERVICE_ACCOUNT_JSON) ? e.GOOGLE_SERVICE_ACCOUNT_JSON : null;
  if (isProduction && e.ANALYTICS_PROVIDER === 'fake') problems.push('ANALYTICS_PROVIDER : fake interdit en production (données simulées)');
  // Vide = google si le JSON est fourni, sinon « Non connecté » ; google sans JSON = « Non connecté ».
  const analyticsProvider: 'google' | 'fake' | 'none' = e.ANALYTICS_PROVIDER === 'fake' ? 'fake' : serviceAccountJson ? 'google' : 'none';

  // Landing désalignée : avertissement en production seulement (le démarrage n'est jamais refusé pour ça).
  if (isProduction) {
    for (const message of catalogDriftWarnings(e as unknown as Record<string, number>, CATALOG_DEFAULTS)) warn(message);
  }

  const config: AppConfig = {
    env: e.NODE_ENV,
    isProduction,
    port: e.API_PORT,
    appUrl: originOf(e.APP_URL),
    landingUrl: originOf(e.LANDING_URL),
    apiUrl: originOf(e.API_URL),
    allowedOrigins,
    databaseUrl,
    redisUrl,
    trustProxy,
    edgeSharedSecret,
    swaggerEnabled: !isProduction,
    auth: {
      accessSecret: secret('JWT_ACCESS_SECRET'),
      accessTtlMs: duration('JWT_ACCESS_TTL', e.JWT_ACCESS_TTL),
      refreshTtlMs: duration('JWT_REFRESH_TTL', e.JWT_REFRESH_TTL),
      cookieSecret: secret('COOKIE_SECRET'),
      cookieSecure,
      legacyRefreshUntil,
      cookieParentDomain: cookieSecure ? parentDomainOf(e.APP_URL) : null,
      emailVerifyTtlMs: duration('EMAIL_VERIFY_TTL', e.EMAIL_VERIFY_TTL),
      passwordResetTtlMs: duration('PASSWORD_RESET_TTL', e.PASSWORD_RESET_TTL),
      magicLinkTtlMs: duration('MAGIC_LINK_TTL', e.MAGIC_LINK_TTL),
      lockoutThreshold: e.AUTH_LOCKOUT_THRESHOLD,
      lockoutMs: duration('AUTH_LOCKOUT_DURATION', e.AUTH_LOCKOUT_DURATION),
    },
    rateLimit: {
      perMinute: e.RATE_LIMIT_PER_MINUTE,
      // 10 par défaut en production ; 60 en dev/test (parcours e2e et essais manuels répétés).
      authPerMinute: e.RATE_LIMIT_AUTH_PER_MINUTE ?? (isProduction ? 10 : 60),
      analysisPerMinute: e.RATE_LIMIT_ANALYSIS_PER_MINUTE ?? (isProduction ? 10 : 60),
      // 5 par utilisateur en production (docs/ARCHITECTURE.md §12.2) ; 60 en dev/test (parcours e2e).
      walletScanPerMinute: e.RATE_LIMIT_WALLET_SCAN_PER_MINUTE ?? (isProduction ? 5 : 60),
    },
    analysis: {
      ipHashSecret: secret('IP_HASH_SECRET'),
      anonDailyLimit: e.ANON_ANALYSIS_DAILY_LIMIT,
      freeDailyLimit: e.FREE_ANALYSIS_DAILY_LIMIT,
      trialDailyLimit: e.TRIAL_ANALYSIS_DAILY_LIMIT,
      failedDailyLimit: e.ANALYSIS_FAILED_DAILY_LIMIT,
      upstreamFailedDailyLimit: e.ANALYSIS_UPSTREAM_FAILED_DAILY_LIMIT,
      cacheTtlS: e.ANALYSIS_CACHE_TTL_S,
      cacheTtlNoKeyS: e.ANALYSIS_CACHE_TTL_NO_KEY_S,
      webIndexHtmlPath: e.WEB_INDEX_HTML_PATH ?? null,
      ogFontsDir: e.OG_FONTS_DIR ?? null,
      fixtures: analysisFixtures,
      fixturesDir: e.ANALYSIS_FIXTURES_DIR ?? null,
    },
    mail: {
      provider,
      from: e.MAIL_FROM,
      smtpHost: e.SMTP_HOST,
      smtpPort: e.SMTP_PORT,
      smtpUser: e.SMTP_USER ?? null,
      smtpPassword: e.SMTP_PASSWORD ?? null,
      resendApiKey,
      logoUrl: e.MAIL_LOGO_URL ?? `${originOf(e.APP_URL)}/icons/icon-192.png`,
      assetsBaseUrl: (e.MAIL_ASSETS_BASE_URL ?? `${originOf(e.APP_URL)}/email`).replace(/\/+$/, ''),
    },
    watch: {
      freeLimit: e.FREE_WATCH_LIMIT,
      proLimit: e.PRO_WATCH_LIMIT,
      freeAlertHistoryDays: e.FREE_ALERT_HISTORY_DAYS,
      proAlertHistoryDays: e.PRO_ALERT_HISTORY_DAYS,
      fastIntervalMin: e.WATCH_FAST_INTERVAL_MIN,
      holdersIntervalMin: e.WATCH_HOLDERS_INTERVAL_MIN,
      fullIntervalMin: e.WATCH_FULL_INTERVAL_MIN,
      dailyCreditBudget: e.WATCH_DAILY_CREDIT_BUDGET,
      heliusDailyCreditBudget: e.HELIUS_DAILY_CREDIT_BUDGET,
      alertCooldownMinutes: e.ALERT_COOLDOWN_MINUTES,
      emailBatchDelayS: e.ALERT_EMAIL_BATCH_DELAY_S,
      emailDailyMax: e.ALERT_EMAIL_DAILY_MAX,
    },
    wallet: {
      dailyLimitPro: e.WALLET_SCAN_DAILY_LIMIT_PRO,
      dailyLimitTrial: e.WALLET_SCAN_DAILY_LIMIT_TRIAL,
      dailyCreditBudget: e.WALLET_DAILY_CREDIT_BUDGET,
      maxTokens: e.WALLET_SCAN_MAX_TOKENS,
      maxTokensNoKey: e.WALLET_SCAN_MAX_TOKENS_NO_KEY,
      maxAccounts: e.WALLET_SCAN_MAX_ACCOUNTS,
      priceLookupMax: e.WALLET_SCAN_PRICE_LOOKUP_MAX,
      dustUsd: e.WALLET_SCAN_DUST_USD,
      deadlineMs: e.WALLET_SCAN_DEADLINE_MS,
      cacheTtlS: e.WALLET_SCAN_CACHE_TTL_S,
      cacheTtlNoKeyS: e.WALLET_SCAN_CACHE_TTL_NO_KEY_S,
      tokenVerdictTtlS: e.WALLET_TOKEN_VERDICT_TTL_S,
      reuseAnalysisMaxAgeS: e.WALLET_REUSE_ANALYSIS_MAX_AGE_S,
    },
    trial: {
      days: e.TRIAL_DAYS,
      jobCron: e.TRIAL_JOB_CRON,
      emailHour: e.TRIAL_EMAIL_HOUR,
      fingerprintRetentionDays: e.TRIAL_FINGERPRINT_RETENTION_DAYS,
      claimRetentionDays: e.TRIAL_CLAIM_RETENTION_DAYS,
      conversionWindowDays: e.TRIAL_CONVERSION_WINDOW_DAYS,
    },
    jobs: {
      // Désactivés par défaut en test (services testés sans Redis), actifs sinon.
      enabled: parseBoolean(e.JOBS_ENABLED, e.NODE_ENV !== 'test'),
      prefix: e.BULLMQ_PREFIX,
      testTrigger: jobsTestTrigger,
      tickSeconds: e.WATCH_TICK_SECONDS,
      purgeCron: e.PURGE_CRON,
      retentionDays: e.RETENTION_DAYS,
    },
    push: {
      provider: e.PUSH_PROVIDER,
      publicKey: vapidPublic,
      privateKey: vapidPrivate,
      subject: e.VAPID_SUBJECT,
    },
    maintenance: parseBoolean(e.MAINTENANCE_MODE, false),
    admin: {
      totpEncryptionKey,
      totpIssuer: e.ADMIN_TOTP_ISSUER,
      totpMaxAttempts: e.ADMIN_TOTP_MAX_ATTEMPTS,
      totpLockoutMs: e.ADMIN_TOTP_LOCKOUT_MINUTES * 60_000,
      sessionIdleMs: e.ADMIN_SESSION_IDLE_MINUTES * 60_000,
      sessionMaxMs: e.ADMIN_SESSION_MAX_HOURS * 3_600_000,
      perMinute: e.RATE_LIMIT_ADMIN_PER_MINUTE,
      metricsCron: e.METRICS_CRON,
      alertsCron: e.ADMIN_ALERTS_CRON,
      alertJobFailures: e.ADMIN_ALERT_JOB_FAILURES,
      alertQuotaRatio: e.ADMIN_ALERT_QUOTA_RATIO,
      auditLogRetentionDays: e.AUDIT_LOG_RETENTION_DAYS,
      jupiterDailyCallBudget: e.JUPITER_DAILY_CALL_BUDGET ?? null,
      rugcheckDailyCallBudget: e.RUGCHECK_DAILY_CALL_BUDGET ?? null,
    },
    analytics: {
      provider: analyticsProvider,
      ga4PropertyId: e.GA4_PROPERTY_ID ?? null,
      searchConsoleSiteUrl: e.SEARCH_CONSOLE_SITE_URL ?? null,
      serviceAccountJson,
      cacheTtlS: e.ANALYTICS_CACHE_TTL_S,
    },
    services: {
      database: !!databaseUrl,
      redis: redisUrl !== null,
      helius: isReal(e.HELIUS_API_KEY),
      resend: !!resendApiKey,
      smtp: provider === 'smtp',
      stripe: isReal(e.STRIPE_SECRET_KEY) && isReal(e.STRIPE_WEBHOOK_SECRET),
      vapid: isReal(e.VAPID_PRIVATE_KEY) && isReal(e.VAPID_PUBLIC_KEY),
      ga4: isReal(e.GA4_MEASUREMENT_ID),
      googleServiceAccount: serviceAccountJson !== null,
      totpKey: decodedTotpKey !== null && decodedTotpKey.length === 32,
      sentry: isReal(e.SENTRY_DSN_API),
    },
  };

  if (config.auth.accessTtlMs >= config.auth.refreshTtlMs) {
    problems.push('JWT_ACCESS_TTL doit être plus courte que JWT_REFRESH_TTL');
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return Object.freeze(config);
}
