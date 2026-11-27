import { Global, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ApiCoreModule, ApiException, setupApp, testConfig } from '@raijin/api-core';
import { PrismaService } from '@raijin/api-prisma';
import { sessionStateSchema } from '@raijin/shared-contracts';
import request from 'supertest';
import { userFixture } from '../../testing/fixtures';
import { ApiAuthModule } from '../api-auth.module';
import { AccessTokenService } from '../services/access-token.service';
import { AuthService, NEUTRAL_MESSAGES } from '../services/auth.service';
import { SessionService } from '../services/session.service';

const ORIGIN = 'http://localhost:4200';
const config = testConfig({ RATE_LIMIT_AUTH_PER_MINUTE: '1000' });

@Global()
@Module({ providers: [{ provide: PrismaService, useValue: {} }], exports: [PrismaService] })
class FakePrismaModule {}

/** Cookies `nom=valeur` d'une réponse, et leurs attributs bruts. */
function cookiesOf(res: request.Response): Record<string, { value: string; raw: string }> {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  const result: Record<string, { value: string; raw: string }> = {};
  for (const raw of header ?? []) {
    const [pair = ''] = raw.split(';');
    const index = pair.indexOf('=');
    result[pair.slice(0, index)] = { value: pair.slice(index + 1), raw };
  }
  return result;
}

describe('AuthController (HTTP, cookies, CSRF, garde)', () => {
  let app: NestExpressApplication;
  let accessTokens: AccessTokenService;
  const auth = {
    register: jest.fn(),
    verifyEmail: jest.fn(),
    resendVerification: jest.fn(),
    login: jest.fn(),
    refresh: jest.fn(),
    logout: jest.fn(),
    currentUser: jest.fn(),
    requestMagicLink: jest.fn(),
    verifyMagicLink: jest.fn(),
    forgotPassword: jest.fn(),
    resetPassword: jest.fn(),
    changePassword: jest.fn(),
  };
  const sessions = { isActive: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ApiCoreModule.forRoot(config), FakePrismaModule, ApiAuthModule],
    })
      .overrideProvider(AuthService)
      .useValue(auth)
      .overrideProvider(SessionService)
      .useValue(sessions)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
    setupApp(app, config);
    await app.init();
    accessTokens = app.get(AccessTokenService);
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  const server = () => app.getHttpServer();

  /** Jeton CSRF anonyme (GET /auth/csrf) : corps + cookie identiques. */
  async function anonymousCsrf(): Promise<{ token: string; cookie: string }> {
    const res = await request(server()).get('/api/v1/auth/csrf').expect(200);
    const cookie = cookiesOf(res)['rj_csrf'];
    expect(cookie?.value).toBe(res.body.csrfToken);
    return { token: res.body.csrfToken, cookie: `rj_csrf=${res.body.csrfToken}` };
  }

  function issued(sessionId = 'sid-1') {
    const { token, expiresAt } = accessTokens.sign({ sub: 'u', sid: sessionId, role: 'USER' });
    return { user: userFixture({ id: 'u' }), sessionId, accessToken: token, accessTokenExpiresAt: expiresAt, refreshToken: 'refresh-opaque' };
  }

  it('GET /auth/csrf : cookie httpOnly SameSite=Lax + jeton dans le corps', async () => {
    const res = await request(server()).get('/api/v1/auth/csrf').expect(200);
    const cookie = cookiesOf(res)['rj_csrf'];
    expect(cookie?.raw).toMatch(/HttpOnly/);
    expect(cookie?.raw).toMatch(/SameSite=Lax/);
    expect(res.body.csrfToken).toMatch(/^[A-Za-z0-9_.-]{32,256}$/);
  });

  it('POST /auth/register : 202 neutre, corps validé par le contrat', async () => {
    const { token, cookie } = await anonymousCsrf();
    auth.register.mockResolvedValue(NEUTRAL_MESSAGES.register);
    const res = await request(server())
      .post('/api/v1/auth/register')
      .set({ Origin: ORIGIN, 'X-CSRF-Token': token, Cookie: cookie })
      .send({ email: ' Jean@Exemple.fr ', password: 'une phrase de passe solide', acceptTerms: true })
      .expect(202);
    expect(res.body).toEqual({ message: NEUTRAL_MESSAGES.register });
    expect(auth.register.mock.calls[0][0].email).toBe('jean@exemple.fr');

    const invalid = await request(server())
      .post('/api/v1/auth/register')
      .set({ Origin: ORIGIN, 'X-CSRF-Token': token, Cookie: cookie })
      .send({ email: 'jean@exemple.fr', password: 'court', acceptTerms: true })
      .expect(400);
    expect(invalid.body.code).toBe('VALIDATION_ERROR');
  });

  it('mutation sans en-tête CSRF ou depuis une origine tierce : 403', async () => {
    const { token, cookie } = await anonymousCsrf();
    await request(server()).post('/api/v1/auth/login').set({ Origin: ORIGIN, Cookie: cookie }).send({}).expect(403);
    await request(server())
      .post('/api/v1/auth/login')
      .set({ Origin: 'https://evil.example', 'X-CSRF-Token': token, Cookie: cookie })
      .send({})
      .expect(403);
    expect(auth.login).not.toHaveBeenCalled();
  });

  it('POST /auth/login : cookies httpOnly, aucun jeton dans le corps hormis le CSRF lié à la session', async () => {
    const { token, cookie } = await anonymousCsrf();
    const session = issued('sid-login');
    auth.login.mockResolvedValue(session);
    const res = await request(server())
      .post('/api/v1/auth/login')
      .set({ Origin: ORIGIN, 'X-CSRF-Token': token, Cookie: cookie })
      .send({ email: 'jean@exemple.fr', password: 'x' })
      .expect(200);
    const cookies = cookiesOf(res);
    expect(cookies['rj_at']?.raw).toMatch(/HttpOnly/);
    expect(cookies['rj_rt']?.raw).toMatch(/Path=\/;/);
    expect(cookies['rj_rt']?.raw).not.toMatch(/Domain=/i);
    expect(cookies['rj_csrf']?.value).toBe(res.body.csrfToken);
    expect(JSON.stringify(res.body)).not.toContain(session.accessToken);
    expect(JSON.stringify(res.body)).not.toContain('refresh-opaque');
    expect(res.body.user).toMatchObject({ id: 'u', plan: 'FREE', emailVerified: false });
    expect(res.body.accessTokenExpiresAt).toBe(session.accessTokenExpiresAt.toISOString());
    expect(res.body.user.passwordHash).toBeUndefined();

    // Le jeton CSRF renvoyé est lié à la session : il sert aux mutations suivantes.
    auth.refresh.mockResolvedValue(issued('sid-login'));
    await request(server())
      .post('/api/v1/auth/refresh')
      .set({
        Origin: ORIGIN,
        'X-CSRF-Token': res.body.csrfToken,
        Cookie: `rj_csrf=${res.body.csrfToken}; rj_at=${session.accessToken}; rj_rt=refresh-opaque`,
      })
      .expect(200);
    expect(auth.refresh).toHaveBeenCalledWith('refresh-opaque', expect.anything(), 'sid-login');

    // Sans l'access token qui porte le sid, ce jeton lié n'est plus accepté.
    await request(server())
      .post('/api/v1/auth/refresh')
      .set({ Origin: ORIGIN, 'X-CSRF-Token': res.body.csrfToken, Cookie: `rj_csrf=${res.body.csrfToken}` })
      .expect(403);
  });

  it('POST /auth/refresh en échec : cookies de session effacés et erreur propagée', async () => {
    const { token, cookie } = await anonymousCsrf();
    auth.refresh.mockRejectedValue(ApiException.auth('AUTH_SESSION_EXPIRED', 401));
    const res = await request(server())
      .post('/api/v1/auth/refresh')
      .set({ Origin: ORIGIN, 'X-CSRF-Token': token, Cookie: `${cookie}; rj_rt=vieux` })
      .expect(401);
    expect(res.body.code).toBe('AUTH_SESSION_EXPIRED');
    expect(cookiesOf(res)['rj_rt']?.raw).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('auth/csrf puis auth/refresh avec un access token expiré : jeton lié au sid, accepté', async () => {
    const expired = new JwtService({}).sign(
      { sub: 'u', sid: 'sid-exp', role: 'USER', exp: Math.floor(Date.now() / 1000) - 60 },
      { secret: config.auth.accessSecret, issuer: 'raijin-api', audience: 'raijin-app' },
    );
    const csrfRes = await request(server()).get('/api/v1/auth/csrf').set('Cookie', `rj_at=${expired}`).expect(200);
    const token = csrfRes.body.csrfToken as string;
    auth.refresh.mockResolvedValue(issued('sid-exp'));
    await request(server())
      .post('/api/v1/auth/refresh')
      .set({ Origin: ORIGIN, 'X-CSRF-Token': token, Cookie: `rj_csrf=${token}; rj_at=${expired}; rj_rt=r` })
      .expect(200);
  });

  it('POST /auth/refresh avec un nom de refresh répété dans l’en-tête Cookie : 401 + effacement, aucune rotation', async () => {
    const { token, cookie } = await anonymousCsrf();
    const res = await request(server())
      .post('/api/v1/auth/refresh')
      .set({ Origin: ORIGIN, 'X-CSRF-Token': token, Cookie: `${cookie}; rj_rt=injecte; rj_rt=legitime` })
      .expect(401);
    expect(res.body).toEqual({ code: 'AUTH_SESSION_EXPIRED', message: expect.any(String) });
    expect(auth.refresh).not.toHaveBeenCalled();
    expect(cookiesOf(res)['rj_rt']?.raw).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('POST /auth/refresh : le sid de l’access est transmis ; refresh d’une autre session refusé (401 + effacement)', async () => {
    const session = issued('sid-victime');
    const csrfRes = await request(server()).get('/api/v1/auth/csrf').set('Cookie', `rj_at=${session.accessToken}`).expect(200);
    const token = csrfRes.body.csrfToken as string;
    auth.refresh.mockRejectedValue(ApiException.auth('AUTH_SESSION_EXPIRED', 401));
    const res = await request(server())
      .post('/api/v1/auth/refresh')
      .set({ Origin: ORIGIN, 'X-CSRF-Token': token, Cookie: `rj_csrf=${token}; rj_at=${session.accessToken}; rj_rt=autre-session` })
      .expect(401);
    expect(auth.refresh).toHaveBeenCalledWith('autre-session', expect.anything(), 'sid-victime');
    expect(cookiesOf(res)['rj_at']?.raw).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('POST /auth/refresh concurrent (409 CONFLICT) : cookies conservés', async () => {
    const { token, cookie } = await anonymousCsrf();
    auth.refresh.mockRejectedValue(new ApiException('CONFLICT', 409));
    const res = await request(server())
      .post('/api/v1/auth/refresh')
      .set({ Origin: ORIGIN, 'X-CSRF-Token': token, Cookie: `${cookie}; rj_rt=r` })
      .expect(409);
    expect(res.body.code).toBe('CONFLICT');
    expect(cookiesOf(res)['rj_rt']).toBeUndefined();
  });

  it('GET /auth/session : sans cookie → 200 anonyme ; refresh seul, session révoquée ou jeton invalide → AUTH_SESSION_EXPIRED', async () => {
    const anonymous = await request(server()).get('/api/v1/auth/session').expect(200);
    expect(sessionStateSchema.parse(anonymous.body)).toEqual({ authenticated: false });
    const refreshOnly = await request(server()).get('/api/v1/auth/session').set('Cookie', 'rj_rt=refresh-opaque').expect(401);
    expect(refreshOnly.body.code).toBe('AUTH_SESSION_EXPIRED');
    const session = issued('sid-revoquee');
    sessions.isActive.mockResolvedValue(false);
    const revoked = await request(server()).get('/api/v1/auth/session').set('Cookie', `rj_at=${session.accessToken}`).expect(401);
    expect(revoked.body.code).toBe('AUTH_SESSION_EXPIRED');
    const garbage = await request(server()).get('/api/v1/auth/session').set('Cookie', 'rj_at=pas-un-jwt').expect(401);
    expect(garbage.body.code).toBe('AUTH_SESSION_EXPIRED');
  });

  it('POST /auth/refresh sans cookie de refresh : 401 UNAUTHORIZED (rien à rafraîchir)', async () => {
    const { token, cookie } = await anonymousCsrf();
    auth.refresh.mockRejectedValue(new ApiException('UNAUTHORIZED', 401));
    const res = await request(server())
      .post('/api/v1/auth/refresh')
      .set({ Origin: ORIGIN, 'X-CSRF-Token': token, Cookie: cookie })
      .expect(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('GET /auth/session : session active → profil + nouveau CSRF lié', async () => {
    const session = issued('sid-ok');
    sessions.isActive.mockResolvedValue(true);
    auth.currentUser.mockResolvedValue(userFixture({ id: 'u', emailVerifiedAt: new Date() }));
    const res = await request(server()).get('/api/v1/auth/session').set('Cookie', `rj_at=${session.accessToken}`).expect(200);
    expect(res.body.user.emailVerified).toBe(true);
    expect(res.body.authenticated).toBe(true);
    // Identifiant de la doublure (« u ») hors format UUID : on valide la forme avec un vrai UUID.
    expect(sessionStateSchema.safeParse({ ...res.body, user: { ...res.body.user, id: '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' } }).success).toBe(true);
    expect(sessions.isActive).toHaveBeenCalledWith('sid-ok', 'u');
    expect(cookiesOf(res)['rj_csrf']?.value).toBe(res.body.csrfToken);
  });

  it('POST /auth/logout : 204, cookies effacés, nouveau CSRF anonyme ; jeton anonyme refusé si session lue', async () => {
    const anon = await anonymousCsrf();
    const session = issued('sid-out');
    await request(server())
      .post('/api/v1/auth/logout')
      .set({ Origin: ORIGIN, 'X-CSRF-Token': anon.token, Cookie: `${anon.cookie}; rj_at=${session.accessToken}` })
      .expect(403);
    const csrfRes = await request(server()).get('/api/v1/auth/csrf').set('Cookie', `rj_at=${session.accessToken}`).expect(200);
    const token = csrfRes.body.csrfToken as string;
    const res = await request(server())
      .post('/api/v1/auth/logout')
      .set({ Origin: ORIGIN, 'X-CSRF-Token': token, Cookie: `rj_csrf=${token}; rj_at=${session.accessToken}; rj_rt=r` })
      .expect(204);
    expect(auth.logout).toHaveBeenCalledWith('sid-out', 'r', expect.anything());
    const cookies = cookiesOf(res);
    expect(cookies['rj_at']?.raw).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(cookies['rj_csrf']?.value).toBeTruthy();
  });

  it('vérification d’e-mail, lien magique (avec page de retour), renvoi, oubli, reset, changement', async () => {
    const { token, cookie } = await anonymousCsrf();
    const headers = { Origin: ORIGIN, 'X-CSRF-Token': token, Cookie: cookie };
    const opaque = 'A'.repeat(43);

    auth.verifyEmail.mockResolvedValue(issued());
    await request(server()).post('/api/v1/auth/verify-email').set(headers).send({ token: opaque }).expect(200);
    await request(server()).post('/api/v1/auth/verify-email').set(headers).send({ token: 'court' }).expect(400);

    auth.verifyMagicLink.mockResolvedValue({ ...issued(), redirectPath: '/suivis' });
    const magic = await request(server()).post('/api/v1/auth/magic-link/verify').set(headers).send({ token: opaque }).expect(200);
    expect(magic.body.redirectPath).toBe('/suivis');

    auth.requestMagicLink.mockResolvedValue(NEUTRAL_MESSAGES.magicLink);
    await request(server()).post('/api/v1/auth/magic-link').set(headers).send({ email: 'a@b.fr', redirectPath: '//evil.example' }).expect(400);
    await request(server()).post('/api/v1/auth/magic-link').set(headers).send({ email: 'a@b.fr', redirectPath: '/suivis' }).expect(202);

    auth.resendVerification.mockResolvedValue(NEUTRAL_MESSAGES.resend);
    await request(server()).post('/api/v1/auth/verify-email/resend').set(headers).send({ email: 'a@b.fr' }).expect(202);
    expect(auth.resendVerification).toHaveBeenCalledWith(null, 'a@b.fr', expect.objectContaining({ ip: expect.any(String) }));

    auth.forgotPassword.mockResolvedValue(NEUTRAL_MESSAGES.forgot);
    const forgot = await request(server()).post('/api/v1/auth/password/forgot').set(headers).send({ email: 'a@b.fr' }).expect(202);
    expect(forgot.body.message).toBe(NEUTRAL_MESSAGES.forgot);

    await request(server())
      .post('/api/v1/auth/password/reset')
      .set(headers)
      .send({ token: opaque, password: 'nouvelle phrase de passe' })
      .expect(204);
    expect(auth.resetPassword).toHaveBeenCalledWith(opaque, 'nouvelle phrase de passe', expect.anything());

    await request(server())
      .post('/api/v1/auth/password/change')
      .set(headers)
      .send({ currentPassword: 'a', newPassword: 'nouvelle phrase de passe' })
      .expect(401);
  });

  it('POST /auth/password/change connecté : 204', async () => {
    const session = issued('sid-pw');
    sessions.isActive.mockResolvedValue(true);
    const csrfRes = await request(server()).get('/api/v1/auth/csrf').set('Cookie', `rj_at=${session.accessToken}`);
    const csrf = csrfRes.body.csrfToken as string;
    await request(server())
      .post('/api/v1/auth/password/change')
      .set({ Origin: ORIGIN, 'X-CSRF-Token': csrf, Cookie: `rj_csrf=${csrf}; rj_at=${session.accessToken}` })
      .send({ currentPassword: 'ancienne phrase', newPassword: 'nouvelle phrase de passe' })
      .expect(204);
    expect(auth.changePassword).toHaveBeenCalledWith('u', 'sid-pw', expect.objectContaining({ newPassword: 'nouvelle phrase de passe' }), expect.anything());
  });
});

describe('AuthController en mode Secure (`__Host-`) : migration depuis `__Secure-rj_rt`', () => {
  const secureConfig = testConfig({
    RATE_LIMIT_AUTH_PER_MINUTE: '1000',
    COOKIE_SECURE: 'true',
    APP_URL: 'http://app.raijinshield.test',
    CORS_ORIGINS: ORIGIN,
  });
  let app: NestExpressApplication;
  let accessTokens: AccessTokenService;
  const auth = { refresh: jest.fn(), logout: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ApiCoreModule.forRoot(secureConfig), FakePrismaModule, ApiAuthModule],
    })
      .overrideProvider(AuthService)
      .useValue(auth)
      .overrideProvider(SessionService)
      .useValue({ isActive: jest.fn() })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
    setupApp(app, secureConfig);
    await app.init();
    accessTokens = app.get(AccessTokenService);
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  /** Jeton CSRF lié au sid de l'access fourni. */
  async function boundCsrf(accessToken: string): Promise<string> {
    const res = await request(app.getHttpServer()).get('/api/v1/auth/csrf').set('Cookie', `__Host-rj_at=${accessToken}`).expect(200);
    return res.body.csrfToken as string;
  }

  function session(sid: string) {
    const { token, expiresAt } = accessTokens.sign({ sub: 'u', sid, role: 'USER' });
    return { user: userFixture({ id: 'u' }), sessionId: sid, accessToken: token, accessTokenExpiresAt: expiresAt, refreshToken: 'nouveau' };
  }

  /** Tous les Set-Cookie bruts (un même nom peut apparaître avec deux chemins). */
  const setCookies = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];

  it('ancien `__Secure-rj_rt` accepté une dernière fois : nouveau `__Host-rj_rt` (Path=/) posé, ancien expiré sur son chemin', async () => {
    const current = session('sid-1');
    const token = await boundCsrf(current.accessToken);
    auth.refresh.mockResolvedValue(current);
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set({
        Origin: ORIGIN,
        'X-CSRF-Token': token,
        Cookie: `__Host-rj_csrf=${token}; __Host-rj_at=${current.accessToken}; __Secure-rj_rt=ancien`,
      })
      .expect(200);
    expect(auth.refresh).toHaveBeenCalledWith('ancien', expect.anything(), 'sid-1');
    const raw = setCookies(res);
    const fresh = raw.find((c) => c.startsWith('__Host-rj_rt=nouveau'));
    expect(fresh).toMatch(/Path=\/;/);
    expect(fresh).toMatch(/HttpOnly/);
    expect(fresh).toMatch(/Secure/);
    expect(fresh).toMatch(/SameSite=Lax/);
    expect(fresh).not.toMatch(/Domain=/i);
    const legacy = raw.find((c) => c.startsWith('__Secure-rj_rt='));
    expect(legacy).toMatch(/Path=\/api\/v1\/auth/);
    expect(legacy).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('ancien `__Secure-rj_rt` sans access signé (déposable avec Domain) : refusé, aucune rotation', async () => {
    const anon = await request(app.getHttpServer()).get('/api/v1/auth/csrf').expect(200);
    const token = anon.body.csrfToken as string;
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set({ Origin: ORIGIN, 'X-CSRF-Token': token, Cookie: `__Host-rj_csrf=${token}; __Secure-rj_rt=injecte` })
      .expect(401);
    expect(res.body.code).toBe('AUTH_SESSION_EXPIRED');
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  it('`__Host-rj_rt` présent : l’ancien nom (injecté) est ignoré ; ancien nom répété : refusé', async () => {
    const current = session('sid-2');
    const token = await boundCsrf(current.accessToken);
    auth.refresh.mockResolvedValue(current);
    const base = `__Host-rj_csrf=${token}; __Host-rj_at=${current.accessToken}`;
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set({ Origin: ORIGIN, 'X-CSRF-Token': token, Cookie: `${base}; __Secure-rj_rt=injecte; __Host-rj_rt=legitime` })
      .expect(200);
    expect(auth.refresh).toHaveBeenCalledWith('legitime', expect.anything(), 'sid-2');
    auth.refresh.mockClear();
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set({ Origin: ORIGIN, 'X-CSRF-Token': token, Cookie: `${base}; __Secure-rj_rt=injecte; __Secure-rj_rt=ancien` })
      .expect(401);
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  /** Effacements de l'ancien nom portant `Domain=<parent>`. */
  const domainClears = (res: request.Response) =>
    setCookies(res).filter((c) => c.startsWith('__Secure-rj_rt=') && /Domain=raijinshield\.test/i.test(c) && /Expires=Thu, 01 Jan 1970/.test(c));

  it('refresh : un ancien `__Secure-rj_rt` injecté avec Domain= est aussi effacé avec Domain=<parent>', async () => {
    const current = session('sid-3');
    const token = await boundCsrf(current.accessToken);
    auth.refresh.mockResolvedValue(current);
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set({
        Origin: ORIGIN,
        'X-CSRF-Token': token,
        Cookie: `__Host-rj_csrf=${token}; __Host-rj_at=${current.accessToken}; __Secure-rj_rt=injecte; __Host-rj_rt=legitime`,
      })
      .expect(200);
    expect(domainClears(res).length).toBeGreaterThanOrEqual(1);
  });

  it('GET /auth/session : ancien cookie seul (sans sid signé) → 200 anonyme + effacement partout, pas de boucle 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/auth/session').set('Cookie', '__Secure-rj_rt=injecte').expect(200);
    expect(res.body).toEqual({ authenticated: false });
    expect(domainClears(res).length).toBeGreaterThanOrEqual(1);
    // Ancien cookie avec un sid signé (access expiré) : 401, le front tente le refresh (migration).
    const expired = new JwtService({}).sign(
      { sub: 'u', sid: 'sid-4', role: 'USER', exp: Math.floor(Date.now() / 1000) - 60 },
      { secret: secureConfig.auth.accessSecret, issuer: 'raijin-api', audience: 'raijin-app' },
    );
    const withSid = await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('Cookie', `__Host-rj_at=${expired}; __Secure-rj_rt=ancien`)
      .expect(401);
    expect(withSid.body.code).toBe('AUTH_SESSION_EXPIRED');
    // `__Host-rj_rt` seul : 401 comme avant (refresh à tenter).
    await request(app.getHttpServer()).get('/api/v1/auth/session').set('Cookie', '__Host-rj_rt=r').expect(401);
  });
});
