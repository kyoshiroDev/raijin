import { ConfigError, generateVapidKeys, loadConfig } from './app-config';
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
    expect(warnings).toHaveLength(4); // 3 secrets + paire VAPID éphémère
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
