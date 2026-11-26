import { PUBLIC_PLAN_CATALOG } from '@raijin/shared-contracts';
import { planPolicyLimits } from '../plan/plan-policy';
import { ConfigError, generateVapidKeys, LEGACY_REFRESH_MIGRATION_START, loadConfig, parentDomainOf } from './app-config';
import { parseDuration } from './duration';

const strong = 'S'.repeat(48);
const prodEnv = {
  NODE_ENV: 'production',
  APP_URL: 'https://app.raijinshield.com',
  LANDING_URL: 'https://raijinshield.com',
  API_URL: 'https://api.raijinshield.com',
  DATABASE_URL: 'postgresql://u:p@db:5432/raijin',
  REDIS_URL: 'redis://redis:6379',
  JWT_ACCESS_SECRET: strong,
  COOKIE_SECRET: `${strong}x`,
  IP_HASH_SECRET: `${strong}y`,
  COOKIE_SECURE: 'true',
  TRUST_PROXY: '1',
  TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
};

describe('parseDuration', () => {
  it.each([
    ['15m', 900_000],
    ['24h', 86_400_000],
    ['30d', 2_592_000_000],
    ['500ms', 500],
    ['90', 90_000],
  ])('%s → %i ms', (input, expected) => expect(parseDuration(input)).toBe(expected));

  it.each(['', 'abc', '0', '-5m', '10y'])('refuse « %s »', (input) => expect(parseDuration(input)).toBeNull());
});

describe('loadConfig', () => {
  it('développement : valeurs de repli sûres et secrets générés avec avertissement', () => {
    const warnings: string[] = [];
    const config = loadConfig({}, (message) => warnings.push(message));
    expect(config.env).toBe('development');
    expect(config.port).toBe(3100);
    expect(config.databaseUrl).toContain('localhost:5433');
    expect(config.redisUrl).toBe('redis://localhost:6380');
    expect(config.auth.accessSecret.length).toBeGreaterThanOrEqual(32);
    expect(config.auth.cookieSecure).toBe(false);
    expect(config.swaggerEnabled).toBe(true);
    expect(config.allowedOrigins).toEqual(['http://localhost:4200', 'http://localhost:4321']);
    expect(config.mail.provider).toBe('smtp');
    expect(config.mail.smtpPort).toBe(1026);
    expect(config.mail.logoUrl).toBe('http://localhost:4200/icons/icon-192.png');
    expect(warnings).toHaveLength(5); // 3 secrets + paire VAPID éphémère + clé TOTP éphémère
    expect(warnings.join(' ')).not.toContain(config.auth.accessSecret);
  });

  it('traite les valeurs factices de .env.example comme absentes', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      JWT_ACCESS_SECRET: 'changeme-access-secret-factice',
      COOKIE_SECRET: 'changeme-cookie-secret-factice',
      RESEND_API_KEY: 're_factice',
      HELIUS_API_KEY: 'vraie-cle-helius',
    });
    expect(config.auth.accessSecret).not.toContain('changeme');
    expect(config.services['resend']).toBe(false);
    expect(config.services['helius']).toBe(true);
    expect(config.redisUrl).toBeNull();
  });

  it('production valide : origines HTTPS, trust proxy, cookies Secure, Swagger coupé', () => {
    const config = loadConfig({ ...prodEnv, CORS_ORIGINS: 'https://raijinshield.com, https://www.raijinshield.com' });
    expect(config.isProduction).toBe(true);
    expect(config.trustProxy).toBe(1);
    expect(config.auth.cookieSecure).toBe(true);
    expect(config.swaggerEnabled).toBe(false);
    expect(config.allowedOrigins).toEqual([
      'https://app.raijinshield.com',
      'https://raijinshield.com',
      'https://www.raijinshield.com',
    ]);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('production : refuse secrets absents ou faibles sans jamais citer leur valeur', () => {
    const attempt = () =>
      loadConfig({ ...prodEnv, JWT_ACCESS_SECRET: 'xyz123', COOKIE_SECRET: undefined, DATABASE_URL: undefined });
    expect(attempt).toThrow(ConfigError);
    try {
      attempt();
    } catch (error) {
      const problems = (error as ConfigError).problems.join('\n');
      expect(problems).toContain('JWT_ACCESS_SECRET');
      expect(problems).toContain('COOKIE_SECRET');
      expect(problems).toContain('DATABASE_URL');
      expect(problems).not.toContain('xyz123');
    }
  });

  it('production : refuse COOKIE_SECURE=false, une origine HTTP, Redis absent et Resend sans clé', () => {
    expect(() =>
      loadConfig({
        ...prodEnv,
        COOKIE_SECURE: 'false',
        CORS_ORIGINS: 'http://exemple.fr',
        REDIS_URL: undefined,
        MAIL_PROVIDER: 'resend',
      }),
    ).toThrow(/COOKIE_SECURE[\s\S]*CORS_ORIGINS[\s\S]*REDIS_URL|REDIS_URL/);
  });

  it('production : TRUST_PROXY obligatoire (0 explicite accepté)', () => {
    expect(() => loadConfig({ ...prodEnv, TRUST_PROXY: undefined })).toThrow(/TRUST_PROXY : obligatoire/);
    expect(loadConfig({ ...prodEnv, TRUST_PROXY: '0' }).trustProxy).toBe(false);
  });

  it('limite d’auth par défaut : 10 en production, 60 en dev ; surchargeable', () => {
    expect(loadConfig(prodEnv).rateLimit.authPerMinute).toBe(10);
    expect(loadConfig({ NODE_ENV: 'test' }).rateLimit.authPerMinute).toBe(60);
    expect(loadConfig({ NODE_ENV: 'test', RATE_LIMIT_AUTH_PER_MINUTE: '3' }).rateLimit.authPerMinute).toBe(3);
  });

  it('analyse : limites et caches par défaut, IP_HASH_SECRET exigée et fixtures interdites en production', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.analysis).toMatchObject({
      anonDailyLimit: 3,
      freeDailyLimit: 5,
      trialDailyLimit: 50,
      failedDailyLimit: 20,
      upstreamFailedDailyLimit: 10,
      cacheTtlS: 60,
      cacheTtlNoKeyS: 300,
      webIndexHtmlPath: null,
      fixtures: false,
    });
    expect(config.analysis.ipHashSecret.length).toBeGreaterThanOrEqual(32);
    expect(config.rateLimit.analysisPerMinute).toBe(60);
    expect(loadConfig(prodEnv).rateLimit.analysisPerMinute).toBe(10);
    expect(loadConfig({ NODE_ENV: 'test', ANALYSIS_FIXTURES: '1' }).analysis.fixtures).toBe(true);
    expect(() => loadConfig({ ...prodEnv, IP_HASH_SECRET: undefined })).toThrow(/IP_HASH_SECRET/);
    expect(() => loadConfig({ ...prodEnv, ANALYSIS_FIXTURES: 'true' })).toThrow(/ANALYSIS_FIXTURES/);
    expect(() => loadConfig({ NODE_ENV: 'test', FREE_ANALYSIS_DAILY_LIMIT: '0' })).toThrow(ConfigError);
  });

  it('suivis et jobs : valeurs par défaut de docs/ENV.md, jobs coupés en test', () => {
    const dev = loadConfig({});
    expect(dev.watch).toMatchObject({
      freeLimit: 3,
      proLimit: 50,
      freeAlertHistoryDays: 30,
      proAlertHistoryDays: 90,
      fastIntervalMin: 5,
      holdersIntervalMin: 30,
      fullIntervalMin: 360,
      dailyCreditBudget: 12_000,
      alertCooldownMinutes: 360,
      emailBatchDelayS: 120,
      emailDailyMax: 20,
    });
    expect(dev.jobs).toMatchObject({ enabled: true, prefix: 'raijin', testTrigger: false, tickSeconds: 60, purgeCron: '30 3 * * *', retentionDays: 90 });
    expect(dev.mail.assetsBaseUrl).toBe('http://localhost:4200/email');
    expect(dev.maintenance).toBe(false);
    expect(loadConfig({ NODE_ENV: 'test' }).jobs.enabled).toBe(false);
    expect(loadConfig({ MAIL_ASSETS_BASE_URL: 'https://cdn.exemple.fr/mail/' }).mail.assetsBaseUrl).toBe('https://cdn.exemple.fr/mail');
    expect(loadConfig({ MAINTENANCE_MODE: '1' }).maintenance).toBe(true);
    expect(() => loadConfig({ PURGE_CRON: 'tous les jours' })).toThrow(ConfigError);
  });

  it('VAPID : paire éphémère générée en développement avec avertissement, jamais affichée', () => {
    const warnings: string[] = [];
    const config = loadConfig({}, (message) => warnings.push(message));
    expect(config.push.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(config.push.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(warnings.join('\n')).toContain('VAPID');
    expect(warnings.join('\n')).not.toContain(config.push.privateKey ?? '-');
    expect(config.services['vapid']).toBe(false);
  });

  it('VAPID : les deux clés ou aucune ; sans clés en production, push indisponible', () => {
    const pair = generateVapidKeys();
    const both = loadConfig({ ...prodEnv, VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey });
    expect(both.push).toMatchObject({ publicKey: pair.publicKey, privateKey: pair.privateKey, provider: 'webpush' });
    expect(both.services['vapid']).toBe(true);
    const warnings: string[] = [];
    expect(loadConfig(prodEnv, (message) => warnings.push(message)).push).toMatchObject({ publicKey: null, privateKey: null });
    expect(warnings).toEqual([expect.stringContaining('notifications push indisponibles')]);
    const silent: string[] = [];
    loadConfig({ ...prodEnv, VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey }, (message) => silent.push(message));
    expect(silent).toEqual([]);
    const attempt = () => loadConfig({ ...prodEnv, VAPID_PRIVATE_KEY: pair.privateKey });
    expect(attempt).toThrow(/VAPID_PUBLIC_KEY \/ VAPID_PRIVATE_KEY/);
    try {
      attempt();
    } catch (error) {
      expect((error as ConfigError).problems.join('\n')).not.toContain(pair.privateKey);
    }
    expect(() => loadConfig({ VAPID_PUBLIC_KEY: 'court', VAPID_PRIVATE_KEY: 'court' })).toThrow(/VAPID_PUBLIC_KEY/);
  });

  it('production : refuse le déclenchement manuel des jobs, le push simulé et un budget suivis > budget Helius', () => {
    const attempt = () =>
      loadConfig({ ...prodEnv, JOBS_TEST_TRIGGER: '1', PUSH_PROVIDER: 'fake', WATCH_DAILY_CREDIT_BUDGET: '30000' });
    expect(attempt).toThrow(/JOBS_TEST_TRIGGER[\s\S]*PUSH_PROVIDER[\s\S]*WATCH_DAILY_CREDIT_BUDGET/);
    expect(loadConfig({ JOBS_TEST_TRIGGER: '1', PUSH_PROVIDER: 'fake' }).jobs.testTrigger).toBe(true);
    expect(() => loadConfig({ WATCH_DAILY_CREDIT_BUDGET: '30000' })).toThrow(/WATCH_DAILY_CREDIT_BUDGET/);
  });

  it('scan de wallet : valeurs par défaut, budget suivis + wallet ≤ budget Helius, cache ≤ 10 min', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.wallet).toMatchObject({ dailyLimitPro: 20, dailyLimitTrial: 10, dailyCreditBudget: 3_000, maxTokens: 20, maxTokensNoKey: 8 });
    expect(config.wallet).toMatchObject({ maxAccounts: 1_000, cacheTtlS: 120, cacheTtlNoKeyS: 600, deadlineMs: 15_000, dustUsd: 1 });
    expect(config.rateLimit.walletScanPerMinute).toBe(60);
    expect(loadConfig({ ...prodEnv }).rateLimit.walletScanPerMinute).toBe(5);
    expect(() => loadConfig({ WATCH_DAILY_CREDIT_BUDGET: '20000', WALLET_DAILY_CREDIT_BUDGET: '3000' })).toThrow(
      /WATCH_DAILY_CREDIT_BUDGET \+ WALLET_DAILY_CREDIT_BUDGET/,
    );
    expect(() => loadConfig({ WALLET_SCAN_CACHE_TTL_NO_KEY_S: '601' })).toThrow(/WALLET_SCAN_CACHE_TTL_NO_KEY_S/);
  });

  it('refuse les valeurs mal formées', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', API_PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'beaucoup' })).toThrow(/TRUST_PROXY/);
    expect(() => loadConfig({ NODE_ENV: 'test', JWT_ACCESS_TTL: 'jamais' })).toThrow(/JWT_ACCESS_TTL/);
    expect(() => loadConfig({ NODE_ENV: 'test', JWT_ACCESS_TTL: '40d' })).toThrow(/plus courte/);
    expect(() => loadConfig({ NODE_ENV: 'test', CORS_ORIGINS: 'pas une url' })).toThrow(/CORS_ORIGINS/);
  });

  it('TRUST_PROXY=0 désactive la confiance ; Resend actif seulement avec une vraie clé', () => {
    const warnings: string[] = [];
    const config = loadConfig({ NODE_ENV: 'test', TRUST_PROXY: '0', MAIL_PROVIDER: 'resend' }, (m) => warnings.push(m));
    expect(config.trustProxy).toBe(false);
    expect(config.mail.provider).toBe('smtp');
    expect(warnings.some((m) => m.includes('MAIL_PROVIDER'))).toBe(true);
    const resend = loadConfig({ NODE_ENV: 'test', MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_vraie' });
    expect(resend.mail.provider).toBe('resend');
    expect(resend.services['resend']).toBe(true);
  });
});

describe('loadConfig — espace admin (phase 6 bis)', () => {
  it('valeurs par défaut de docs/ENV.md « Espace admin »', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.admin).toMatchObject({
      totpIssuer: 'Raijin Shield',
      totpMaxAttempts: 5,
      totpLockoutMs: 15 * 60_000,
      sessionIdleMs: 30 * 60_000,
      sessionMaxMs: 8 * 3_600_000,
      perMinute: 120,
      metricsCron: '15 2 * * *',
      alertsCron: '*/10 * * * *',
      alertJobFailures: 3,
      alertQuotaRatio: 0.8,
      auditLogRetentionDays: 365,
      jupiterDailyCallBudget: null,
      rugcheckDailyCallBudget: null,
    });
    expect(config.admin.totpEncryptionKey).toHaveLength(32);
    expect(config.analytics).toEqual({ provider: 'none', ga4PropertyId: null, searchConsoleSiteUrl: null, serviceAccountJson: null, cacheTtlS: 3600 });
  });

  it('clé TOTP : obligatoire en production (absente, factice ou ≠ 32 octets), éphémère en dev avec avertissement', () => {
    const withoutKey: Record<string, string> = { ...prodEnv };
    delete withoutKey['TOTP_ENCRYPTION_KEY'];
    expect(() => loadConfig(withoutKey)).toThrow(/TOTP_ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...prodEnv, TOTP_ENCRYPTION_KEY: 'changeme-cle-totp-factice' })).toThrow(/TOTP_ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...prodEnv, TOTP_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/TOTP_ENCRYPTION_KEY/);
    expect(loadConfig(prodEnv).admin.totpEncryptionKey.equals(Buffer.alloc(32, 5))).toBe(true);
    const warnings: string[] = [];
    loadConfig({ NODE_ENV: 'development' }, (message) => warnings.push(message));
    expect(warnings.join('\n')).toContain('TOTP_ENCRYPTION_KEY');
    expect(() => loadConfig({ NODE_ENV: 'development', TOTP_ENCRYPTION_KEY: 'YWJj' })).toThrow(/TOTP_ENCRYPTION_KEY/);
    expect(loadConfig(prodEnv).services['totpKey']).toBe(true);
  });

  it('ANALYTICS_PROVIDER : fake refusé en production ; google seulement avec le JSON ; jamais de valeur dans les erreurs', () => {
    expect(() => loadConfig({ ...prodEnv, ANALYTICS_PROVIDER: 'fake' })).toThrow(/ANALYTICS_PROVIDER/);
    expect(loadConfig({ NODE_ENV: 'test', ANALYTICS_PROVIDER: 'fake' }).analytics.provider).toBe('fake');
    expect(loadConfig({ NODE_ENV: 'test', ANALYTICS_PROVIDER: 'google' }).analytics.provider).toBe('none');
    const google = loadConfig({ NODE_ENV: 'test', GOOGLE_SERVICE_ACCOUNT_JSON: '{"type":"service_account"}', GA4_PROPERTY_ID: '123456', SEARCH_CONSOLE_SITE_URL: 'sc-domain:raijinshield.com' });
    expect(google.analytics).toMatchObject({ provider: 'google', ga4PropertyId: '123456', searchConsoleSiteUrl: 'sc-domain:raijinshield.com' });
    expect(() => loadConfig({ NODE_ENV: 'test', GA4_PROPERTY_ID: 'G-ABC' })).toThrow(/GA4_PROPERTY_ID/);
    expect(loadConfig({ NODE_ENV: 'test', GA4_PROPERTY_ID: '', JUPITER_DAILY_CALL_BUDGET: '', RUGCHECK_DAILY_CALL_BUDGET: '500' }).admin).toMatchObject({ jupiterDailyCallBudget: null, rugcheckDailyCallBudget: 500 });
  });
});

describe('loadConfig — quotas du catalogue public (phase 7, §15.2)', () => {
  it('défauts = PUBLIC_PLAN_CATALOG (une seule source)', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.analysis).toMatchObject({
      anonDailyLimit: PUBLIC_PLAN_CATALOG.anonAnalysesPerDay,
      freeDailyLimit: PUBLIC_PLAN_CATALOG.free.entitlements.analysesPerDay,
      trialDailyLimit: PUBLIC_PLAN_CATALOG.trial.entitlements.analysesPerDay,
    });
    expect(config.watch).toMatchObject({
      freeLimit: PUBLIC_PLAN_CATALOG.free.entitlements.maxActiveWatches,
      proLimit: PUBLIC_PLAN_CATALOG.pro.entitlements.maxActiveWatches,
      freeAlertHistoryDays: PUBLIC_PLAN_CATALOG.free.entitlements.alertHistoryDays,
      proAlertHistoryDays: PUBLIC_PLAN_CATALOG.pro.entitlements.alertHistoryDays,
    });
    expect(config.wallet).toMatchObject({
      dailyLimitPro: PUBLIC_PLAN_CATALOG.pro.entitlements.walletScansPerDay,
      dailyLimitTrial: PUBLIC_PLAN_CATALOG.trial.entitlements.walletScansPerDay,
    });
    expect(config.trial.days).toBe(PUBLIC_PLAN_CATALOG.trial.days);
    // Les droits calculés (essai, Gratuit, Pro) correspondent donc à ceux affichés par la landing.
    const limits = planPolicyLimits(config);
    expect(limits.free).toEqual(PUBLIC_PLAN_CATALOG.free.entitlements);
    expect(limits.trial).toEqual(PUBLIC_PLAN_CATALOG.trial.entitlements);
    expect(limits.subscription).toEqual(PUBLIC_PLAN_CATALOG.pro.entitlements);
  });

  it('production : variable différente du catalogue → avertissement (nom seulement), démarrage maintenu', () => {
    const warnings: string[] = [];
    const config = loadConfig({ ...prodEnv, FREE_WATCH_LIMIT: '5', TRIAL_DAYS: '14' }, (message) => warnings.push(message));
    expect(config.watch.freeLimit).toBe(5);
    const drift = warnings.filter((message) => message.includes('catalogue'));
    expect(drift).toHaveLength(2);
    expect(drift.join(' ')).toMatch(/FREE_WATCH_LIMIT[\s\S]*TRIAL_DAYS/);
    expect(drift.join(' ')).not.toMatch(/\b(5|14)\b/);
    const aligned: string[] = [];
    loadConfig(prodEnv, (message) => aligned.push(message));
    expect(aligned.filter((message) => message.includes('catalogue'))).toEqual([]);
    const dev: string[] = [];
    loadConfig({ NODE_ENV: 'development', FREE_WATCH_LIMIT: '5' }, (message) => dev.push(message));
    expect(dev.filter((message) => message.includes('catalogue'))).toEqual([]);
  });
});

describe('loadConfig — REDIS_URL avec mot de passe (phase 8)', () => {
  const url = 'redis://:9f8e7d6c5b4a39281706f5e4d3c2b1a0@raijin-redis:6379';

  it('URL avec mot de passe acceptée en production, transmise telle quelle aux clients', () => {
    expect(loadConfig({ ...prodEnv, REDIS_URL: url }).redisUrl).toBe(url);
    expect(loadConfig({ NODE_ENV: 'test', REDIS_URL: 'rediss://:abc@redis.exemple:6380/0' }).redisUrl).toBe('rediss://:abc@redis.exemple:6380/0');
  });

  it('URL invalide refusée sans jamais citer la valeur (mot de passe)', () => {
    let message = '';
    try {
      loadConfig({ ...prodEnv, REDIS_URL: 'http://:9f8e7d6c5b4a39281706f5e4d3c2b1a0@raijin-redis:6379' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('REDIS_URL');
    expect(message).not.toContain('9f8e7d6c5b4a39281706f5e4d3c2b1a0');
    const warnings: string[] = [];
    loadConfig({ ...prodEnv, REDIS_URL: url }, (warning) => warnings.push(warning));
    expect(warnings.join(' ')).not.toContain('9f8e7d6c5b4a39281706f5e4d3c2b1a0');
  });
});

describe('migration du refresh `__Secure-rj_rt` → `__Host-rj_rt`', () => {
  it('date limite : mise en service + JWT_REFRESH_TTL par défaut, surchargeable, refusée si invalide', () => {
    expect(loadConfig(prodEnv).auth.legacyRefreshUntil.getTime()).toBe(
      LEGACY_REFRESH_MIGRATION_START.getTime() + (parseDuration('30d') ?? 0),
    );
    const custom = loadConfig({ ...prodEnv, LEGACY_REFRESH_COOKIE_UNTIL: '2027-01-15T00:00:00Z' });
    expect(custom.auth.legacyRefreshUntil.toISOString()).toBe('2027-01-15T00:00:00.000Z');
    expect(() => loadConfig({ ...prodEnv, LEGACY_REFRESH_COOKIE_UNTIL: 'bientôt' })).toThrow(/LEGACY_REFRESH_COOKIE_UNTIL/);
  });

  it('domaine parent dérivé de APP_URL (jamais d’un en-tête), absent en dev', () => {
    expect(loadConfig(prodEnv).auth.cookieParentDomain).toBe('raijinshield.com');
    expect(loadConfig({ NODE_ENV: 'development' }).auth.cookieParentDomain).toBeNull();
    expect(parentDomainOf('https://dev.raijinshield.com')).toBe('raijinshield.com');
    expect(parentDomainOf('https://raijinshield.com')).toBeNull();
    expect(parentDomainOf('http://localhost:4200')).toBeNull();
    expect(parentDomainOf('http://127.0.0.1:3100')).toBeNull();
    expect(parentDomainOf('pas une url')).toBeNull();
  });
});
