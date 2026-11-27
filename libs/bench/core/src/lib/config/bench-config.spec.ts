import { BenchConfigError, DEV_DATABASE_URL, DEV_REDIS_URL, loadBenchConfig, looksFake, parseKey32 } from './bench-config';

const KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index * 7 + 3)).toString('base64');
const PROD = {
  NODE_ENV: 'production',
  API_PORT: '3000',
  TRUST_PROXY: '1',
  COOKIE_SECURE: 'true',
  DATABASE_URL: 'postgresql://raijin_bench:9f3c1e7a2b@raijin-postgres:5432/raijin_bench?schema=public',
  REDIS_URL: 'redis://raijin-bench:4d8e2a91c0@raijin-redis:6379',
  BULLMQ_PREFIX: 'raijin-bench',
  BENCH_MODE: 'shadow',
  BENCH_OWNER_EMAIL: 'kyoshiro@raijinshield.com',
  BENCH_SESSION_SECRET: 'Zr8kP2vQ7mW1xN5tB9cL3hJ6fD0sA4gY',
  BENCH_TOTP_ENCRYPTION_KEY: KEY,
  BENCH_ALLOWED_ORIGINS: 'https://banc.raijinshield.com',
};

function problemsOf(env: Record<string, string | undefined>): string[] {
  try {
    loadBenchConfig(env);
    return [];
  } catch (error) {
    if (error instanceof BenchConfigError) return [...error.problems];
    throw error;
  }
}

describe('loadBenchConfig', () => {
  it('production complète : acceptée, cookies sécurisés, jobs actifs, mode ombre', () => {
    const config = loadBenchConfig(PROD);
    expect(config).toMatchObject({ isProduction: true, port: 3000, trustProxy: 1, mode: 'shadow', bullmqPrefix: 'raijin-bench', jobsEnabled: true, vapid: null });
    expect(config.auth.cookieSecure).toBe(true);
    expect(config.auth.totpKey).toHaveLength(32);
    expect(config.allowedOrigins).toEqual(['https://banc.raijinshield.com']);
  });

  it('production : refus si un secret manque, en citant les noms et jamais les valeurs', () => {
    const problems = problemsOf({ NODE_ENV: 'production' });
    for (const name of ['DATABASE_URL', 'REDIS_URL', 'BENCH_OWNER_EMAIL', 'BENCH_SESSION_SECRET', 'BENCH_TOTP_ENCRYPTION_KEY', 'BENCH_ALLOWED_ORIGINS']) {
      expect(problems.join('\n')).toContain(name);
    }
  });

  it('production : refus des valeurs factices de la doc', () => {
    const problems = problemsOf({
      ...PROD,
      DATABASE_URL: 'postgresql://raijin_bench:changeme-factice-hex@raijin-postgres:5432/raijin_bench',
      BENCH_SESSION_SECRET: 'factice-a-remplacer-par-openssl-rand-hex-32',
      BENCH_TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      BENCH_VAPID_PUBLIC_KEY: 'factice',
      BENCH_VAPID_PRIVATE_KEY: 'factice',
      BENCH_VAPID_SUBJECT: 'mailto:toi@exemple.invalid',
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        'DATABASE_URL garde une valeur factice',
        'BENCH_SESSION_SECRET garde une valeur factice',
        'BENCH_TOTP_ENCRYPTION_KEY garde une valeur factice',
        'BENCH_VAPID_PRIVATE_KEY / BENCH_VAPID_PUBLIC_KEY gardent une valeur factice',
      ]),
    );
    expect(problems.join(' ')).not.toContain('changeme-factice-hex');
  });

  it('isolement : jamais la base raijin, préfixe BullMQ imposé, HTTPS et cookies sécurisés en production', () => {
    expect(problemsOf({ ...PROD, DATABASE_URL: 'postgresql://raijin:9f3c1e7a2b@raijin-postgres:5432/raijin' })).toContain('BENCH_DATABASE_URL / DATABASE_URL doit viser la base raijin_bench');
    expect(problemsOf({ ...PROD, DATABASE_URL: 'postgresql://u:9f3c1e7a2b@h:5432/raijin_bench_dev' })).toContain('BENCH_DATABASE_URL / DATABASE_URL doit viser la base raijin_bench');
    expect(problemsOf({ ...PROD, BULLMQ_PREFIX: 'raijin' })).toContain('BULLMQ_PREFIX doit valoir raijin-bench (clés séparées de Raijin)');
    expect(problemsOf({ ...PROD, COOKIE_SECURE: 'false' })).toContain('COOKIE_SECURE doit valoir true en production');
    expect(problemsOf({ ...PROD, BENCH_ALLOWED_ORIGINS: 'http://banc.raijinshield.com' })).toContain('BENCH_ALLOWED_ORIGINS : origines https uniquement en production');
    expect(problemsOf({ ...PROD, BENCH_ALLOWED_ORIGINS: 'https://banc.raijinshield.com/chemin' })).toHaveLength(1);
  });

  it('formats : port, mode, e-mail, clé TOTP, VAPID incomplet, allocation, drapeau des jobs', () => {
    const problems = problemsOf({
      ...PROD,
      API_PORT: 'abc',
      TRUST_PROXY: '9',
      BENCH_MODE: 'live',
      BENCH_OWNER_EMAIL: 'pas-un-email',
      BENCH_TOTP_ENCRYPTION_KEY: 'trop-court',
      BENCH_VAPID_PUBLIC_KEY: 'BAbc',
      BENCH_DB_ALLOCATED_BYTES: '12',
      BENCH_JOBS_ENABLED: 'peut-être',
      NODE_ENV: 'production',
    });
    expect(problems).toHaveLength(8);
    expect(problemsOf({ NODE_ENV: 'staging' })).toContain('NODE_ENV doit valoir development, test ou production');
    expect(problemsOf({ NODE_ENV: 'test', BENCH_SESSION_SECRET: 'court' })).toContain('BENCH_SESSION_SECRET doit compter au moins 32 caractères');
    expect(problemsOf({ NODE_ENV: 'test', REDIS_URL: 'http://x' })).toContain('REDIS_URL doit être une URL redis://');
    expect(problemsOf({ NODE_ENV: 'test', BENCH_VAPID_PUBLIC_KEY: 'a', BENCH_VAPID_PRIVATE_KEY: 'b', BENCH_VAPID_SUBJECT: 'toi' })).toContain('BENCH_VAPID_SUBJECT doit commencer par mailto: ou https://');
    // Modèle de docs/ENV.md : clés vides, sujet pré-rempli → push indisponible, démarrage accepté.
    expect(loadBenchConfig({ ...PROD, BENCH_VAPID_PUBLIC_KEY: '', BENCH_VAPID_PRIVATE_KEY: '', BENCH_VAPID_SUBJECT: 'mailto:support@raijinshield.com' }).vapid).toBeNull();
    expect(loadBenchConfig({ ...PROD, BENCH_VAPID_PUBLIC_KEY: 'BPub', BENCH_VAPID_PRIVATE_KEY: 'priv', BENCH_VAPID_SUBJECT: 'mailto:support@raijinshield.com' }).vapid).toMatchObject({ publicKey: 'BPub' });
    // Fichier factice de la CI (infra/ci/fake-env.sh) : adresse .invalid acceptée, celle de la doc refusée.
    expect(loadBenchConfig({ ...PROD, BENCH_OWNER_EMAIL: 'ci@example.invalid' }).ownerEmail).toBe('ci@example.invalid');
    expect(problemsOf({ ...PROD, BENCH_OWNER_EMAIL: 'toi@exemple.invalid' })).toEqual(['BENCH_OWNER_EMAIL garde l’adresse d’exemple']);
  });

  it('dev : replis factices (raijin_bench_dev, Redis 6380, mode ombre) ; test : sans Redis ni jobs', () => {
    const dev = loadBenchConfig({});
    expect(dev).toMatchObject({ nodeEnv: 'development', databaseUrl: DEV_DATABASE_URL, redisUrl: DEV_REDIS_URL, mode: 'shadow', jobsEnabled: true });
    expect(dev.auth.cookieSecure).toBe(false);
    expect(loadBenchConfig({ REDIS_URL: 'none' }).jobsEnabled).toBe(false);
    const test = loadBenchConfig({ NODE_ENV: 'test' });
    expect(test).toMatchObject({ redisUrl: null, jobsEnabled: false });
    expect(loadBenchConfig({ NODE_ENV: 'test', BENCH_DATABASE_URL: 'postgresql://u:p@h:1/raijin_bench_test', DATABASE_URL: 'ignoré' }).databaseUrl).toContain('raijin_bench_test');
  });

  it('Solana : seules les variables BENCH_* passent ; plafonds Helius vérifiés au démarrage', () => {
    const config = loadBenchConfig({ ...PROD, HELIUS_API_KEY: 'cle-de-raijin', BENCH_HELIUS_API_KEY: 'cle-du-banc' });
    expect(config.solanaEnv['HELIUS_API_KEY']).toBeUndefined();
    expect(config.solanaEnv['BENCH_HELIUS_API_KEY']).toBe('cle-du-banc');
    expect(JSON.stringify(config.solanaEnv)).not.toContain('cle-de-raijin');
    expect(problemsOf({ ...PROD, BENCH_HELIUS_RPC_RPS: '50' }).join(' ')).toContain('BENCH_HELIUS_RPC_RPS');
  });

  it('utilitaires : clés de 32 octets (base64 / hex), valeurs factices', () => {
    expect(parseKey32('ab'.repeat(32))).toHaveLength(32);
    expect(parseKey32(KEY)).toHaveLength(32);
    expect(parseKey32(Buffer.alloc(16).toString('base64'))).toBeNull();
    expect(looksFake('aaaaaaaa')).toBe(true);
    expect(looksFake('changeme-factice-hex')).toBe(true);
    expect(looksFake('Zr8kP2vQ7mW1xN5tB9cL3hJ6fD0sA4gY')).toBe(false);
  });

  describe('EDGE_SHARED_SECRET (en-tête X-Raijin-Edge)', () => {
    const EDGE = 'c4f1a9e07b3d5628e1f0a7b9c2d4e6f8';

    it('absent : contrôle désactivé ; avertissement en production, sans échec', () => {
      expect(loadBenchConfig({ NODE_ENV: 'test', BENCH_OWNER_EMAIL: 'a@b.test' })).toMatchObject({ edgeSecretDigest: null, warnings: [] });
      const prod = loadBenchConfig(PROD);
      expect(prod.edgeSecretDigest).toBeNull();
      expect(prod.warnings).toEqual([expect.stringContaining('EDGE_SHARED_SECRET')]);
    });

    it('défini : seule son empreinte est gardée, jamais la valeur', () => {
      const config = loadBenchConfig({ ...PROD, EDGE_SHARED_SECRET: EDGE });
      expect(config.edgeSecretDigest).toHaveLength(32);
      expect(config.warnings).toEqual([]);
      expect(JSON.stringify(config)).not.toContain(EDGE);
    });

    it('production : refus si factice, trop court ou non ASCII visible, sans citer la valeur', () => {
      for (const value of ['changeme-edge-secret-changeme-000000', 'court', 'avec espace interne 0123456789abcdef']) {
        const problems = problemsOf({ ...PROD, EDGE_SHARED_SECRET: value });
        expect(problems).toEqual([expect.stringContaining('EDGE_SHARED_SECRET')]);
        expect(problems.join(' ')).not.toContain(value);
      }
    });
  });
});
