import { JwtService } from '@nestjs/jwt';
import { AuthCookies, testConfig } from '@raijin/api-core';
import type { Request } from 'express';
import { userFixture } from '../../testing/fixtures';
import { AccessTokenService } from './access-token.service';
import { clientInfoFromRequest } from './client-info';
import { normalizeEmail } from './email-normalizer';
import { PasswordService } from './password.service';
import { toPublicUser } from './public-user';

describe('normalizeEmail', () => {
  it.each([
    ['Jean.Dupont@Exemple.FR', 'jean.dupont@exemple.fr'],
    ['  jean+promo@exemple.fr ', 'jean@exemple.fr'],
    ['j.e.a.n+raijin@gmail.com', 'jean@gmail.com'],
    ['J.Ean@GoogleMail.com', 'jean@gmail.com'],
    ['+alias@exemple.fr', '+alias@exemple.fr'],
    ['pas-un-email', 'pas-un-email'],
    ['fin@', 'fin@'],
  ])('%s → %s', (input, expected) => expect(normalizeEmail(input)).toBe(expected));
});

describe('PasswordService', () => {
  const passwords = new PasswordService();

  it('hache en argon2id et vérifie', async () => {
    const hash = await passwords.hash('une phrase de passe correcte');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    await expect(passwords.verify(hash, 'une phrase de passe correcte')).resolves.toBe(true);
    await expect(passwords.verify(hash, 'mauvaise')).resolves.toBe(false);
    await expect(passwords.verify('hash-invalide', 'x')).resolves.toBe(false);
  });

  it('vérification factice sans erreur (anti-énumération par le temps)', async () => {
    await expect(passwords.verifyDummy('nimporte quoi')).resolves.toBeUndefined();
    await expect(passwords.verifyDummy('encore')).resolves.toBeUndefined();
  });

  it('refuse un mot de passe égal à l’e-mail ou à sa partie locale', () => {
    expect(passwords.isRejected('Jean.Dupont@exemple.fr', 'jean.dupont@exemple.fr')).toBe(true);
    expect(passwords.isRejected('jean.dupont', 'jean.dupont@exemple.fr')).toBe(true);
    expect(passwords.isRejected('une autre phrase', 'jean.dupont@exemple.fr')).toBe(false);
  });
});

describe('AccessTokenService', () => {
  const config = testConfig();
  const cookies = new AuthCookies(config);
  const service = new AccessTokenService(new JwtService({}), cookies, config);
  const payload = { sub: 'user-1', sid: 'session-1', role: 'USER' as const };
  const reqWith = (token?: string) => ({ cookies: token ? { rj_at: token } : {} }) as unknown as Request;

  it('signe un JWT HS256 court et le relit', () => {
    const { token, expiresAt } = service.sign(payload);
    expect(token.split('.')).toHaveLength(3);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 1000);
    expect(service.verify(token)).toMatchObject(payload);
    expect(service.fromRequest(reqWith(token))).toMatchObject(payload);
    expect(service.readSessionId(reqWith(token))).toBe('session-1');
  });

  it('refuse signature, algorithme, émetteur ou contenu invalides', () => {
    const other = new AccessTokenService(new JwtService({}), cookies, testConfig({ JWT_ACCESS_SECRET: 'b'.repeat(48) }));
    expect(service.verify(other.sign(payload).token)).toBeNull();
    const jwt = new JwtService({});
    const secret = config.auth.accessSecret;
    expect(service.verify(jwt.sign({ sub: 'u', sid: 's', role: 'USER' }, { secret, algorithm: 'HS512', issuer: 'raijin-api', audience: 'raijin-app' }))).toBeNull();
    expect(service.verify(jwt.sign({ sub: 'u', sid: 's', role: 'USER' }, { secret, issuer: 'autre', audience: 'raijin-app' }))).toBeNull();
    expect(service.verify(jwt.sign({ sub: 'u', sid: 's', role: 'ROOT' }, { secret, issuer: 'raijin-api', audience: 'raijin-app' }))).toBeNull();
    expect(service.verify(jwt.sign({ sub: 'u', role: 'USER' }, { secret, issuer: 'raijin-api', audience: 'raijin-app' }))).toBeNull();
    expect(service.verify('abc')).toBeNull();
    expect(service.fromRequest(reqWith())).toBeNull();
    expect(service.readSessionId(reqWith())).toBeNull();
  });

  it('jeton expiré : refusé pour l’accès, mais son sid reste lisible (CSRF, refresh)', () => {
    const jwt = new JwtService({});
    const expired = jwt.sign(
      { sub: 'u', sid: 'sid-exp', role: 'USER', exp: Math.floor(Date.now() / 1000) - 60 },
      { secret: config.auth.accessSecret, issuer: 'raijin-api', audience: 'raijin-app' },
    );
    expect(service.fromRequest(reqWith(expired))).toBeNull();
    expect(service.readSessionId(reqWith(expired))).toBe('sid-exp');
  });
});

describe('toPublicUser', () => {
  it('ne révèle ni hash, ni Stripe, ni attribution', () => {
    const user = userFixture({ stripeCustomerId: 'cus_1', utmSource: 'x', emailVerifiedAt: new Date() });
    const pub = toPublicUser(user);
    expect(pub).toEqual({
      id: user.id,
      email: user.email,
      emailVerified: true,
      plan: 'FREE',
      role: 'USER',
      trial: { status: 'none', startedAt: null, endsAt: null },
      createdAt: user.createdAt.toISOString(),
    });
  });

  it('essai actif → plan PRO ; essai dépassé → ended', () => {
    const now = new Date('2026-11-22T00:00:00Z');
    const active = userFixture({
      trialStatus: 'ACTIVE',
      trialStartedAt: new Date('2026-11-20T00:00:00Z'),
      trialEndsAt: new Date('2026-11-27T00:00:00Z'),
    });
    expect(toPublicUser(active, now)).toMatchObject({ plan: 'PRO', trial: { status: 'active' } });
    expect(toPublicUser(active, new Date('2026-12-01T00:00:00Z'))).toMatchObject({ plan: 'FREE', trial: { status: 'ended' } });
    expect(toPublicUser(userFixture({ trialStatus: 'INELIGIBLE' }))).toMatchObject({ trial: { status: 'ineligible' } });
  });
});

describe('clientInfoFromRequest', () => {
  it('IP et user-agent borné', () => {
    const info = clientInfoFromRequest({ ip: '1.2.3.4', headers: { 'user-agent': 'x'.repeat(400) } } as unknown as Request);
    expect(info.ip).toBe('1.2.3.4');
    expect(info.userAgent).toHaveLength(256);
    expect(clientInfoFromRequest({ headers: {} } as unknown as Request)).toEqual({ ip: null, userAgent: null });
  });
});
