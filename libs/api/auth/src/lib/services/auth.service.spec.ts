import { JwtService } from '@nestjs/jwt';
import { ApiException, AuthCookies, testConfig } from '@raijin/api-core';
import type { AuthMailService } from '@raijin/api-notifications';
import { Prisma } from '@raijin/api-prisma';
import { createPrismaMock, userFixture } from '../../testing/fixtures';
import { AccessTokenService } from './access-token.service';
import type { AuditService } from '../audit/audit.service';
import type { AuthTokenService } from './auth-token.service';
import { AuthService, NEUTRAL_MESSAGES } from './auth.service';
import { LoginAttemptsService, MemoryAttemptStore } from './login-attempts.service';
import { PasswordService } from './password.service';
import type { SessionService } from './session.service';
import type { TrialEligibilityService } from '../trial/trial-eligibility.service';

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
  const attempts = new LoginAttemptsService(config, new MemoryAttemptStore());
  const trials = { startOnVerification: jest.fn().mockResolvedValue({ kind: 'skipped' }) };
  const service = new AuthService(
    prisma,
    passwords,
    sessions as unknown as SessionService,
    tokens as unknown as AuthTokenService,
    accessTokens,
    mail as unknown as AuthMailService,
    audit as unknown as AuditService,
    attempts,
    trials as unknown as TrialEligibilityService,
    config,
  );
  mock.productEvent.create.mockResolvedValue({});
  return { mock, service, sessions, tokens, mail, audit, accessTokens, passwordHash, config, passwords, attempts, trials };
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

  it('essai démarré dans la transaction de vérification : bienvenue qui annonce l’essai', async () => {
    const { mock, service, tokens, mail, trials, audit } = await setup();
    const endsAt = new Date('2026-11-29T10:00:00Z');
    tokens.consume.mockResolvedValue({ userId: 'u', redirectPath: null });
    mock.user.updateMany.mockResolvedValue({ count: 1 });
    mock.user.findUnique.mockResolvedValue(userFixture({ id: 'u', emailVerifiedAt: new Date() }));
    trials.startOnVerification.mockResolvedValue({ kind: 'started', startedAt: new Date(), endsAt });
    await service.verifyEmail('jeton', client);
    expect(mock.$transaction).toHaveBeenCalledTimes(1);
    expect(trials.startOnVerification).toHaveBeenCalledWith(mock, expect.objectContaining({ id: 'u' }), client, expect.any(Date));
    expect(mail.sendWelcome).toHaveBeenCalledWith('jean.dupont@exemple.fr', { endsAt, days: 7 });
    expect(audit.record).toHaveBeenCalledWith('auth.email_verified', 'u', client, { trial: 'started' });
  });

  it('essai refusé : bienvenue neutre (aucun motif), compte Gratuit', async () => {
    const { mock, service, tokens, mail, trials } = await setup();
    tokens.consume.mockResolvedValue({ userId: 'u', redirectPath: null });
    mock.user.updateMany.mockResolvedValue({ count: 1 });
    mock.user.findUnique.mockResolvedValue(userFixture({ id: 'u', emailVerifiedAt: new Date(), trialStatus: 'INELIGIBLE' }));
    trials.startOnVerification.mockResolvedValue({ kind: 'refused', reason: 'disposable_domain' });
    await service.verifyEmail('jeton', client);
    expect(mail.sendWelcome).toHaveBeenCalledWith('jean.dupont@exemple.fr', null);
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
  const login = (service: AuthService, email: string, password: string) => service.login({ email, password }, client);

  it('identifiants valides : compteur remis à zéro, session émise', async () => {
    const { mock, service, passwordHash, audit, attempts } = await setup();
    const user = userFixture({ passwordHash });
    mock.user.findUnique.mockResolvedValue(user);
    mock.user.update.mockResolvedValue(user);
    await attempts.recordFailure('jean.dupont@exemple.fr');
    const issued = await login(service, 'JEAN.dupont@exemple.fr', PASSWORD);
    expect(issued.sessionId).toBe('sid-new');
    expect(mock.user.findUnique).toHaveBeenCalledWith({ where: { emailNormalized: 'jean.dupont@exemple.fr' } });
    await expect(attempts.isLocked('jean.dupont@exemple.fr')).resolves.toBe(false);
    expect(actions(audit)).toEqual(['auth.login']);
  });

  it('compte inconnu : vérification factice, AUTH_INVALID_CREDENTIALS, échec audité sans utilisateur', async () => {
    const { mock, service, passwords, audit } = await setup();
    const dummy = jest.spyOn(passwords, 'verifyDummy');
    mock.user.findUnique.mockResolvedValue(null);
    await expectApiError(login(service, 'x@y.fr', 'p'), 'AUTH_INVALID_CREDENTIALS', 401);
    expect(dummy).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith('auth.login_failed', null, client);
  });

  it('verrouillage au seuil : même réponse 401 ensuite, même avec le bon mot de passe, argon2 toujours exécuté', async () => {
    const { mock, service, passwordHash, audit, config, passwords } = await setup();
    mock.user.findUnique.mockResolvedValue(userFixture({ passwordHash }));
    for (let i = 0; i < config.auth.lockoutThreshold; i++) {
      await expectApiError(login(service, 'jean.dupont@exemple.fr', 'faux'), 'AUTH_INVALID_CREDENTIALS', 401);
    }
    expect(actions(audit)).toContain('auth.account_locked');
    const verify = jest.spyOn(passwords, 'verify');
    await expectApiError(login(service, 'jean.dupont@exemple.fr', PASSWORD), 'AUTH_INVALID_CREDENTIALS', 401);
    expect(verify).toHaveBeenCalled();
    expect(actions(audit).at(-1)).toBe('auth.login_locked');
    expect(mock.user.update).not.toHaveBeenCalled();
  });

  it('n3 : rafale parallèle de mots de passe, au plus `lockoutThreshold` tentatives évaluées, le bon refusé au-delà', async () => {
    const { mock, service, passwordHash, config, passwords } = await setup();
    const user = userFixture({ passwordHash });
    mock.user.findUnique.mockResolvedValue(user);
    mock.user.update.mockResolvedValue(user);
    const verify = jest.spyOn(passwords, 'verify').mockResolvedValue(false);
    const burst = Array.from({ length: config.auth.lockoutThreshold * 3 }, () => login(service, 'jean.dupont@exemple.fr', 'faux'));
    const results = await Promise.allSettled(burst);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(verify).toHaveBeenCalledTimes(config.auth.lockoutThreshold * 3); // coût argon2 constant, résultat ignoré au-delà
    verify.mockRestore();
    await expectApiError(login(service, 'jean.dupont@exemple.fr', PASSWORD), 'AUTH_INVALID_CREDENTIALS', 401);
    expect(mock.user.update).not.toHaveBeenCalled();
  });

  it('n3 : la tentative est réservée avant la vérification (verrou non lu puis écrit séparément)', async () => {
    const { mock, service, passwordHash, attempts, passwords } = await setup();
    mock.user.findUnique.mockResolvedValue(userFixture({ passwordHash }));
    const order: string[] = [];
    jest.spyOn(attempts, 'reserve').mockImplementation(async () => (order.push('reserve'), { attempt: 1, locked: false, lockedNow: false }));
    jest.spyOn(passwords, 'verify').mockImplementation(async () => (order.push('verify'), false));
    await expectApiError(login(service, 'jean.dupont@exemple.fr', 'faux'), 'AUTH_INVALID_CREDENTIALS', 401);
    expect(order).toEqual(['reserve', 'verify']);
  });

  it('adresse sans compte : verrouillée aussi au seuil (aucune différence observable)', async () => {
    const { mock, service, config, attempts } = await setup();
    mock.user.findUnique.mockResolvedValue(null);
    for (let i = 0; i < config.auth.lockoutThreshold; i++) {
      await expectApiError(login(service, 'fantome@exemple.fr', 'faux'), 'AUTH_INVALID_CREDENTIALS', 401);
    }
    await expect(attempts.isLocked('fantome@exemple.fr')).resolves.toBe(true);
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

  it('refresh sans cookie : UNAUTHORIZED (pas de refresh à tenter) ; utilisateur supprimé : AUTH_SESSION_EXPIRED', async () => {
    const { mock, service, sessions } = await setup();
    await expectApiError(service.refresh(null, client), 'UNAUTHORIZED', 401);
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
    const { mock, service, tokens, sessions, mail, attempts, config } = await setup();
    for (let i = 0; i < config.auth.lockoutThreshold; i++) await attempts.recordFailure('jean.dupont@exemple.fr');
    tokens.consume.mockResolvedValue({ userId: 'u' });
    mock.user.findUnique.mockResolvedValue(userFixture({ id: 'u' }));
    mock.user.update.mockResolvedValue({});
    mock.user.updateMany.mockResolvedValue({ count: 1 });
    await service.resetPassword('jeton', 'nouvelle phrase de passe', client);
    const data = mock.user.update.mock.calls[0][0].data;
    expect(data.passwordHash).toMatch(/^\$argon2id\$/);
    // Adresse non vérifiée : vérifiée par le lien de réinitialisation, avec la même décision d'essai.
    expect(mock.user.updateMany).toHaveBeenCalledWith({ where: { id: 'u', emailVerifiedAt: null }, data: { emailVerifiedAt: expect.any(Date) } });
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith('u', 'password_reset');
    expect(mock.pushSubscription.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u' } });
    expect(tokens.revokeUnused).toHaveBeenCalledWith('u', ['PASSWORD_RESET', 'MAGIC_LINK']);
    expect(mail.sendPasswordChanged).toHaveBeenCalledWith('jean.dupont@exemple.fr');
    await expect(attempts.isLocked('jean.dupont@exemple.fr')).resolves.toBe(false);
  });

  it('confirmation par mot de passe verrouillée : refus même avec le bon mot de passe', async () => {
    const { service, passwordHash, attempts, config, audit } = await setup();
    const user = userFixture({ passwordHash });
    for (let i = 0; i < config.auth.lockoutThreshold; i++) await attempts.recordFailure(user.emailNormalized);
    await expectApiError(service.confirmPassword(user, PASSWORD, client, 'account.delete'), 'AUTH_INVALID_CREDENTIALS', 400);
    expect(audit.record).toHaveBeenLastCalledWith('account.delete_failed', user.id, client, { locked: true });
  });

  it('n3 : confirmation par mot de passe en rafale, le bon mot de passe refusé une fois le seuil dépassé', async () => {
    const { service, passwordHash, config } = await setup();
    const user = userFixture({ passwordHash });
    const burst = Array.from({ length: config.auth.lockoutThreshold + 2 }, () => service.confirmPassword(user, 'faux', client, 'account.delete'));
    expect((await Promise.allSettled(burst)).every((r) => r.status === 'rejected')).toBe(true);
    await expectApiError(service.confirmPassword(user, PASSWORD, client, 'account.delete'), 'AUTH_INVALID_CREDENTIALS', 400);
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
    expect(mock.pushSubscription.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u' } });
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

describe('AuthService — compte suspendu (phase 6 bis)', () => {
  const suspendedAt = new Date('2026-11-20T10:00:00Z');

  it('connexion : identifiants valides → 403 ACCOUNT_SUSPENDED, aucune session, audité', async () => {
    const { mock, service, passwordHash, sessions, audit } = await setup();
    mock.user.findUnique.mockResolvedValue(userFixture({ passwordHash, suspendedAt }));
    await expectApiError(service.login({ email: 'jean.dupont@exemple.fr', password: PASSWORD }, client), 'ACCOUNT_SUSPENDED', 403);
    expect(sessions.create).not.toHaveBeenCalled();
    expect(actions(audit)).toContain('auth.login_suspended');
  });

  it('connexion : mauvais mot de passe d’un compte suspendu → même 401 qu’ailleurs (pas d’énumération)', async () => {
    const { mock, service, passwordHash } = await setup();
    mock.user.findUnique.mockResolvedValue(userFixture({ passwordHash, suspendedAt }));
    await expectApiError(service.login({ email: 'jean.dupont@exemple.fr', password: 'mauvais mot de passe' }, client), 'AUTH_INVALID_CREDENTIALS', 401);
  });

  it('lien magique et vérification d’e-mail : 403 après un jeton valide, aucune session', async () => {
    const { mock, service, tokens, sessions } = await setup();
    tokens.consume.mockResolvedValue({ userId: 'u', redirectPath: null });
    mock.user.updateMany.mockResolvedValue({ count: 0 });
    mock.user.findUnique.mockResolvedValue(userFixture({ id: 'u', emailVerifiedAt: suspendedAt, suspendedAt }));
    await expectApiError(service.verifyMagicLink('jeton', client), 'ACCOUNT_SUSPENDED', 403);
    await expectApiError(service.verifyEmail('jeton', client), 'ACCOUNT_SUSPENDED', 403);
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('refresh : compte suspendu → session révoquée, 403', async () => {
    const { mock, service, sessions } = await setup();
    sessions.rotate.mockResolvedValue({ session: { id: 'sid-1', userId: 'u' }, refreshToken: 'r2' });
    mock.user.findUnique.mockResolvedValue(userFixture({ id: 'u', suspendedAt }));
    await expectApiError(service.refresh('r1', client), 'ACCOUNT_SUSPENDED', 403);
    expect(sessions.revoke).toHaveBeenCalledWith('sid-1', 'suspended');
  });
});
