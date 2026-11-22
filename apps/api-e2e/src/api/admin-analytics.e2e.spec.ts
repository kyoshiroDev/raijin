import {
  AUTH_EMAIL_LINK_PATHS,
  adminAcquisitionSchema,
  adminEnrollmentStartSchema,
  adminHealthSchema,
  adminOverviewSchema,
  adminProductSchema,
  adminRevenueSchema,
  adminSeoSchema,
  adminTrafficSchema,
  adminTrialsSchema,
} from '@raijin/shared-contracts';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { ApiClient, tokenFrom, uniqueEmail, waitForMail } from '../support/client';

/**
 * Espace admin, écrans statistiques (phase 6 bis, docs/ARCHITECTURE.md §14.5 à §14.7) contre l'API réelle (Postgres,
 * Redis/BullMQ, Mailpit) avec `ANALYSIS_FIXTURES=1`, `ANALYTICS_PROVIDER=fake` (Google simulé) et `PUSH_PROVIDER=fake` :
 * routes invisibles (404) pour un compte non admin, 2FA exigée, agrégats nocturnes `metrics-aggregate`, 8 écrans
 * conformes aux contrats, données Google simulées, attribution jointe aux inscrits, alertes admin dédupliquées.
 */
const PASSWORD = 'une phrase de passe e2e solide';
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://raijin:changeme-factice@localhost:5433/raijin?schema=public';
const ROUTES = ['overview', 'traffic', 'seo', 'acquisition', 'revenue', 'trials', 'product', 'health'] as const;

async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
  const pg = new PgClient({ connectionString: DATABASE_URL });
  await pg.connect();
  try {
    return (await pg.query(query, params)).rows as T[];
  } finally {
    await pg.end();
  }
}

function randomIp(): string {
  const b = randomBytes(3);
  return `10.${b[0]}.${b[1]}.${b[2]}`;
}

async function verifiedUser(email: string, attribution?: Record<string, string>): Promise<ApiClient> {
  const client = new ApiClient();
  client.headers['X-Forwarded-For'] = randomIp();
  client.headers['User-Agent'] = `e2e-${randomUUID()}`;
  await client.init();
  expect((await client.post('/auth/register', { email, password: PASSWORD, acceptTerms: true, ...(attribution ? { attribution } : {}) })).status).toBe(202);
  const text = await waitForMail(email, 'Confirme ton adresse');
  expect((await client.post('/auth/verify-email', { token: tokenFrom(text, AUTH_EMAIL_LINK_PATHS.verifyEmail) })).status).toBe(200);
  return client;
}

/** Code TOTP RFC 6238 (HMAC-SHA1, 6 chiffres, 30 s) d'un secret base32. */
function totp(secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)?.map((byte) => parseInt(byte, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Compte ADMIN (rôle posé en base, comme la CLI) avec la 2FA activée et la session admin vérifiée. */
async function adminClient(email: string): Promise<ApiClient> {
  const client = await verifiedUser(email);
  await sql(`UPDATE "User" SET "role" = 'ADMIN' WHERE "email" = $1`, [email]);
  const blocked = await client.get('/admin/overview');
  expect(blocked.status).toBe(403);
  expect(blocked.data['code']).toBe('ADMIN_2FA_ENROLLMENT_REQUIRED');
  const start = await client.post('/admin/security/enrollment');
  expect(start.status).toBe(201);
  const { secret } = adminEnrollmentStartSchema.parse(start.data);
  const confirm = await client.post('/admin/security/enrollment/confirm', { code: totp(secret) });
  expect(confirm.status).toBeLessThan(300);
  return client;
}

async function runJob(client: ApiClient, name: string): Promise<Record<string, unknown>> {
  const res = await client.post<{ results: Record<string, unknown>[] }>(`/internal/jobs/${name}/run`, {});
  expect(res.status).toBe(200);
  return res.data.results[0] ?? {};
}

const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

describe('Espace admin : écrans statistiques, agrégats, alertes', () => {
  let admin: ApiClient;
  let adminEmail: string;
  const source = `e2e-src-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    // Inscription attribuée (landing → app → User) avant toute lecture de l'acquisition (cache 5 min).
    await verifiedUser(uniqueEmail('acq'), { utmSource: source, utmMedium: 'social', utmCampaign: 'lancement', landingPath: '/guides/rug-pull', referrer: 'https://x.com/raijin' });
    adminEmail = uniqueEmail('admin-stats');
    admin = await adminClient(adminEmail);
  });

  it('compte non admin : chaque route répond 404 (espace invisible) ; anonyme : 401', async () => {
    const user = await verifiedUser(uniqueEmail('pas-admin'));
    const anonymous = await new ApiClient().init();
    for (const route of ROUTES) {
      const res = await user.get(`/admin/${route}`);
      expect([route, res.status]).toEqual([route, 404]);
      expect(JSON.stringify(res.data)).not.toMatch(/mrr|sessions|jobs/i);
      expect((await anonymous.get(`/admin/${route}`)).status).toBe(401);
    }
  });

  it('agrégats nocturnes : metrics-aggregate écrit DailyMetric jusqu’à la veille (JobRun details.through)', async () => {
    const result = await runJob(admin, 'metrics-aggregate');
    expect(result).toMatchObject({ through: yesterday() });
    const rows = await sql<{ count: number }>(`SELECT count(*)::int AS count FROM "DailyMetric" WHERE "date" = $1::date`, [yesterday()]);
    expect(rows[0]?.count).toBeGreaterThan(30);
    const keys = await sql<{ key: string }>(`SELECT DISTINCT "key" FROM "DailyMetric"`);
    // Aucune donnée personnelle : seulement des clés du catalogue (aucun e-mail, aucune adresse).
    expect(keys.every(({ key }) => /^[a-z0-9_.]+$/.test(key) && !key.includes('@'))).toBe(true);
    const runs = await sql<{ through: string }>(`SELECT "details"->>'through' AS through FROM "JobRun" WHERE "job" = 'metrics-aggregate' AND "status" = 'SUCCESS' ORDER BY "startedAt" DESC LIMIT 1`);
    expect(runs[0]?.through).toBe(yesterday());
  });

  it('les 8 écrans répondent, conformes aux contrats, no-store, sans cookie posé', async () => {
    const schemas = {
      overview: adminOverviewSchema,
      traffic: adminTrafficSchema,
      seo: adminSeoSchema,
      acquisition: adminAcquisitionSchema,
      revenue: adminRevenueSchema,
      trials: adminTrialsSchema,
      product: adminProductSchema,
      health: adminHealthSchema,
    } as const;
    for (const route of ROUTES) {
      const res = await admin.get(`/admin/${route}`);
      expect([route, res.status]).toEqual([route, 200]);
      expect(schemas[route].safeParse(res.data).success).toBe(true);
      expect(res.headers['cache-control']).toContain('no-store');
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('vue d’ensemble : 10 KPI, entonnoir de 6 étapes, GA4 simulé, agrégats datés', async () => {
    const overview = adminOverviewSchema.parse((await admin.get('/admin/overview?period=30d')).data);
    expect(overview.kpis).toHaveLength(10);
    expect(overview.funnel.map((step) => step.key)).toEqual(['landing_visits', 'demo_analyses', 'signups', 'email_verified', 'trials_started', 'pro_conversions']);
    expect(overview.ga4).toMatchObject({ status: 'connected', simulated: true });
    expect(overview.funnel[0]?.value).toBeGreaterThan(0);
    expect(overview.kpis.find((kpi) => kpi.key === 'signups')?.value).toBeGreaterThanOrEqual(2);
    expect(overview.aggregatedThrough).toBe(yesterday());
    expect(overview.range.period).toBe('30d');
  });

  it('Google simulé : trafic GA4 et SEO avec décalage Search Console ; période invalide refusée', async () => {
    const traffic = adminTrafficSchema.parse((await admin.get('/admin/traffic?period=7d')).data);
    expect(traffic.service).toMatchObject({ status: 'connected', simulated: true });
    expect(traffic.data?.series[0]?.points).toHaveLength(7);
    const seo = adminSeoSchema.parse((await admin.get('/admin/seo?window=90d')).data);
    expect(seo.data).toMatchObject({ window: '90d', lagDays: 3 });
    expect(seo.data?.opportunities.length).toBeGreaterThan(0);
    expect((await admin.get('/admin/traffic?from=2026-01-01')).status).toBe(400);
    expect((await admin.get('/admin/seo?window=7d')).status).toBe(400);
  });

  it('acquisition : inscrit relié à sa source UTM, sa campagne et sa page d’arrivée', async () => {
    const bySource = adminAcquisitionSchema.parse((await admin.get('/admin/acquisition?dimension=source&period=7d')).data);
    expect(bySource.rows.find((row) => row.value === source)).toMatchObject({ signups: 1, verified: 1, payers: 0 });
    const byPage = adminAcquisitionSchema.parse((await admin.get('/admin/acquisition?dimension=landing_path&period=7d')).data);
    expect(byPage.rows.some((row) => row.value === '/guides/rug-pull')).toBe(true);
    const byReferrer = adminAcquisitionSchema.parse((await admin.get('/admin/acquisition?dimension=referrer_host&period=7d')).data);
    expect(byReferrer.rows.some((row) => row.value === 'x.com')).toBe(true);
    expect((await admin.get('/admin/acquisition?dimension=email')).status).toBe(400);
  });

  it('santé : jobs (dont les agrégats), quotas, services sans valeur, compteurs', async () => {
    const health = adminHealthSchema.parse((await admin.get('/admin/health')).data);
    expect(health.jobs.find((job) => job.name === 'metrics-aggregate')).toMatchObject({ lastStatus: 'success', consecutiveFailures: 0 });
    expect(health.quotas.map((quota) => quota.service)).toContain('helius');
    expect(health.services['ga4_data_api']).toBe('configured');
    expect(JSON.stringify(health.services)).not.toMatch(/sk_|whsec_|BEGIN|@/);
    expect(health.api.requests).toBeGreaterThan(0);
    expect(health.push.provider).toBe('fake');
  });

  it('alertes admin : job en échec 3 fois → une alerte, un e-mail à l’admin, puis résolution au succès', async () => {
    const job = `e2e-job-${randomUUID().slice(0, 8)}`;
    for (let i = 3; i >= 1; i -= 1) {
      await sql(`INSERT INTO "JobRun" ("id", "job", "startedAt", "finishedAt", "status", "error") VALUES ($1::uuid, $2, now() - ($3 || ' minutes')::interval, now(), 'FAILED', 'ECONNRESET')`, [randomUUID(), job, String(i)]);
    }
    try {
      const first = await runJob(admin, 'admin-alerts');
      expect(first['opened']).toBeGreaterThanOrEqual(1);
      const alerts = await sql<{ dedupeKey: string; notifiedAt: Date | null }>(`SELECT "dedupeKey", "notifiedAt" FROM "AdminAlert" WHERE "subject" = $1`, [job]);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.dedupeKey).toMatch(new RegExp(`^job_failing:${job}:`));
      expect(alerts[0]?.notifiedAt).not.toBeNull();
      const text = await waitForMail(adminEmail, 'Raijin admin');
      expect(text).toContain(`${job} : 3 échecs de suite, dernier code : ECONNRESET.`);
      // Même incident : aucune nouvelle alerte.
      await runJob(admin, 'admin-alerts');
      expect(await sql(`SELECT 1 FROM "AdminAlert" WHERE "subject" = $1`, [job])).toHaveLength(1);
      // Retour à la normale.
      await sql(`INSERT INTO "JobRun" ("id", "job", "startedAt", "finishedAt", "status") VALUES ($1::uuid, $2, now() + interval '1 second', now(), 'SUCCESS')`, [randomUUID(), job]);
      await runJob(admin, 'admin-alerts');
      const resolved = await sql<{ resolvedAt: Date | null }>(`SELECT "resolvedAt" FROM "AdminAlert" WHERE "subject" = $1`, [job]);
      expect(resolved[0]?.resolvedAt).not.toBeNull();
      const health = adminHealthSchema.parse((await admin.get('/admin/health')).data);
      expect(health.jobs.some((entry) => entry.name === 'admin-alerts')).toBe(true);
    } finally {
      await sql(`DELETE FROM "JobRun" WHERE "job" = $1`, [job]);
    }
  });
});
