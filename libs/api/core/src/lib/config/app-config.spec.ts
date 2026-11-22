import { ConfigError, loadConfig } from './app-config';
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
    expect(config.port).toBe(3000);
    expect(config.databaseUrl).toContain('localhost:5433');
    expect(config.redisUrl).toBe('redis://localhost:6380');
    expect(config.auth.accessSecret.length).toBeGreaterThanOrEqual(32);
    expect(config.auth.cookieSecure).toBe(false);
    expect(config.swaggerEnabled).toBe(true);
    expect(config.allowedOrigins).toEqual(['http://localhost:4200', 'http://localhost:4321']);
    expect(config.mail.provider).toBe('smtp');
    expect(config.mail.smtpPort).toBe(1026);
    expect(config.mail.logoUrl).toBe('http://localhost:4200/icons/icon-192.png');
    expect(warnings).toHaveLength(2);
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
