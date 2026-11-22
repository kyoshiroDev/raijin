import { ApiException, sha256, testConfig } from '@raijin/api-core';
import { createPrismaMock } from '../../testing/fixtures';
import { AuditService } from './audit.service';
import { AuthTokenService } from './auth-token.service';
import { REFRESH_REUSE_GRACE_MS, SessionService } from './session.service';

const client = { ip: '203.0.113.7', userAgent: 'jest' };

function setup() {
  const { mock, prisma } = createPrismaMock();
  const config = testConfig();
  const audit = new AuditService(prisma, config);
  const sessions = new SessionService(prisma, audit, config);
  return { mock, prisma, config, audit, sessions };
}

const future = () => new Date(Date.now() + 60_000);

describe('SessionService', () => {
  it('crée une session et un refresh opaque stocké haché', async () => {
    const { mock, sessions } = setup();
    mock.session.create.mockImplementation(async ({ data }) => ({ id: 'sid-1', ...data }));
    const { session, refreshToken } = await sessions.create('user-1', client);
    expect(session.id).toBe('sid-1');
    expect(refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const data = mock.session.create.mock.calls[0][0].data;
    expect(data.refreshTokens.create.tokenHash).toBe(sha256(refreshToken));
    expect(JSON.stringify(data)).not.toContain(refreshToken);
    expect(data.ipHash).not.toContain('203.0.113.7');
  });

  it('rotation : marque l’ancien utilisé et émet un nouveau jeton sur la même session', async () => {
    const { mock, sessions } = setup();
    mock.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-1',
      sessionId: 'sid-1',
      usedAt: null,
      expiresAt: future(),
      session: { id: 'sid-1', userId: 'user-1', revokedAt: null, expiresAt: future(), userAgent: 'old' },
    });
    mock.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    mock.refreshToken.create.mockResolvedValue({});
    mock.session.update.mockResolvedValue({ id: 'sid-1', userId: 'user-1' });
    const result = await sessions.rotate('ancien', client);
    expect(result.session.id).toBe('sid-1');
    expect(mock.refreshToken.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { tokenHash: sha256('ancien') } }));
    expect(mock.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'rt-1', usedAt: null } }),
    );
    expect(mock.refreshToken.create.mock.calls[0][0].data.tokenHash).toBe(sha256(result.refreshToken));
  });

  async function expectExpired(promise: Promise<unknown>) {
    await expect(promise).rejects.toBeInstanceOf(ApiException);
    await promise.catch((error: ApiException) => {
      expect(error.code).toBe('AUTH_SESSION_EXPIRED');
      expect(error.getStatus()).toBe(401);
    });
  }

  it('refresh inconnu → AUTH_SESSION_EXPIRED', async () => {
    const { mock, sessions } = setup();
    mock.refreshToken.findUnique.mockResolvedValue(null);
    await expectExpired(sessions.rotate('inconnu', client));
  });

  it('réutilisation d’un refresh déjà utilisé (hors délai de grâce) → famille révoquée + audit', async () => {
    const { mock, sessions } = setup();
    mock.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-1',
      sessionId: 'sid-1',
      usedAt: new Date(Date.now() - REFRESH_REUSE_GRACE_MS - 1000),
      expiresAt: future(),
      session: { id: 'sid-1', userId: 'user-1', revokedAt: null, expiresAt: future() },
    });
    mock.session.updateMany.mockResolvedValue({ count: 1 });
    mock.auditLog.create.mockResolvedValue({});
    await expectExpired(sessions.rotate('vole', client));
    expect(mock.session.updateMany).toHaveBeenCalledWith({
      where: { id: 'sid-1', revokedAt: null },
      data: expect.objectContaining({ revokedReason: 'reuse' }),
    });
    expect(mock.auditLog.create.mock.calls[0][0].data.action).toBe('auth.refresh_reuse_detected');
  });

  it('réutilisation dans le délai de grâce (onglets concurrents) → 409 CONFLICT sans révocation', async () => {
    const { mock, sessions } = setup();
    mock.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-1',
      sessionId: 'sid-1',
      usedAt: new Date(),
      expiresAt: future(),
      session: { id: 'sid-1', userId: 'user-1', revokedAt: null, expiresAt: future() },
    });
    await expect(sessions.rotate('concurrent', client)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mock.session.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['refresh expiré', { expiresAt: new Date(Date.now() - 1) }, {}],
    ['session révoquée', {}, { revokedAt: new Date() }],
    ['session expirée', {}, { expiresAt: new Date(Date.now() - 1) }],
  ])('%s → AUTH_SESSION_EXPIRED', async (_label, token, session) => {
    const { mock, sessions } = setup();
    mock.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-1',
      sessionId: 'sid-1',
      usedAt: null,
      expiresAt: future(),
      ...token,
      session: { id: 'sid-1', userId: 'user-1', revokedAt: null, expiresAt: future(), ...session },
    });
    await expectExpired(sessions.rotate('x', client));
  });

  it('course : un autre appel a consommé le jeton entre-temps → refus', async () => {
    const { mock, sessions } = setup();
    mock.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-1',
      sessionId: 'sid-1',
      usedAt: null,
      expiresAt: future(),
      session: { id: 'sid-1', userId: 'user-1', revokedAt: null, expiresAt: future() },
    });
    mock.refreshToken.updateMany.mockResolvedValue({ count: 0 });
    await expectExpired(sessions.rotate('x', client));
  });

  it('isActive, sessionIdForRefresh, revoke, revokeAllForUser', async () => {
    const { mock, sessions } = setup();
    mock.session.findUnique.mockResolvedValueOnce({ userId: 'u', revokedAt: null, expiresAt: future() });
    await expect(sessions.isActive('sid', 'u')).resolves.toBe(true);
    mock.session.findUnique.mockResolvedValueOnce({ userId: 'autre', revokedAt: null, expiresAt: future() });
    await expect(sessions.isActive('sid', 'u')).resolves.toBe(false);
    mock.session.findUnique.mockResolvedValueOnce({ userId: 'u', revokedAt: new Date(), expiresAt: future() });
    await expect(sessions.isActive('sid', 'u')).resolves.toBe(false);
    mock.session.findUnique.mockResolvedValueOnce(null);
    await expect(sessions.isActive('sid', 'u')).resolves.toBe(false);

    mock.refreshToken.findUnique.mockResolvedValueOnce({ sessionId: 'sid-9' });
    await expect(sessions.sessionIdForRefresh('r')).resolves.toBe('sid-9');
    mock.refreshToken.findUnique.mockResolvedValueOnce(null);
    await expect(sessions.sessionIdForRefresh('r')).resolves.toBeNull();

    mock.session.updateMany.mockResolvedValue({ count: 3 });
    await expect(sessions.revokeAllForUser('u', 'password_change', 'sid-keep')).resolves.toBe(3);
    expect(mock.session.updateMany).toHaveBeenLastCalledWith({
      where: { userId: 'u', revokedAt: null, id: { not: 'sid-keep' } },
      data: expect.objectContaining({ revokedReason: 'password_change' }),
    });
    expect(mock.pushSubscription.deleteMany).toHaveBeenLastCalledWith({ where: { userId: 'u' } });
    await sessions.revokeAllForUser('u', 'password_reset');
    expect(mock.session.updateMany.mock.calls.at(-1)?.[0].where).toEqual({ userId: 'u', revokedAt: null });
    expect(mock.pushSubscription.deleteMany).toHaveBeenCalledTimes(2);
  });
});

describe('AuthTokenService', () => {
  it('émet un jeton haché en invalidant les précédents du même type', async () => {
    const { mock, prisma } = createPrismaMock();
    const tokens = new AuthTokenService(prisma);
    mock.authToken.deleteMany.mockResolvedValue({ count: 1 });
    mock.authToken.create.mockResolvedValue({});
    const token = await tokens.issue('u', 'MAGIC_LINK', 900_000, '/suivis');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mock.authToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u', type: 'MAGIC_LINK', usedAt: null } });
    const data = mock.authToken.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ userId: 'u', type: 'MAGIC_LINK', tokenHash: sha256(token), redirectPath: '/suivis' });
  });

  it('consomme une seule fois un jeton valide du bon type', async () => {
    const { mock, prisma } = createPrismaMock();
    const tokens = new AuthTokenService(prisma);
    const record = { id: 't1', userId: 'u', type: 'EMAIL_VERIFY', usedAt: null, expiresAt: future() };
    mock.authToken.findUnique.mockResolvedValue(record);
    mock.authToken.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await expect(tokens.consume('jeton', 'EMAIL_VERIFY')).resolves.toMatchObject({ id: 't1' });
    await expect(tokens.consume('jeton', 'EMAIL_VERIFY')).resolves.toBeNull();
  });

  it.each([
    ['inconnu', null],
    ['autre type', { id: 't', type: 'PASSWORD_RESET', usedAt: null, expiresAt: future() }],
    ['déjà utilisé', { id: 't', type: 'EMAIL_VERIFY', usedAt: new Date(), expiresAt: future() }],
    ['expiré', { id: 't', type: 'EMAIL_VERIFY', usedAt: null, expiresAt: new Date(Date.now() - 1) }],
  ])('refuse un jeton %s', async (_label, record) => {
    const { mock, prisma } = createPrismaMock();
    mock.authToken.findUnique.mockResolvedValue(record);
    await expect(new AuthTokenService(prisma).consume('x', 'EMAIL_VERIFY')).resolves.toBeNull();
    expect(mock.authToken.updateMany).not.toHaveBeenCalled();
  });

  it('revokeUnused', async () => {
    const { mock, prisma } = createPrismaMock();
    await new AuthTokenService(prisma).revokeUnused('u', ['PASSWORD_RESET', 'MAGIC_LINK']);
    expect(mock.authToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u', type: { in: ['PASSWORD_RESET', 'MAGIC_LINK'] }, usedAt: null },
    });
  });
});

describe('AuditService', () => {
  it('enregistre sans IP en clair et n’échoue jamais', async () => {
    const { mock, audit } = setup();
    mock.auditLog.create.mockResolvedValueOnce({});
    await audit.record('auth.login', 'u', client, { method: 'password' });
    const data = mock.auditLog.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ action: 'auth.login', userId: 'u', userAgent: 'jest', metadata: { method: 'password' } });
    expect(data.ipHash).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(data.ipHash).not.toContain('203.0.113.7');
    mock.auditLog.create.mockRejectedValueOnce(new Error('base indisponible'));
    await expect(audit.record('auth.logout', null, null)).resolves.toBeUndefined();
    expect(audit.hashIp(null)).toBeNull();
  });
});
