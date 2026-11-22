import { Global, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ApiCoreModule, ApiException, setupApp, testConfig } from '@raijin/api-core';
import { PrismaService } from '@raijin/api-prisma';
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
    expect(cookies['rj_rt']?.raw).toMatch(/Path=\/api\/v1\/auth/);
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
    expect(auth.refresh).toHaveBeenCalledWith('refresh-opaque', expect.anything());

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

  it('GET /auth/session et routes protégées : 401 sans session active', async () => {
    const res = await request(server()).get('/api/v1/auth/session').expect(401);
    expect(res.body.code).toBe('AUTH_SESSION_EXPIRED');
    const session = issued('sid-revoquee');
    sessions.isActive.mockResolvedValue(false);
    await request(server()).get('/api/v1/auth/session').set('Cookie', `rj_at=${session.accessToken}`).expect(401);
  });

  it('GET /auth/session : session active → profil + nouveau CSRF lié', async () => {
    const session = issued('sid-ok');
    sessions.isActive.mockResolvedValue(true);
    auth.currentUser.mockResolvedValue(userFixture({ id: 'u', emailVerifiedAt: new Date() }));
    const res = await request(server()).get('/api/v1/auth/session').set('Cookie', `rj_at=${session.accessToken}`).expect(200);
    expect(res.body.user.emailVerified).toBe(true);
    expect(sessions.isActive).toHaveBeenCalledWith('sid-ok', 'u');
    expect(cookiesOf(res)['rj_csrf']?.value).toBe(res.body.csrfToken);
  });

  it('POST /auth/logout : 204, cookies effacés, nouveau CSRF anonyme', async () => {
    const { token, cookie } = await anonymousCsrf();
    const session = issued('sid-out');
    const res = await request(server())
      .post('/api/v1/auth/logout')
      .set({ Origin: ORIGIN, 'X-CSRF-Token': token, Cookie: `${cookie}; rj_at=${session.accessToken}; rj_rt=r` })
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
    expect(auth.resendVerification).toHaveBeenCalledWith(null, 'a@b.fr');

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
