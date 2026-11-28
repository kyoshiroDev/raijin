import { benchModeSchema, type BenchMode } from '@raijin/bench-contracts';
import { loadBenchSolanaSettings } from '@raijin/bench-solana';
import type { VapidKeys } from '@raijin/server-push';
import { emailSchema } from '@raijin/shared-contracts';
import { edgeSecretDigest } from '../http/edge-guard';

/**
 * Configuration de l'API du banc (`infra/.env.bench-api` + variables imposées par `infra/docker-compose.yml`),
 * validée une fois au démarrage (docs/ENV.md, bloc « Banc »). Aucune autre partie du banc ne lit
 * `process.env` (sauf `@raijin/bench-solana`, qui reçoit ici l'environnement filtré `BENCH_*`).
 *
 * En production, le démarrage est **refusé** si un secret manque ou garde une valeur factice. Les
 * messages d'erreur citent le nom de la variable, jamais sa valeur.
 */
export interface BenchConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly isProduction: boolean;
  readonly port: number;
  /** Valeur de `trust proxy` d'Express (nombre de proxys de confiance : 1 = Traefik). */
  readonly trustProxy: number;
  /**
   * Empreinte SHA-256 de `EDGE_SHARED_SECRET` (en-tête `X-Raijin-Edge` posé par Traefik) ; `null` : contrôle
   * désactivé. Le secret lui-même n'est pas gardé.
   */
  readonly edgeSecretDigest: Buffer | null;
  /** Avertissements de démarrage (noms de variables seulement), journalisés par `main.ts`. */
  readonly warnings: readonly string[];
  /** URL de `raijin_bench` (utilisateur `raijin_bench`) : jamais journalisée. */
  readonly databaseUrl: string;
  /** URL Redis (utilisateur ACL `raijin-bench`) ; `null` en dev/test sans Redis : repli en mémoire, jobs coupés. */
  readonly redisUrl: string | null;
  /** Préfixe BullMQ (clés `raijin-bench:<file>:*`), toujours `raijin-bench`. */
  readonly bullmqPrefix: typeof BENCH_BULLMQ_PREFIX;
  readonly mode: BenchMode;
  readonly ownerEmail: string;
  readonly auth: {
    /** Secret HMAC des jetons de session, du CSRF et des empreintes d'IP (≥ 32 caractères, propre au banc). */
    readonly sessionSecret: string;
    /** Clé AES-256-GCM du secret TOTP (32 octets) ; la clé des codes de secours en est dérivée (HKDF). */
    readonly totpKey: Buffer;
    /** Cookies `__Host-rjb_*` + `Secure` (toujours vrai en production). */
    readonly cookieSecure: boolean;
  };
  /** Origines autorisées (CORS et contrôle `Origin` des écritures). */
  readonly allowedOrigins: readonly string[];
  /** Paire VAPID **du banc** (distincte de Raijin) ; `null` : push indisponible. */
  readonly vapid: VapidKeys | null;
  /** Espace alloué à `raijin_bench` (alerte 80 % / 95 %). */
  readonly dbAllocatedBytes: number;
  /** Planification BullMQ active (`BENCH_JOBS_ENABLED`, et Redis présent). */
  readonly jobsEnabled: boolean;
  /** Variables `BENCH_*` transmises à `createBenchSolana` (jamais `HELIUS_API_KEY`) et au code porté (T7). */
  readonly solanaEnv: Readonly<Record<string, string | undefined>>;
  /** E-mails d'alerte du banc (taille de base) : désactivés par défaut (`BENCH_MAIL_TRANSPORT=none`). */
  readonly mail: BenchMailConfig;
}

export type BenchMailConfig =
  | { readonly transport: 'none' }
  | { readonly transport: 'resend'; readonly apiKey: string; readonly from: string; readonly to: string }
  | { readonly transport: 'smtp'; readonly url: string; readonly from: string; readonly to: string };

export const BENCH_MAIL_TRANSPORTS = ['none', 'resend', 'smtp'] as const;

export const BENCH_BULLMQ_PREFIX = 'raijin-bench' as const;
export const DEFAULT_BENCH_PORT = 3300;
export const DEFAULT_DB_ALLOCATED_BYTES = 2 * 1024 ** 3;
/** Repli de dev (factice, non secret) : même base que `libs/bench/prisma/prisma.config.ts`. */
export const DEV_DATABASE_URL = 'postgresql://raijin:changeme-factice@localhost:5433/raijin_bench_dev?schema=public';
/** Redis de `docker-compose.dev.yml` (port hôte 6380), partagé avec Raijin en dev : clés sous `raijin-bench:`. */
export const DEV_REDIS_URL = 'redis://localhost:6380';
export const DEV_OWNER_EMAIL = 'proprietaire@banc.invalid';
/** Adresse d'exemple de docs/ENV.md, refusée en production. */
export const DOC_OWNER_EMAIL = 'toi@exemple.invalid';
export const DEV_ALLOWED_ORIGINS = ['http://localhost:4300'] as const;
/** Valeurs de dev, factices : refusées en production. */
const DEV_SESSION_SECRET = 'dev-factice-secret-de-session-du-banc-0000';
const DEV_TOTP_KEY = Buffer.alloc(32, 7);

/** Erreur de configuration : liste de noms de variables et de raisons, sans aucune valeur. */
export class BenchConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Configuration du banc invalide : ${problems.join(' ; ')}`);
    this.name = 'BenchConfigError';
  }
}

const FAKE_MARKERS = /(factice|changeme|change-me|a-remplacer|remplace|example|exemple|placeholder|dummy|xxxx)/i;

/** Vrai si la valeur ressemble à un exemple de la doc (factice, répétitive, trop courte pour un secret). */
export function looksFake(value: string): boolean {
  return FAKE_MARKERS.test(value) || /^(.)\1*$/.test(value);
}

type Env = Readonly<Record<string, string | undefined>>;

function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean | null {
  if (value === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false;
  return null;
}

function parseInteger(value: string | undefined, fallback: number, min: number, max: number): number | null {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

/** Clé de 32 octets en base64 (`openssl rand -base64 32`) ou en hexadécimal (64 caractères). */
export function parseKey32(value: string): Buffer | null {
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) {
    const buffer = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return buffer.length === 32 ? buffer : null;
  }
  return null;
}

function databaseNameOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') return null;
    return decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    return null;
  }
}

function validRedisUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'redis:' || parsed.protocol === 'rediss:';
  } catch {
    return false;
  }
}

function parseOrigins(value: string): string[] | null {
  const origins = value.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
  if (origins.length === 0) return null;
  for (const origin of origins) {
    try {
      const parsed = new URL(origin);
      if (parsed.origin !== origin) return null;
    } catch {
      return null;
    }
  }
  return origins;
}

/**
 * Lit et valide la configuration. `env` vaut `process.env` en production ; les tests passent un objet.
 * Lève `BenchConfigError` avec la liste complète des problèmes (pas seulement le premier).
 */
export function loadBenchConfig(env: Env): BenchConfig {
  const problems: string[] = [];
  const nodeEnvRaw = read(env, 'NODE_ENV') ?? 'development';
  const nodeEnv = (['development', 'test', 'production'] as const).find((item) => item === nodeEnvRaw);
  if (!nodeEnv) problems.push('NODE_ENV doit valoir development, test ou production');
  const isProduction = nodeEnv === 'production';

  /** Secret obligatoire en production (absent ou factice : refus) ; repli de dev sinon. */
  const secret = (name: string, devFallback: string | undefined): string | undefined => {
    const value = read(env, name);
    if (isProduction) {
      if (value === undefined) problems.push(`${name} est obligatoire en production`);
      else if (looksFake(value)) problems.push(`${name} garde une valeur factice`);
      return value;
    }
    return value ?? devFallback;
  };

  const port = parseInteger(read(env, 'API_PORT'), DEFAULT_BENCH_PORT, 1, 65_535);
  if (port === null) problems.push('API_PORT doit être un port (1–65535)');
  const trustProxy = parseInteger(read(env, 'TRUST_PROXY'), 0, 0, 5);
  if (trustProxy === null) problems.push('TRUST_PROXY doit être un entier de 0 à 5');

  // En-tête secret de Traefik (docs/SECURITY.md §17) : absent = désactivé (avertissement en production).
  const warnings: string[] = [];
  const edgeSecret = read(env, 'EDGE_SHARED_SECRET');
  let edgeDigest: Buffer | null = null;
  if (edgeSecret === undefined) {
    if (isProduction) warnings.push('EDGE_SHARED_SECRET absent : en-tête X-Raijin-Edge non exigé (requêtes hors Traefik acceptées)');
  } else if (edgeSecret.length > 256 || !/^[\x21-\x7e]+$/.test(edgeSecret)) {
    problems.push('EDGE_SHARED_SECRET doit être en ASCII visible, sans espace, 256 caractères au plus (openssl rand -hex 32)');
  } else if (isProduction && (edgeSecret.length < 32 || looksFake(edgeSecret))) {
    problems.push('EDGE_SHARED_SECRET doit compter au moins 32 caractères et ne pas être factice');
  } else {
    edgeDigest = edgeSecretDigest(edgeSecret);
  }

  // Base : BENCH_DATABASE_URL (CLI Prisma du banc) ou DATABASE_URL (imposée par le compose du conteneur).
  const databaseUrl = secret(read(env, 'BENCH_DATABASE_URL') ? 'BENCH_DATABASE_URL' : 'DATABASE_URL', DEV_DATABASE_URL);
  if (databaseUrl !== undefined) {
    const name = databaseNameOf(databaseUrl);
    if (name === null) problems.push('BENCH_DATABASE_URL / DATABASE_URL doit être une URL postgresql://');
    // Garde-fou d'isolement : jamais la base de Raijin (`raijin`) ni une autre.
    else if (!/^raijin_bench(_[a-z0-9]+)?$/.test(name) || (isProduction && name !== 'raijin_bench'))
      problems.push('BENCH_DATABASE_URL / DATABASE_URL doit viser la base raijin_bench');
  }

  const redisName = read(env, 'BENCH_REDIS_URL') ? 'BENCH_REDIS_URL' : 'REDIS_URL';
  const redisRaw = read(env, redisName);
  let redisUrl: string | null = null;
  if (redisRaw !== undefined && redisRaw.toLowerCase() !== 'none') {
    if (!validRedisUrl(redisRaw)) problems.push(`${redisName} doit être une URL redis://`);
    else if (isProduction && looksFake(redisRaw)) problems.push(`${redisName} garde une valeur factice`);
    redisUrl = redisRaw;
  } else if (isProduction) {
    problems.push('BENCH_REDIS_URL / REDIS_URL est obligatoire en production');
  } else if (redisRaw === undefined && nodeEnv === 'development') {
    redisUrl = DEV_REDIS_URL;
  }

  const bullmqPrefix = read(env, 'BULLMQ_PREFIX') ?? BENCH_BULLMQ_PREFIX;
  if (bullmqPrefix !== BENCH_BULLMQ_PREFIX) problems.push(`BULLMQ_PREFIX doit valoir ${BENCH_BULLMQ_PREFIX} (clés séparées de Raijin)`);

  const mode = benchModeSchema.safeParse(read(env, 'BENCH_MODE') ?? 'shadow');
  if (!mode.success) problems.push('BENCH_MODE doit valoir shadow ou primary');

  // Pas un secret : seule l'adresse d'exemple de docs/ENV.md est refusée en production.
  const ownerRaw = read(env, 'BENCH_OWNER_EMAIL') ?? (isProduction ? undefined : DEV_OWNER_EMAIL);
  if (ownerRaw === undefined) problems.push('BENCH_OWNER_EMAIL est obligatoire en production');
  const owner = ownerRaw === undefined ? null : emailSchema.safeParse(ownerRaw);
  if (owner && !owner.success) problems.push('BENCH_OWNER_EMAIL doit être une adresse e-mail');
  else if (isProduction && owner?.data === DOC_OWNER_EMAIL) problems.push('BENCH_OWNER_EMAIL garde l’adresse d’exemple');

  const sessionSecret = secret('BENCH_SESSION_SECRET', DEV_SESSION_SECRET);
  if (sessionSecret !== undefined && sessionSecret.length < 32) problems.push('BENCH_SESSION_SECRET doit compter au moins 32 caractères');

  const totpRaw = secret('BENCH_TOTP_ENCRYPTION_KEY', undefined);
  let totpKey: Buffer | null = totpRaw === undefined ? (isProduction ? null : DEV_TOTP_KEY) : parseKey32(totpRaw);
  if (totpRaw !== undefined && totpKey === null) problems.push('BENCH_TOTP_ENCRYPTION_KEY doit faire 32 octets (openssl rand -base64 32)');
  if (isProduction && totpKey !== null && totpKey.equals(DEV_TOTP_KEY)) {
    problems.push('BENCH_TOTP_ENCRYPTION_KEY garde une valeur factice');
    totpKey = null;
  }

  const cookieSecure = parseBoolean(read(env, 'COOKIE_SECURE'), isProduction);
  if (cookieSecure === null) problems.push('COOKIE_SECURE doit valoir true ou false');
  else if (isProduction && !cookieSecure) problems.push('COOKIE_SECURE doit valoir true en production');

  const originsRaw = read(env, 'BENCH_ALLOWED_ORIGINS');
  const allowedOrigins = originsRaw === undefined ? (isProduction ? null : [...DEV_ALLOWED_ORIGINS]) : parseOrigins(originsRaw);
  if (originsRaw === undefined && isProduction) problems.push('BENCH_ALLOWED_ORIGINS est obligatoire en production');
  else if (allowedOrigins === null) problems.push('BENCH_ALLOWED_ORIGINS doit lister des origines (https://hôte), séparées par des virgules');
  else if (isProduction && allowedOrigins.some((origin) => !origin.startsWith('https://')))
    problems.push('BENCH_ALLOWED_ORIGINS : origines https uniquement en production');

  const vapidPublic = read(env, 'BENCH_VAPID_PUBLIC_KEY');
  const vapidPrivate = read(env, 'BENCH_VAPID_PRIVATE_KEY');
  const vapidSubject = read(env, 'BENCH_VAPID_SUBJECT');
  let vapid: VapidKeys | null = null;
  // Clés vides = push indisponible (le sujet seul, pré-rempli dans docs/ENV.md, est alors ignoré).
  if ((vapidPublic === undefined) !== (vapidPrivate === undefined) || (vapidPublic !== undefined && vapidSubject === undefined))
    problems.push('BENCH_VAPID_PUBLIC_KEY, BENCH_VAPID_PRIVATE_KEY et BENCH_VAPID_SUBJECT vont ensemble');
  else if (vapidPublic && vapidPrivate && vapidSubject) {
    if (isProduction && (looksFake(vapidPublic) || looksFake(vapidPrivate))) problems.push('BENCH_VAPID_PRIVATE_KEY / BENCH_VAPID_PUBLIC_KEY gardent une valeur factice');
    if (!/^(mailto:|https:\/\/)/.test(vapidSubject)) problems.push('BENCH_VAPID_SUBJECT doit commencer par mailto: ou https://');
    vapid = { publicKey: vapidPublic, privateKey: vapidPrivate, subject: vapidSubject };
  }

  const dbAllocatedBytes = parseInteger(read(env, 'BENCH_DB_ALLOCATED_BYTES'), DEFAULT_DB_ALLOCATED_BYTES, 64 * 1024 ** 2, 1024 ** 4);
  if (dbAllocatedBytes === null) problems.push('BENCH_DB_ALLOCATED_BYTES doit être un nombre d’octets (64 Mio à 1 Tio)');

  // E-mails d'alerte (T7) : port BenchMailSender, aucun envoi tant que BENCH_MAIL_TRANSPORT vaut none (défaut).
  const mailTransport = read(env, 'BENCH_MAIL_TRANSPORT') ?? 'none';
  let mail: BenchMailConfig = { transport: 'none' };
  if (!(BENCH_MAIL_TRANSPORTS as readonly string[]).includes(mailTransport)) problems.push('BENCH_MAIL_TRANSPORT doit valoir none, resend ou smtp');
  else if (mailTransport !== 'none') {
    const from = read(env, 'BENCH_MAIL_FROM');
    const toRaw = read(env, 'BENCH_ALERT_EMAIL') ?? ownerRaw;
    const to = toRaw === undefined ? null : emailSchema.safeParse(toRaw);
    if (from === undefined || !/^[^<>\r\n]{0,80}<?[^\s@<>]+@[^\s@<>]+>?$/.test(from)) problems.push('BENCH_MAIL_FROM doit être une adresse d’expédition (Nom <adresse>)');
    if (!to || !to.success) problems.push('BENCH_ALERT_EMAIL doit être une adresse e-mail');
    if (mailTransport === 'resend') {
      const apiKey = read(env, 'BENCH_RESEND_API_KEY');
      if (apiKey === undefined) problems.push('BENCH_RESEND_API_KEY est obligatoire avec BENCH_MAIL_TRANSPORT=resend');
      else if (isProduction && looksFake(apiKey)) problems.push('BENCH_RESEND_API_KEY garde une valeur factice');
      if (apiKey && from && to?.success) mail = { transport: 'resend', apiKey, from, to: to.data };
    } else {
      const url = read(env, 'BENCH_SMTP_URL');
      if (url === undefined || !/^smtps?:\/\/[^\s]+$/.test(url)) problems.push('BENCH_SMTP_URL doit être une URL smtp:// ou smtps://');
      else if (from && to?.success) mail = { transport: 'smtp', url, from, to: to.data };
    }
  }

  const jobsFlag = parseBoolean(read(env, 'BENCH_JOBS_ENABLED'), nodeEnv !== 'test');
  if (jobsFlag === null) problems.push('BENCH_JOBS_ENABLED doit valoir 1 ou 0');

  // Seules les variables BENCH_* vont aux intégrations Solana ; leurs plafonds sont vérifiés ici aussi.
  const solanaEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) if (key.startsWith('BENCH_')) solanaEnv[key] = value;
  try {
    loadBenchSolanaSettings(solanaEnv);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : 'variables BENCH_HELIUS_* invalides');
  }

  if (problems.length > 0 || !nodeEnv || port === null || trustProxy === null || databaseUrl === undefined || !mode.success || !owner?.success || sessionSecret === undefined || totpKey === null || cookieSecure === null || allowedOrigins === null || dbAllocatedBytes === null || jobsFlag === null) {
    throw new BenchConfigError(problems.length > 0 ? problems : ['configuration incomplète']);
  }

  return {
    nodeEnv,
    isProduction,
    port,
    trustProxy,
    edgeSecretDigest: edgeDigest,
    warnings,
    databaseUrl,
    redisUrl,
    bullmqPrefix: BENCH_BULLMQ_PREFIX,
    mode: mode.data,
    ownerEmail: owner.data,
    auth: { sessionSecret, totpKey, cookieSecure },
    allowedOrigins,
    vapid,
    dbAllocatedBytes,
    jobsEnabled: jobsFlag && redisUrl !== null,
    solanaEnv,
    mail,
  };
}
