import { JwtService } from '@nestjs/jwt';
import { ApiException, AuthCookies, testConfig } from '@raijin/api-core';
import type { AuthMailService } from '@raijin/api-notifications';
import { Prisma } from '@raijin/api-prisma';
import { createPrismaMock, userFixture } from '../../testing/fixtures';
import { AccessTokenService } from './access-token.service';
import type { AuditService } from './audit.service';
import type { AuthTokenService } from './auth-token.service';
import { AuthService, NEUTRAL_MESSAGES } from './auth.service';
import { PasswordService } from './password.service';
import type { SessionService } from './session.service';

const client = { ip: '198.51.100.1', userAgent: 'jest' };
const PASSWORD = 'une phrase de passe solide';

async function expectApiError(promise: Promise<unknown>, code: string, status: number) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiException);
  expect((error as ApiException).code).toBe(code);
  expect((error as ApiException).getStatus()).toBe(status);
}

async function setup() {
  const { mock, prisma } = createPrismaMock();
  const config = testConfig();
  const passwords = new PasswordService();
  const passwordHash = await passwords.hash(PASSWORD);
  const sessions = {
    create: jest.fn().mockResolvedValue({ session: { id: 'sid-new', userId: 'u' }, refreshToken: 'refresh-new' }),
    rotate: jest.fn(),
    revoke: jest.fn(),
    revokeAllForUser: jest.fn().mockResolvedValue(2),
    sessionIdForRefresh: jest.fn(),
  };
  const tokens = {
    issue: jest.fn().mockResolvedValue('jeton-opaque'),
    consume: jest.fn(),
    revokeUnused: jest.fn(),
  };
  const mail = {
    sendEmailVerification: jest.fn().mockResolvedValue(undefined),
    sendAccountExists: jest.fn().mockResolvedValue(undefined),
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendMagicLink: jest.fn().mockResolvedValue(undefined),
    sendPasswordReset: jest.fn().mockResolvedValue(undefined),
    sendPasswordChanged: jest.fn().mockResolvedValue(undefined),
  };
  const audit = { record: jest.fn(), hashIp: jest.fn() };
  const accessTokens = new AccessTokenService(new JwtService({}), new AuthCookies(config), config);
  const service = new AuthService(
    prisma,
    passwords,
    sessions as unknown as SessionService,
    tokens as unknown as AuthTokenService,
    accessTokens,
    mail as unknown as AuthMailService,
    audit as unknown as AuditService,
    config,
  );
  mock.productEvent.create.mockResolvedValue({});
  return { mock, service, sessions, tokens, mail, audit, accessTokens, passwordHash, config, passwords };
}

const actions = (audit: { record: jest.Mock }) => audit.record.mock.calls.map((call) => call[0]);

describe('AuthService.register', () => {
  const input = {
    email: 'jean.dupont+raijin@gmail.com',
    password: PASSWORD,
    acceptTerms: true as const,
    attribution: { utmSource: 'twitter', landingPath: '/guides/rug-pull' },
  };

  it('crée le compte (argon2id, e-mail normalisé, attribution) et envoie la vérification', async () => {
    const { mock, service, tokens, mail, audit } = await setup();
    mock.user.findUnique.mockResolvedValue(null);
    mock.user.create.mockImplementation(async ({ data }) => userFixture({ ...data, id: 'u-new' }));
    await expect(service.register(input, client)).resolves.toBe(NEUTRAL_MESSAGES.register);
    const data = mock.user.create.mock.calls[0][0].data;
    expect(data.email).toBe('jean.dupont+raijin@gmail.com');
    expect(data.emailNormalized).toBe('jeandupont@gmail.com');
    expect(data.passwordHash).toMatch(/^\$argon2id\$/);
    expect(data.utmSource).toBe('twitter');
    expect(data.landingPath).toBe('/guides/rug-pull');
    expect(data.termsAcceptedAt).toBeInstanceOf(Date);
    expect(tokens.issue).toHaveBeenCalledWith('u-new', 'EMAIL_VERIFY', 86_400_000);
    expect(mail.sendEmailVerification).toHaveBeenCalledWith(data.email, 'jeton-opaque');
    expect(mock.productEvent.create).toHaveBeenCalledWith({ data: { userId: 'u-new', type: 'signup' } });
    expect(actions(audit)).toEqual(['auth.register']);
  });

  it('adresse déjà vérifiée : même réponse, e-mail « compte existant » au titulaire, aucun compte créé', async () => {
    const { mock, service, mail } = await setup();
    mock.user.findUnique.mockResolvedValue(userFixture({ emailVerifiedAt: new Date() }));
    await expect(service.register(input, client)).resolves.toBe(NEUTRAL_MESSAGES.register);
    expect(mock.user.create).not.toHaveBeenCalled();
    expect(mail.sendAccountExists).toHaveBeenCalledWith('jean.dupont@exemple.fr');
  });

  it('adresse existante non vérifiée : renvoi de la vérification, même réponse', async () => {
    const { mock, service, mail, tokens } = await setup();
    mock.user.findUnique.mockResolvedValue(userFixture());
    await expect(service.register(input, client)).resolves.toBe(NEUTRAL_MESSAGES.register);
    expect(tokens.issue).toHaveBeenCalled();
    expect(mail.sendEmailVerification).toHaveBeenCalledWith('jean.dupont@exemple.fr', 'jeton-opaque');
  });

  it('course sur l’unicité (P2002) : réponse neutre', async () => {
    const { mock, service } = await setup();
    mock.user.findUnique.mockResolvedValue(null);
    mock.user.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' }),
    );
    await expect(service.register(input, client)).resolves.toBe(NEUTRAL_MESSAGES.register);
  });

  it('autre erreur de base : propagée', async () => {
    const { mock, service } = await setup();
    mock.user.findUnique.mockResolvedValue(null);
    mock.user.create.mockRejectedValue(new Error('panne'));
    await expect(service.register(input, client)).rejects.toThrow('panne');
  });

  it('mot de passe identique à l’e-mail : AUTH_PASSWORD_REJECTED', async () => {
    const { service } = await setup();
    await expectApiError(
      service.register({ ...input, email: 'jean.dupont.long@exemple.fr', password: 'jean.dupont.long@exemple.fr' }, client),
      'AUTH_PASSWORD_REJECTED',
      400,
    );
  });

  it('un échec d’envoi d’e-mail ne casse pas la réponse', async () => {
    const { mock, service, mail } = await setup();
    mock.user.findUnique.mockResolvedValue(null);
    mock.user.create.mockImplementation(async ({ data }) => userFixture(data));
    mail.sendEmailVerification.mockRejectedValue(new Error('SMTP indisponible'));
    await expect(service.register(input, client)).resolves.toBe(NEUTRAL_MESSAGES.register);
  });
});

describe('AuthService.verifyEmail / resendVerification', () => {
  it('jeton valide : e-mail vérifié, bienvenue, session ouverte', async () => {
    const { mock, service, tokens, mail, sessions } = await setup();
    tokens.consume.mockResolvedValue({ userId: 'u', redirectPath: null });
    mock.user.updateMany.mockResolvedValue({ count: 1 });
    mock.user.findUnique.mockResolvedValue(userFixture({ id: 'u', emailVerifiedAt: new Date() }));
    const issued = await service.verifyEmail('jeton', client);
    expect(issued.sessionId).toBe('sid-new');
    expect(issued.refreshToken).toBe('refresh-new');
    expect(issued.accessToken.split('.')).toHaveLength(3);
    expect(mail.sendWelcome).toHaveBeenCalledWith('jean.dupont@exemple.fr', null);
    expect(tokens.revokeUnused).toHaveBeenCalledWith('u', ['EMAIL_VERIFY']);
    expect(sessions.create).toHaveBeenCalledWith('u', client);
  });

  it('déjà vérifié : pas de second e-mail de bienvenue', async () => {
    const { mock, service, tokens, mail } = await setup();
    tokens.consume.mockResolvedValue({ userId: 'u' });
    mock.user.updateMany.mockResolvedValue({ count: 0 });
    mock.user.findUnique.mockResolvedValue(userFixture({ id: 'u', emailVerifiedAt: new Date() }));
    await service.verifyEmail('jeton', client);
    expect(mail.sendWelcome).not.toHaveBeenCalled();
  });

  it('jeton invalide : AUTH_TOKEN_INVALID ; utilisateur disparu : idem', async () => {
    const { mock, service, tokens } = await setup();
    tokens.consume.mockResolvedValue(null);
    await expectApiError(service.verifyEmail('x', client), 'AUTH_TOKEN_INVALID', 400);
    tokens.consume.mockResolvedValue({ userId: 'u' });
    mock.user.updateMany.mockResolvedValue({ count: 0 });
    mock.user.findUnique.mockResolvedValue(null);
    await expectApiError(service.verifyEmail('x', client), 'AUTH_TOKEN_INVALID', 400);
  });

  it('renvoi : par session ou par e-mail, seulement si non vérifié, réponse neutre', async () => {
    const { mock, service, mail } = await setup();
    mock.user.findUnique.mockResolvedValueOnce(userFixture());
    await expect(service.resendVerification('u', undefined)).resolves.toBe(NEUTRAL_MESSAGES.resend);
    expect(mock.user.findUnique).toHaveBeenLastCalledWith({ where: { id: 'u' } });
    mock.user.findUnique.mockResolvedValueOnce(userFixture({ emailVerifiedAt: new Date() }));
    await service.resendVerification(null, 'Jean.Dupont@exemple.fr');
    expect(mock.user.findUnique).toHaveBeenLastCalledWith({ where: { emailNormalized: 'jean.dupont@exemple.fr' } });
    await expect(service.resendVerification(null, undefined)).resolves.toBe(NEUTRAL_MESSAGES.resend);
    expect(mail.sendEmailVerification).toHaveBeenCalledTimes(1);
  });
});

describe('AuthService.login', () => {
  it('identifiants valides : compteur remis à zéro, session émise', async () => {
    const { mock, service, passwordHash, audit } = await setup();
    const user = userFixture({ passwordHash, failedLoginCount: 2 });
    mock.user.findUnique.mockResolvedValue(user);
    mock.user.update.mockResolvedValue({ ...user, failedLoginCount: 0 });
    const issued = await service.login({ email: 'JEAN.dupont@exemple.fr', password: PASSWORD }, client);
    expect(issued.user.failedLoginCount).toBe(0);
    expect(mock.user.findUnique).toHaveBeenCalledWith({ where: { emailNormalized: 'jean.dupont@exemple.fr' } });
    expect(mock.user.update.mock.calls[0][0].data).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
    expect(actions(audit)).toEqual(['auth.login']);
  });

  it('compte inconnu : vérification factice puis AUTH_INVALID_CREDENTIALS', async () => {
    const { mock, service, passwords } = await setup();
    const dummy = jest.spyOn(passwords, 'verifyDummy');
    mock.user.findUnique.mockResolvedValue(null);
    await expectApiError(service.login({ email: 'x@y.fr', password: 'p' }, client), 'AUTH_INVALID_CREDENTIALS', 401);
    expect(dummy).toHaveBeenCalled();
  });

  it('mauvais mot de passe : échec compté, verrouillage au seuil', async () => {
    const { mock, service, passwordHash, audit, config } = await setup();
    mock.user.findUnique.mockResolvedValue(userFixture({ passwordHash }));
    mock.user.update.mockResolvedValueOnce({ failedLoginCount: 1 });
    await expectApiError(service.login({ email: 'jean.dupont@exemple.fr', password: 'faux' }, client), 'AUTH_INVALID_CREDENTIALS', 401);
    expect(actions(audit)).toEqual(['auth.login_failed']);

    mock.user.update.mockResolvedValueOnce({ failedLoginCount: config.auth.lockoutThreshold }).mockResolvedValueOnce({});
    await expectApiError(service.login({ email: 'jean.dupont@exemple.fr', password: 'faux' }, client), 'AUTH_INVALID_CREDENTIALS', 401);
    const lock = mock.user.update.mock.calls.at(-1)?.[0].data;
    expect(lock.failedLoginCount).toBe(0);
    expect(lock.lockedUntil.getTime()).toBeGreaterThan(Date.now());
    expect(actions(audit)).toContain('auth.account_locked');
  });

  it('compte verrouillé : AUTH_ACCOUNT_LOCKED sans vérifier le mot de passe', async () => {
    const { mock, service, passwords } = await setup();
    const verify = jest.spyOn(passwords, 'verify');
    mock.user.findUnique.mockResolvedValue(userFixture({ lockedUntil: new Date(Date.now() + 60_000) }));
    await expectApiError(service.login({ email: 'jean.dupont@exemple.fr', password: PASSWORD }, client), 'AUTH_ACCOUNT_LOCKED', 429);
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('AuthService sessions', () => {
  it('refresh : rotation puis nouveau JWT sur la même session', async () => {
    const { mock, service, sessions } = await setup();
    sessions.rotate.mockResolvedValue({ session: { id: 'sid-1', userId: 'u' }, refreshToken: 'r2' });
    mock.user.findUnique.mockResolvedValue(userFixture({ id: 'u', role: 'ADMIN' }));
    const issued = await service.refresh('r1', client);
    expect(issued.sessionId).toBe('sid-1');
    expect(issued.refreshToken).toBe('r2');
  });

  it('refresh sans cookie ou utilisateur supprimé : AUTH_SESSION_EXPIRED', async () => {
    const { mock, service, sessions } = await setup();
    await expectApiError(service.refresh(null, client), 'AUTH_SESSION_EXPIRED', 401);
    sessions.rotate.mockResolvedValue({ session: { id: 'sid-1', userId: 'u' }, refreshToken: 'r2' });
    mock.user.findUnique.mockResolvedValue(null);
    await expectApiError(service.refresh('r1', client), 'AUTH_SESSION_EXPIRED', 401);
  });

  it('logout : par sid, par refresh, ou sans rien (idempotent)', async () => {
    const { mock, service, sessions, audit } = await setup();
    mock.session.findUnique.mockResolvedValue({ userId: 'u' });
    await service.logout('sid-1', null, client);
    expect(sessions.revoke).toHaveBeenCalledWith('sid-1', 'logout');
    sessions.sessionIdForRefresh.mockResolvedValue('sid-2');
    await service.logout(null, 'r', client);
    expect(sessions.revoke).toHaveBeenLastCalledWith('sid-2', 'logout');
    sessions.sessionIdForRefresh.mockResolvedValue(null);
    await service.logout(null, 'r', client);
    await service.logout(null, null, client);
    expect(sessions.revoke).toHaveBeenCalledTimes(2);
    mock.session.findUnique.mockResolvedValue(null);
    await service.logout('sid-3', null, client);
    expect(audit.record).toHaveBeenLastCalledWith('auth.logout', null, client);
  });

  it('currentUser : utilisateur absent → AUTH_SESSION_EXPIRED', async () => {
    const { mock, service } = await setup();
    mock.user.findUnique.mockResolvedValue(null);
    await expectApiError(service.currentUser('u'), 'AUTH_SESSION_EXPIRED', 401);
  });
});

describe('AuthService lien magique', () => {
  it('demande : jeton avec page de retour si le compte existe, réponse neutre sinon', async () => {
    const { mock, service, tokens, mail } = await setup();
    mock.user.findUnique.mockResolvedValueOnce(userFixture({ id: 'u' }));
    await expect(service.requestMagicLink({ email: 'jean.dupont@exemple.fr', redirectPath: '/suivis' }, client)).resolves.toBe(
      NEUTRAL_MESSAGES.magicLink,
    );
    expect(tokens.issue).toHaveBeenCalledWith('u', 'MAGIC_LINK', 900_000, '/suivis');
    expect(mail.sendMagicLink).toHaveBeenCalled();
    mock.user.findUnique.mockResolvedValueOnce(null);
    await expect(service.requestMagicLink({ email: 'inconnu@exemple.fr' }, client)).resolves.toBe(NEUTRAL_MESSAGES.magicLink);
    expect(mail.sendMagicLink).toHaveBeenCalledTimes(1);
  });

  it('vérification : session + page de retour, e-mail vérifié du même coup', async () => {
    const { mock, service, tokens } = await setup();
    tokens.consume.mockResolvedValue({ userId: 'u', redirectPath: '/alertes' });
    mock.user.updateMany.mockResolvedValue({ count: 1 });
    mock.user.findUnique.mockResolvedValue(userFixture({ id: 'u' }));
    mock.user.update.mockResolvedValue(userFixture({ id: 'u', emailVerifiedAt: new Date() }));
    const issued = await service.verifyMagicLink('jeton', client);
    expect(issued.redirectPath).toBe('/alertes');
    expect(issued.sessionId).toBe('sid-new');
    tokens.consume.mockResolvedValue(null);
    await expectApiError(service.verifyMagicLink('jeton', client), 'AUTH_TOKEN_INVALID', 400);
  });
});

describe('AuthService mots de passe', () => {
  it('oubli : jeton envoyé si le compte existe, réponse neutre dans tous les cas', async () => {
    const { mock, service, tokens, mail } = await setup();
    mock.user.findUnique.mockResolvedValueOnce(userFixture({ id: 'u' }));
    await expect(service.forgotPassword('jean.dupont@exemple.fr', client)).resolves.toBe(NEUTRAL_MESSAGES.forgot);
    expect(tokens.issue).toHaveBeenCalledWith('u', 'PASSWORD_RESET', 1_800_000);
    mock.user.findUnique.mockResolvedValueOnce(null);
    await expect(service.forgotPassword('inconnu@exemple.fr', client)).resolves.toBe(NEUTRAL_MESSAGES.forgot);
    expect(mail.sendPasswordReset).toHaveBeenCalledTimes(1);
  });

  it('réinitialisation : nouveau hash, déverrouillage, toutes les sessions révoquées, avis envoyé', async () => {
    const { mock, service, tokens, sessions, mail } = await setup();
    tokens.consume.mockResolvedValue({ userId: 'u' });
    mock.user.findUnique.mockResolvedValue(userFixture({ id: 'u', lockedUntil: new Date(Date.now() + 1000) }));
    mock.user.update.mockResolvedValue({});
    await service.resetPassword('jeton', 'nouvelle phrase de passe', client);
    const data = mock.user.update.mock.calls[0][0].data;
    expect(data.passwordHash).toMatch(/^\$argon2id\$/);
    expect(data).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
    expect(data.emailVerifiedAt).toBeInstanceOf(Date);
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith('u', 'password_reset');
    expect(tokens.revokeUnused).toHaveBeenCalledWith('u', ['PASSWORD_RESET', 'MAGIC_LINK']);
    expect(mail.sendPasswordChanged).toHaveBeenCalledWith('jean.dupont@exemple.fr');
  });

  it('réinitialisation refusée : jeton invalide, utilisateur disparu, mot de passe = e-mail', async () => {
    const { mock, service, tokens } = await setup();
    tokens.consume.mockResolvedValueOnce(null);
    await expectApiError(service.resetPassword('x', 'nouvelle phrase', client), 'AUTH_TOKEN_INVALID', 400);
    tokens.consume.mockResolvedValueOnce({ userId: 'u' });
    mock.user.findUnique.mockResolvedValueOnce(null);
    await expectApiError(service.resetPassword('x', 'nouvelle phrase', client), 'AUTH_TOKEN_INVALID', 400);
    tokens.consume.mockResolvedValueOnce({ userId: 'u' });
    mock.user.findUnique.mockResolvedValueOnce(userFixture());
    await expectApiError(service.resetPassword('x', 'jean.dupont@exemple.fr', client), 'AUTH_PASSWORD_REJECTED', 400);
  });

  it('changement : mot de passe actuel exigé, autres sessions révoquées', async () => {
    const { mock, service, passwordHash, sessions, audit } = await setup();
    mock.user.findUnique.mockResolvedValue(userFixture({ id: 'u', passwordHash }));
    mock.user.update.mockResolvedValue({});
    await service.changePassword('u', 'sid-courante', { currentPassword: PASSWORD, newPassword: 'toute nouvelle phrase' }, client);
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith('u', 'password_change', 'sid-courante');
    expect(actions(audit)).toContain('auth.password_changed');
  });

  it('changement refusé : mot de passe actuel faux, nouveau = e-mail', async () => {
    const { mock, service, passwordHash, audit } = await setup();
    mock.user.findUnique.mockResolvedValue(userFixture({ id: 'u', passwordHash }));
    await expectApiError(
      service.changePassword('u', 's', { currentPassword: 'faux', newPassword: 'toute nouvelle phrase' }, client),
      'AUTH_INVALID_CREDENTIALS',
      400,
    );
    expect(actions(audit)).toContain('auth.password_change_failed');
    await expectApiError(
      service.changePassword('u', 's', { currentPassword: PASSWORD, newPassword: 'jean.dupont@exemple.fr' }, client),
      'AUTH_PASSWORD_REJECTED',
      400,
    );
  });
});
