import { BENCH_CSRF_HEADER, BENCH_ROUTES, benchSessionSchema, benchStatusSchema } from '@raijin/bench-contracts';
import request from 'supertest';
import { cookiesOf, createTestBench, ORIGIN, OWNER_EMAIL, OWNER_PASSWORD, type TestBench } from '../../testing/test-app';
import { BENCH_LOGIN_PER_MINUTE } from '../http/bench-throttler';
import { BENCH_GLOBAL_LOCKOUT_THRESHOLD, BENCH_LOCKOUT_MS, BENCH_LOCKOUT_THRESHOLD, BenchAuthService } from './auth.service';

const HOUR = 3600_000;

describe('auth du banc (HTTP)', () => {
  let bench: TestBench;

  beforeEach(async () => {
    bench = await createTestBench();
  });

  afterEach(async () => {
    await bench.app.close();
  });

  const http = () => request(bench.app.getHttpServer());

  function login(body: Record<string, unknown>, origin: string | null = ORIGIN) {
    const req = http().post('/api/auth/login');
    if (origin) req.set('Origin', origin);
    return req.send(body);
  }

  async function loggedIn(): Promise<{ cookie: string; csrf: string }> {
    const res = await login({ email: OWNER_EMAIL, password: OWNER_PASSWORD, totp: bench.totp() }).expect(200);
    const cookies = cookiesOf(res.headers);
    const session = cookies['rjb_session'];
    const csrf = cookies['rjb_csrf'];
    if (!session || !csrf) throw new Error('cookies absents');
    return { cookie: `rjb_session=${session}; rjb_csrf=${csrf}`, csrf };
  }

  it('connexion : mot de passe + TOTP → 200, cookies rjb_* (session httpOnly, SameSite=Strict), session lisible', async () => {
    const res = await login({ email: ` ${OWNER_EMAIL.toUpperCase()} `, password: OWNER_PASSWORD, totp: bench.totp() }).expect(200);
    expect(benchSessionSchema.parse(res.body)).toEqual({ email: OWNER_EMAIL, mode: 'shadow', expiresAt: '2026-11-24T22:00:00.000Z' });
    const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const sessionLine = raw.find((line) => line.startsWith('rjb_session='));
    const csrfLine = raw.find((line) => line.startsWith('rjb_csrf='));
    expect(sessionLine).toMatch(/HttpOnly/);
    expect(sessionLine).toMatch(/SameSite=Strict/);
    expect(sessionLine).toMatch(/Path=\//);
    expect(csrfLine).not.toMatch(/HttpOnly/);
    expect(raw.join(';')).not.toMatch(/rj_at|rj_rt|rj_csrf=/);

    const cookie = raw.map((line) => line.split(';')[0]).join('; ');
    const session = await http().get('/api/auth/session').set('Cookie', cookie).expect(200);
    expect(session.body.email).toBe(OWNER_EMAIL);
  });

  it('TOTP faux, mot de passe faux, e-mail inconnu → 401 AUTH_INVALID_CREDENTIALS sans cookie', async () => {
    const wrongCode = bench.totp() === '000000' ? '111111' : '000000';
    for (const body of [
      { email: OWNER_EMAIL, password: OWNER_PASSWORD, totp: wrongCode },
      { email: OWNER_EMAIL, password: 'mauvais mot de passe', totp: bench.totp() },
      { email: 'autre@banc.test', password: OWNER_PASSWORD, totp: bench.totp() },
    ]) {
      const res = await login(body).expect(401);
      expect(res.body).toEqual({ code: 'AUTH_INVALID_CREDENTIALS', message: 'Identifiants ou code incorrects.' });
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('mot de passe sans TOTP : refusé (400), aucune session, routes protégées en 401', async () => {
    const res = await login({ email: OWNER_EMAIL, password: OWNER_PASSWORD }).expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.headers['set-cookie']).toBeUndefined();
    await http().get('/api/status').expect(401);
  });

  it('un code TOTP déjà utilisé est refusé (rejeu)', async () => {
    const code = bench.totp();
    await login({ email: OWNER_EMAIL, password: OWNER_PASSWORD, totp: code }).expect(200);
    await login({ email: OWNER_EMAIL, password: OWNER_PASSWORD, totp: code }).expect(401);
    bench.clock.advance(30_000);
    await login({ email: OWNER_EMAIL, password: OWNER_PASSWORD, totp: bench.totp() }).expect(200);
  });

  it('code de secours : accepté une seule fois', async () => {
    const recovery = bench.recoveryCodes[0] ?? '';
    await login({ email: OWNER_EMAIL, password: OWNER_PASSWORD, recovery_code: recovery.toLowerCase() }).expect(200);
    await login({ email: OWNER_EMAIL, password: OWNER_PASSWORD, recovery_code: recovery }).expect(401);
  });

  it(`verrouillage : ${BENCH_LOCKOUT_THRESHOLD} échecs → même les bons identifiants sont refusés pendant 15 min`, async () => {
    for (let index = 0; index < BENCH_LOCKOUT_THRESHOLD; index += 1) await login({ email: OWNER_EMAIL, password: 'faux mot de passe', totp: bench.totp() }).expect(401);
    const locked = await login({ email: OWNER_EMAIL, password: OWNER_PASSWORD, totp: bench.totp() }).expect(401);
    expect(locked.body.code).toBe('AUTH_INVALID_CREDENTIALS');
    bench.clock.advance(BENCH_LOCKOUT_MS + 1_000);
    await login({ email: OWNER_EMAIL, password: OWNER_PASSWORD, totp: bench.totp() }).expect(200);
  });

  it(`verrouillage par IP : ${BENCH_LOCKOUT_THRESHOLD} échecs depuis une IP ne bloquent pas le propriétaire sur une autre`, async () => {
    const auth = bench.app.get(BenchAuthService);
    const attacker = { ip: '203.0.113.7', userAgent: null };
    const ownerIp = { ip: '198.51.100.20', userAgent: null };
    for (let index = 0; index < BENCH_LOCKOUT_THRESHOLD; index += 1) {
      await expect(auth.login({ email: OWNER_EMAIL, password: 'faux', totp: bench.totp() }, attacker)).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    }
    // L'IP de l'attaquant est verrouillée, même avec les bons identifiants.
    await expect(auth.login({ email: OWNER_EMAIL, password: OWNER_PASSWORD, totp: bench.totp() }, attacker)).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    // Le propriétaire, depuis une autre IP, se connecte.
    await expect(auth.login({ email: OWNER_EMAIL, password: OWNER_PASSWORD, totp: bench.totp() }, ownerIp)).resolves.toMatchObject({ body: { email: OWNER_EMAIL } });
  });

  it(`verrouillage global : ${BENCH_GLOBAL_LOCKOUT_THRESHOLD} échecs toutes IP confondues → compte verrouillé 15 min`, async () => {
    const auth = bench.app.get(BenchAuthService);
    for (let index = 0; index < BENCH_GLOBAL_LOCKOUT_THRESHOLD; index += 1) {
      // Une IP différente à chaque essai (sous le seuil par IP) : seul le compteur global monte jusqu'au seuil.
      await expect(auth.login({ email: OWNER_EMAIL, password: 'faux', totp: '000000' }, { ip: `192.0.2.${index + 1}`, userAgent: null })).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    }
    const fresh = { ip: '198.51.100.20', userAgent: null };
    await expect(auth.login({ email: OWNER_EMAIL, password: OWNER_PASSWORD, totp: bench.totp() }, fresh)).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    bench.clock.advance(BENCH_LOCKOUT_MS + 1_000);
    await expect(auth.login({ email: OWNER_EMAIL, password: OWNER_PASSWORD, totp: bench.totp() }, fresh)).resolves.toMatchObject({ body: { email: OWNER_EMAIL } });
  });

  it('aucune IP en clair dans les clés de verrouillage', async () => {
    const auth = bench.app.get(BenchAuthService) as unknown as { ipLockKey(ip: string | null): string };
    const key = auth.ipLockKey('203.0.113.7');
    expect(key).toMatch(/^auth:fail:ip:[A-Za-z0-9_-]{43}$/);
    expect(key).not.toContain('203.0.113');
  });

  it(`limite de connexion : au-delà de ${BENCH_LOGIN_PER_MINUTE}/min par IP → 429 RATE_LIMITED`, async () => {
    for (let index = 0; index < BENCH_LOGIN_PER_MINUTE; index += 1) await login({ email: 'x@banc.test', password: 'x', totp: '123456' });
    const res = await login({ email: 'x@banc.test', password: 'x', totp: '123456' }).expect(429);
    expect(res.body).toEqual({ code: 'RATE_LIMITED', message: expect.any(String) });
  });

  it('connexion sans Origin ou depuis une origine étrangère → 403 AUTH_CSRF_INVALID', async () => {
    await login({ email: OWNER_EMAIL, password: OWNER_PASSWORD, totp: bench.totp() }, null).expect(403);
    const res = await login({ email: OWNER_EMAIL, password: OWNER_PASSWORD, totp: bench.totp() }, 'https://app.raijinshield.com').expect(403);
    expect(res.body.code).toBe('AUTH_CSRF_INVALID');
  });

  it('CSRF double-submit : en-tête absent, différent, d’une autre session ou sans Origin → 403 ; correct → 204', async () => {
    const first = await loggedIn();
    bench.clock.advance(30_000);
    const second = await loggedIn();
    const logout = () => http().post('/api/auth/logout').set('Cookie', first.cookie);
    await logout().set('Origin', ORIGIN).expect(403);
    await logout().set('Origin', ORIGIN).set(BENCH_CSRF_HEADER, `${first.csrf}x`).expect(403);
    // Jeton CSRF valide mais lié à l'autre session (cookie et en-tête cohérents entre eux).
    const crossed = first.cookie.replace(/rjb_csrf=[^;]+/, `rjb_csrf=${second.csrf}`);
    await http().post('/api/auth/logout').set('Cookie', crossed).set('Origin', ORIGIN).set(BENCH_CSRF_HEADER, second.csrf).expect(403);
    await logout().set(BENCH_CSRF_HEADER, first.csrf).expect(403);
    await logout().set('Origin', ORIGIN).set(BENCH_CSRF_HEADER, first.csrf).expect(204);
    await http().get('/api/auth/session').set('Cookie', first.cookie).expect(401);
    await http().get('/api/auth/session').set('Cookie', second.cookie).expect(200);
  });

  it('expiration : 2 h d’inactivité → 401 ; activité continue → 401 au bout de 12 h', async () => {
    const idle = await loggedIn();
    bench.clock.advance(2 * HOUR + 1_000);
    const res = await http().get('/api/auth/session').set('Cookie', idle.cookie).expect(401);
    expect(res.body.code).toBe('AUTH_SESSION_EXPIRED');

    const active = await loggedIn();
    for (let hour = 1; hour < 12; hour += 1) {
      bench.clock.advance(HOUR);
      await http().get('/api/auth/session').set('Cookie', active.cookie).expect(200);
    }
    bench.clock.advance(HOUR);
    await http().get('/api/auth/session').set('Cookie', active.cookie).expect(401);
    expect([...bench.store.sessions.values()].map((row) => row.revokedReason)).toEqual(['idle', 'expired']);
  });

  it('401 partout sans cookie, avec un cookie ou un jeton Raijin forgé, ou un cookie du banc inventé', async () => {
    const forgedJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJhZG1pbiIsInNpZCI6IngifQ.c2lnbmF0dXJl';
    const attempts: [string, string][] = [
      ['Cookie', ''],
      ['Cookie', `rj_at=${forgedJwt}; rj_csrf=abc`],
      ['Cookie', `__Host-rj_at=${forgedJwt}; __Secure-rj_rt=abc`],
      ['Authorization', `Bearer ${forgedJwt}`],
      ['Cookie', 'rjb_session=inventé'],
      ['Cookie', `rjb_session=${'a'.repeat(400)}`],
    ];
    const routes = [BENCH_ROUTES.status, BENCH_ROUTES.authSession, BENCH_ROUTES.events, BENCH_ROUTES.jobRuns];
    for (const [header, value] of attempts) {
      for (const route of routes) {
        const req = http().get(`/api/${route}`);
        if (value) req.set(header, value);
        const res = await req.expect(401);
        expect(res.body.code).toBe('AUTH_SESSION_EXPIRED');
      }
      const write = http().post('/api/auth/logout').set('Origin', ORIGIN);
      if (value) write.set(header, value);
      await write.expect(401);
    }
  });

  it('aucune route d’inscription ni de réinitialisation (404), avec ou sans session', async () => {
    const { cookie, csrf } = await loggedIn();
    for (const path of ['auth/register', 'auth/signup', 'auth/forgot-password', 'auth/reset-password', 'auth/password/reset', 'auth/totp/reset']) {
      await http().post(`/api/${path}`).set('Origin', ORIGIN).send({}).expect(404);
      await http().post(`/api/${path}`).set('Origin', ORIGIN).set('Cookie', cookie).set(BENCH_CSRF_HEADER, csrf).send({}).expect(404);
    }
    expect(Object.values(BENCH_ROUTES).filter((route) => /register|signup|forgot|reset-password/.test(route))).toEqual([]);
  });

  it('santé publique sans donnée, noindex ; statut conforme au contrat avec session', async () => {
    const health = await http().get('/api/health').expect(200);
    expect(health.body).toEqual({ status: 'ok' });
    expect(health.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(health.headers['cache-control']).toBe('no-store');
    const { cookie } = await loggedIn();
    const status = await http().get('/api/status').set('Cookie', cookie).expect(200);
    const parsed = benchStatusSchema.parse(status.body);
    expect(parsed.mode).toBe('shadow');
    expect(parsed.dependencies).toEqual({ database: 'up', redis: 'not_configured', helius: 'not_configured', push: 'up', email: 'up' });
    expect(parsed.wallet_study.state).toBe('not_configured');
    expect(parsed.storage).toMatchObject({ used_bytes: 100 * 1024 ** 2, level: 'ok' });
    expect(parsed.jobs).toHaveLength(11);
  });

  it('journal des jobs : liste filtrée et validée', async () => {
    const { cookie } = await loggedIn();
    await bench.runs.recordSkipped('scan-tokens', bench.clock.now(), 'overlap');
    const res = await http().get('/api/jobs/runs?job=scan-tokens&limit=5').set('Cookie', cookie).expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ job: 'scan-tokens', status: 'skipped' });
    await http().get('/api/jobs/runs?limit=9999').set('Cookie', cookie).expect(400);
  });
});
