import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { parseDuration } from './duration';

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
  readonly swaggerEnabled: boolean;
  readonly auth: {
    readonly accessSecret: string;
    readonly accessTtlMs: number;
    readonly refreshTtlMs: number;
    readonly cookieSecret: string;
    readonly cookieSecure: boolean;
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
  };
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
  };
  /** Services externes configurés ou non (jamais la valeur) : GET /health/config. */
  readonly services: Readonly<Record<string, boolean>>;
}

/** Valeurs factices de `.env.example` : traitées comme absentes. */
const PLACEHOLDER = /changeme|factice|^re_factice$|^sk_test_factice$|^whsec_factice$|^pk_test_factice$/i;

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
  JWT_ACCESS_SECRET: optionalString,
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  COOKIE_SECRET: optionalString,
  COOKIE_SECURE: optionalString,
  EMAIL_VERIFY_TTL: z.string().default('24h'),
  PASSWORD_RESET_TTL: z.string().default('30m'),
  MAGIC_LINK_TTL: z.string().default('15m'),
  AUTH_LOCKOUT_THRESHOLD: z.coerce.number().int().min(3).max(50).default(5),
  AUTH_LOCKOUT_DURATION: z.string().default('15m'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  MAIL_PROVIDER: z.enum(['smtp', 'resend']).default('smtp'),
  MAIL_FROM: z.string().trim().min(3).default('Raijin <noreply@raijinshield.com>'),
  SMTP_HOST: z.string().trim().min(1).default('localhost'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1026),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  RESEND_API_KEY: optionalString,
  MAIL_LOGO_URL: optionalString,
  // Services consultés seulement pour /health/config (présence, jamais la valeur).
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

const DEV_DATABASE_URL = 'postgresql://raijin:changeme-factice@localhost:5433/raijin?schema=public';
const DEV_REDIS_URL = 'redis://localhost:6380';
const MIN_SECRET_LENGTH = 32;

function isReal(value: string | undefined): value is string {
  return !!value && !PLACEHOLDER.test(value);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
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
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'} : ${issue.message}`),
    );
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';
  const problems: string[] = [];

  const secret = (name: 'JWT_ACCESS_SECRET' | 'COOKIE_SECRET'): string => {
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
  if (!redisUrl) {
    if (isProduction) problems.push('REDIS_URL : obligatoire en production (rate limiting partagé)');
    redisUrl = e.NODE_ENV === 'development' ? DEV_REDIS_URL : null;
  }

  let trustProxy: number | false = false;
  if (e.TRUST_PROXY) {
    const hops = Number(e.TRUST_PROXY);
    if (Number.isInteger(hops) && hops >= 0 && hops <= 10) trustProxy = hops === 0 ? false : hops;
    else problems.push('TRUST_PROXY : nombre de proxys de confiance attendu (0 à 10)');
  }

  const cookieSecure = parseBoolean(e.COOKIE_SECURE, isProduction);
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
    swaggerEnabled: !isProduction,
    auth: {
      accessSecret: secret('JWT_ACCESS_SECRET'),
      accessTtlMs: duration('JWT_ACCESS_TTL', e.JWT_ACCESS_TTL),
      refreshTtlMs: duration('JWT_REFRESH_TTL', e.JWT_REFRESH_TTL),
      cookieSecret: secret('COOKIE_SECRET'),
      cookieSecure,
      emailVerifyTtlMs: duration('EMAIL_VERIFY_TTL', e.EMAIL_VERIFY_TTL),
      passwordResetTtlMs: duration('PASSWORD_RESET_TTL', e.PASSWORD_RESET_TTL),
      magicLinkTtlMs: duration('MAGIC_LINK_TTL', e.MAGIC_LINK_TTL),
      lockoutThreshold: e.AUTH_LOCKOUT_THRESHOLD,
      lockoutMs: duration('AUTH_LOCKOUT_DURATION', e.AUTH_LOCKOUT_DURATION),
    },
    rateLimit: {
      perMinute: e.RATE_LIMIT_PER_MINUTE,
      authPerMinute: e.RATE_LIMIT_AUTH_PER_MINUTE,
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
    },
    services: {
      database: !!databaseUrl,
      redis: redisUrl !== null,
      helius: isReal(e.HELIUS_API_KEY),
      resend: !!resendApiKey,
      smtp: provider === 'smtp',
      stripe: isReal(e.STRIPE_SECRET_KEY) && isReal(e.STRIPE_WEBHOOK_SECRET),
      vapid: isReal(e.VAPID_PRIVATE_KEY),
      ga4: isReal(e.GA4_MEASUREMENT_ID),
      googleServiceAccount: isReal(e.GOOGLE_SERVICE_ACCOUNT_JSON),
      sentry: isReal(e.SENTRY_DSN_API),
    },
  };

  if (config.auth.accessTtlMs >= config.auth.refreshTtlMs) {
    problems.push('JWT_ACCESS_TTL doit être plus courte que JWT_REFRESH_TTL');
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return Object.freeze(config);
}
