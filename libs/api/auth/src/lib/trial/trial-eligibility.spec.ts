import { testConfig } from '@raijin/api-core';
import type { Prisma } from '@raijin/api-prisma';
import { normalizeEmail } from '../services/email-normalizer';
import { DISPOSABLE_DOMAINS_SOURCE } from './disposable-domains.generated';
import { disposableDomainCount, emailDomain, isDisposableDomain, isDisposableEmail } from './disposable-domains';
import { TrialEligibilityService, type TrialCandidate } from './trial-eligibility.service';

const NOW = new Date('2026-11-22T10:00:00.000Z');
const DAY = 86_400_000;
const client = { ip: '2001:db8:abcd:12::1', userAgent: 'Mozilla/5.0 (test)' };

function txMock() {
  return {
    trialClaim: { findUnique: jest.fn(async () => null as unknown), create: jest.fn(async () => ({})) },
    trialFingerprint: { findFirst: jest.fn(async () => null as unknown), create: jest.fn(async () => ({})) },
    user: { update: jest.fn(async () => ({})) },
    productEvent: { create: jest.fn(async () => ({})) },
    $queryRaw: jest.fn(async () => [{ locked: '' }]),
  };
}

function candidate(overrides: Partial<TrialCandidate> = {}): TrialCandidate {
  return { id: 'u1', email: 'lea@exemple.fr', emailNormalized: 'lea@exemple.fr', plan: 'FREE', trialStatus: 'NONE', ...overrides };
}

function setup() {
  const service = new TrialEligibilityService(testConfig());
  const tx = txMock();
  return { service, tx, run: (c: TrialCandidate, info = client) => service.startOnVerification(tx as unknown as Prisma.TransactionClient, c, info, NOW) };
}

describe('domaines jetables', () => {
  it('liste CC0 copiée dans le dépôt (aucun téléchargement), avec ajouts maison', () => {
    expect(disposableDomainCount()).toBeGreaterThan(1_000);
    expect(DISPOSABLE_DOMAINS_SOURCE.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(isDisposableDomain('mailinator.com')).toBe(true);
    expect(isDisposableDomain('cool.fr.nf')).toBe(true);
  });

  it('domaine parent jetable : refusé aussi ; domaines ordinaires acceptés', () => {
    expect(isDisposableDomain('abc.mailinator.com')).toBe(true);
    expect(isDisposableEmail('Lea@Sous.Domaine.Mailinator.com')).toBe(true);
    expect(isDisposableEmail('lea@gmail.com')).toBe(false);
    expect(isDisposableEmail('lea@exemple.fr')).toBe(false);
    expect(isDisposableDomain('com')).toBe(false);
  });

  it('adresse mal formée : pas de domaine', () => {
    expect(emailDomain('sans-arobase')).toBeNull();
    expect(emailDomain('fin@')).toBeNull();
    expect(emailDomain('a@exemple.fr.')).toBe('exemple.fr');
    expect(isDisposableEmail('@mailinator.com')).toBe(false);
  });
});

describe('TrialEligibilityService : empreintes', () => {
  const service = new TrialEligibilityService(testConfig());

  it('un essai par e-mail normalisé : alias + et points Gmail donnent le même HMAC, jamais l’adresse en clair', () => {
    const a = service.emailHash(normalizeEmail('Jean.Dupont+promo@googlemail.com'));
    const b = service.emailHash(normalizeEmail('jeandupont@gmail.com'));
    expect(a).toBe(b);
    expect(a).not.toContain('jeandupont');
    expect(service.emailHash('autre@gmail.com')).not.toBe(a);
  });

  it('empreinte : IPv6 regroupée par /64, user-agent pris en compte, secret requis', () => {
    expect(service.fingerprint({ ip: '2001:db8:abcd:12::1', userAgent: 'UA' })).toBe(service.fingerprint({ ip: '2001:db8:abcd:12:ffff::9', userAgent: 'UA' }));
    expect(service.fingerprint({ ip: '2001:db8:abcd:12::1', userAgent: 'UA' })).not.toBe(service.fingerprint({ ip: '2001:db8:abcd:12::1', userAgent: 'UA2' }));
    expect(service.fingerprint({ ip: null, userAgent: null })).toHaveLength(43);
    const other = new TrialEligibilityService(testConfig({ IP_HASH_SECRET: 'z'.repeat(48) }));
    expect(other.fingerprint(client)).not.toBe(service.fingerprint(client));
  });
});

describe('TrialEligibilityService : décision à la vérification', () => {
  it('éligible : essai de 7 jours, TrialClaim + TrialFingerprint sous deux verrous, trial_started', async () => {
    const { run, tx, service } = setup();
    const outcome = await run(candidate());
    expect(outcome).toEqual({ kind: 'started', startedAt: NOW, endsAt: new Date(NOW.getTime() + 7 * DAY) });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.trialClaim.create).toHaveBeenCalledWith({ data: { emailHash: service.emailHash('lea@exemple.fr'), userId: 'u1' } });
    expect(tx.trialFingerprint.create).toHaveBeenCalledWith({ data: { hash: service.fingerprint(client), userId: 'u1' } });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { trialStatus: 'ACTIVE', trialStartedAt: NOW, trialEndsAt: new Date(NOW.getTime() + 7 * DAY) },
    });
    expect(tx.productEvent.create).toHaveBeenCalledWith({ data: { userId: 'u1', type: 'trial_started', properties: {} } });
  });

  it('durée configurable (TRIAL_DAYS)', async () => {
    const service = new TrialEligibilityService(testConfig({ TRIAL_DAYS: '3' }));
    const tx = txMock();
    const outcome = await service.startOnVerification(tx as unknown as Prisma.TransactionClient, candidate(), client, NOW);
    expect(outcome).toMatchObject({ endsAt: new Date(NOW.getTime() + 3 * DAY) });
  });

  it('e-mail déjà utilisé pour un essai (même après suppression du compte) : INELIGIBLE, email_already_used', async () => {
    const { run, tx } = setup();
    tx.trialClaim.findUnique.mockResolvedValueOnce({ id: 'claim' });
    expect(await run(candidate())).toEqual({ kind: 'refused', reason: 'email_already_used' });
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { trialStatus: 'INELIGIBLE' } });
    expect(tx.productEvent.create).toHaveBeenCalledWith({ data: { userId: 'u1', type: 'trial_refused', properties: { reason: 'email_already_used' } } });
    expect(tx.trialClaim.create).not.toHaveBeenCalled();
    expect(tx.trialFingerprint.create).not.toHaveBeenCalled();
  });

  it('domaine jetable (ou parent) : disposable_domain', async () => {
    const { run } = setup();
    expect(await run(candidate({ email: 'x@abc.mailinator.com', emailNormalized: 'x@abc.mailinator.com' }))).toEqual({ kind: 'refused', reason: 'disposable_domain' });
  });

  it('empreinte déjà accordée dans les 90 jours : fingerprint_seen (fenêtre de rétention)', async () => {
    const { run, tx } = setup();
    tx.trialFingerprint.findFirst.mockResolvedValueOnce({ id: 'fp' });
    expect(await run(candidate())).toEqual({ kind: 'refused', reason: 'fingerprint_seen' });
    expect(tx.trialFingerprint.findFirst).toHaveBeenCalledWith({
      where: { hash: expect.any(String), createdAt: { gte: new Date(NOW.getTime() - 90 * DAY) } },
      select: { id: true },
    });
  });

  it('ordre des contrôles : e-mail d’abord, puis domaine, puis empreinte', async () => {
    const { run, tx } = setup();
    tx.trialClaim.findUnique.mockResolvedValueOnce({ id: 'claim' });
    tx.trialFingerprint.findFirst.mockResolvedValueOnce({ id: 'fp' });
    expect(await run(candidate({ email: 'x@mailinator.com', emailNormalized: 'x@mailinator.com' }))).toMatchObject({ reason: 'email_already_used' });
    tx.trialFingerprint.findFirst.mockResolvedValueOnce({ id: 'fp' });
    expect(await run(candidate({ email: 'x@mailinator.com', emailNormalized: 'x@mailinator.com' }))).toMatchObject({ reason: 'disposable_domain' });
  });

  it('essai déjà décidé ou compte Pro : rien ne change', async () => {
    const { run, tx } = setup();
    expect(await run(candidate({ trialStatus: 'ENDED' }))).toEqual({ kind: 'skipped' });
    expect(await run(candidate({ trialStatus: 'INELIGIBLE' }))).toEqual({ kind: 'skipped' });
    expect(await run(candidate({ plan: 'PRO' }))).toEqual({ kind: 'skipped' });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
  });
});
