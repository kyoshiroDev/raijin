import { testConfig } from '@raijin/api-core';
import type { AdminSecurityService, AuditService, AuthService } from '@raijin/api-auth';
import type { PrismaService } from '@raijin/api-prisma';
import type { UsersService } from '@raijin/api-users';
import { adminUserDetailSchema, adminUserPageSchema } from '@raijin/shared-contracts';
import { AdminUsersService, escapeLike } from './admin-users.service';

const ADMIN = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a50';
const USER = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51';
const NOW = new Date('2026-11-22T10:00:00.000Z');
const DAY = 86_400_000;
const actor = { userId: ADMIN, client: { ip: '203.0.113.1', userAgent: 'jest' } };

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: USER,
    email: 'jean@exemple.fr',
    role: 'USER',
    plan: 'FREE',
    emailVerifiedAt: NOW,
    trialStatus: 'NONE',
    trialStartedAt: null,
    trialEndsAt: null,
    trialEndScreenSeenAt: null,
    proGrantedUntil: null,
    suspendedAt: null,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    lastLoginAt: null,
    utmSource: 'twitter',
    utmMedium: null,
    utmCampaign: null,
    referrer: null,
    landingPath: '/guides',
    stripeCustomerId: 'cus_ABC123',
    ...overrides,
  };
}

function setup(row: Record<string, unknown> = userRow(), options: { proSubscription?: boolean; livemode?: boolean } = {}) {
  const billing = { livemode: options.livemode ?? false };
  let current: Record<string, unknown> | null = { ...row };
  let auditSeq = 0;
  const model = () => ({
    findUnique: jest.fn(),
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    update: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    aggregate: jest.fn().mockResolvedValue({ _sum: { count: 4 } }),
  });
  const prisma = {
    user: model(),
    subscription: model(),
    usageCounter: model(),
    tokenAnalysis: model(),
    alert: model(),
    watch: model(),
    pushSubscription: model(),
    session: model(),
    auditLog: model(),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
  prisma.user.findUnique.mockImplementation(async () => (current ? { ...current } : null));
  prisma.user.findMany.mockImplementation(async () => (current ? [{ ...current }] : []));
  prisma.user.count.mockResolvedValue(1);
  prisma.user.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    current = { ...(current ?? {}), ...data };
    return current;
  });
  prisma.user.updateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    current = { ...(current ?? {}), ...data };
    return { count: 1 };
  });
  prisma.session.updateMany.mockResolvedValue({ count: 2 });
  if (options.proSubscription) {
    prisma.subscription.findMany.mockResolvedValue([{ userId: USER }]);
    prisma.subscription.findFirst.mockResolvedValue({ status: 'ACTIVE', interval: 'MONTH', currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY), cancelAtPeriodEnd: false });
  }
  const audit = {
    recordInTx: jest.fn(async () => ({ id: `0193a1b2-c3d4-7e5f-8a9b-00000000000${++auditSeq}` })),
    recordStrict: jest.fn(async () => ({ id: `0193a1b2-c3d4-7e5f-8a9b-00000000000${++auditSeq}` })),
    forUser: jest.fn().mockResolvedValue([]),
    fingerprint: jest.fn((value: string) => `hmac-${value.length}`),
  };
  const security = { verifyFreshTotp: jest.fn().mockResolvedValue(undefined) };
  const auth = { resendVerification: jest.fn().mockResolvedValue('ok') };
  const users = {
    deleteAccount: jest.fn(async (_id: string, _client: unknown, options: { beforeDelete?: (tx: unknown) => Promise<void> }) => {
      await options.beforeDelete?.(prisma);
      current = null;
    }),
  };
  const service = new AdminUsersService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    security as unknown as AdminSecurityService,
    auth as unknown as AuthService,
    users as unknown as UsersService,
    testConfig(),
    { get: () => ({ livemode: billing.livemode }) } as never,
  );
  return { service, prisma, audit, security, auth, users, current: () => current };
}

describe('escapeLike', () => {
  it('échappe %, _ et \\ (Prisma ne le fait pas)', () => {
    expect(escapeLike('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
    expect(escapeLike('jean@')).toBe('jean@');
  });
});

describe('AdminUsersService — liste', () => {
  it('filtres : recherche échappée insensible à la casse, plan effectif, essai, statut, source, période', () => {
    const { service } = setup();
    const where = service.listWhere(
      { q: '50%_', plan: 'PRO', trialStatus: 'ended', status: 'active', source: '(direct)', signupFrom: '2026-11-01', signupTo: '2026-11-21', limit: 20 },
      NOW,
    );
    const json = JSON.stringify(where);
    expect(json).toContain('"contains":"50\\\\%\\\\_"');
    expect(json).toContain('"mode":"insensitive"');
    expect(json).toContain('"proGrantedUntil"');
    expect(json).toContain('"utmSource":null');
    expect(json).toContain('2026-11-22T00:00:00.000Z');
    expect(service.listWhere({ limit: 20 }, NOW)).toEqual({});
    expect(JSON.stringify(service.listWhere({ plan: 'FREE', status: 'suspended', trialStatus: 'none', limit: 20 }, NOW))).toContain('"NOT"');
  });

  it('recherche auditée : nombre de résultats et empreinte, jamais le texte', async () => {
    const { service, audit } = setup();
    const page = await service.list({ q: 'jean@exemple', limit: 20 }, actor, NOW);
    expect(adminUserPageSchema.parse(page)).toEqual(page);
    expect(page.items[0]).toMatchObject({ plan: 'FREE', planSource: 'free', status: 'active' });
    expect(audit.recordStrict).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin.user_searched', actorId: ADMIN, metadata: { details: { resultCount: 1, queryHmac: 'hmac-12' } } }));
    expect(JSON.stringify(audit.recordStrict.mock.calls)).not.toContain('jean@exemple');
  });

  it('liste sans recherche : pas d’audit ; Pro offert et abonné reconnus', async () => {
    const gift = setup(userRow({ proGrantedUntil: new Date(NOW.getTime() + DAY) }));
    expect((await gift.service.list({ limit: 20 }, actor, NOW)).items[0]).toMatchObject({ plan: 'PRO', planSource: 'gift' });
    expect(gift.audit.recordStrict).not.toHaveBeenCalled();
    const sub = setup(userRow(), { proSubscription: true });
    expect((await sub.service.list({ limit: 20 }, actor, NOW)).items[0]).toMatchObject({ plan: 'PRO', planSource: 'subscription' });
  });
});

describe('AdminUsersService — fiche', () => {
  it('fiche conforme au contrat, consultation auditée une fois par 10 min, lien Stripe en mode test', async () => {
    const { service, audit, prisma } = setup();
    const detail = await service.detail(USER, actor, NOW);
    expect(adminUserDetailSchema.parse(detail)).toEqual(detail);
    expect(detail.stripeDashboardUrl).toBe('https://dashboard.stripe.com/test/customers/cus_ABC123');
    expect(detail.usage.walletScans30d).toBe(4);
    expect(audit.recordStrict).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin.user_viewed', userId: USER }));
    prisma.auditLog.findFirst.mockResolvedValueOnce({ id: 'recent' });
    await service.detail(USER, actor, NOW);
    expect(audit.recordStrict).toHaveBeenCalledTimes(1);
  });

  it('lien Stripe selon le mode de facturation (clé live → dashboard réel), jamais selon NODE_ENV', async () => {
    expect(setup(userRow(), { livemode: true }).service.stripeDashboardUrl('cus_ABC123')).toBe('https://dashboard.stripe.com/customers/cus_ABC123');
    expect(setup(userRow(), { livemode: false }).service.stripeDashboardUrl('cus_ABC123')).toBe('https://dashboard.stripe.com/test/customers/cus_ABC123');
    expect(setup().service.stripeDashboardUrl('cus_<script>')).toBeNull();
    expect(setup().service.stripeDashboardUrl(null)).toBeNull();
  });

  it('compte inconnu : 404', async () => {
    const { service, prisma } = setup();
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.detail(USER, actor, NOW)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('actions possibles selon l’état ; aucune sur un admin ni sur soi-même', () => {
    const { service } = setup();
    const base = userRow() as Parameters<AdminUsersService['availableActions']>[0];
    expect(service.availableActions(base, ADMIN, false, NOW)).toEqual(['grant_pro_month', 'suspend', 'delete']);
    expect(service.availableActions({ ...base, trialStatus: 'ACTIVE', trialStartedAt: NOW, trialEndsAt: new Date(NOW.getTime() + DAY), emailVerifiedAt: null }, ADMIN, false, NOW)).toEqual([
      'extend_trial',
      'grant_pro_month',
      'suspend',
      'resend_verification',
      'delete',
    ]);
    expect(service.availableActions({ ...base, trialStatus: 'INELIGIBLE' }, ADMIN, false, NOW)).not.toContain('extend_trial');
    expect(service.availableActions({ ...base, suspendedAt: NOW }, ADMIN, true, NOW)).toEqual(['reactivate', 'delete']);
    expect(service.availableActions({ ...base, role: 'ADMIN' }, ADMIN, false, NOW)).toEqual([]);
    expect(service.availableActions(base, USER, false, NOW)).toEqual([]);
  });
});

describe('AdminUsersService — actions', () => {
  it('prolonger un essai actif : trialEndsAt + j, audit avant / après dans la transaction', async () => {
    const endsAt = new Date(NOW.getTime() + 2 * DAY);
    const { service, audit, current } = setup(userRow({ trialStatus: 'ACTIVE', trialStartedAt: new Date(NOW.getTime() - 5 * DAY), trialEndsAt: endsAt }));
    const result = await service.act(USER, { type: 'extend_trial', days: 3, reason: 'Geste commercial' }, actor, NOW);
    expect(current()?.['trialEndsAt']).toEqual(new Date(endsAt.getTime() + 3 * DAY));
    expect(audit.recordInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin.trial_extended',
        metadata: expect.objectContaining({ before: { trialStatus: 'ACTIVE', trialEndsAt: endsAt.toISOString() }, reason: 'Geste commercial', details: { days: 3 } }),
      }),
    );
    expect(result).toMatchObject({ type: 'extend_trial', user: { id: USER } });
  });

  it('prolonger un essai terminé : réouvert jusqu’à now + j, e-mails d’essai remis à zéro', async () => {
    const { service, current } = setup(userRow({ trialStatus: 'ENDED', trialStartedAt: new Date(NOW.getTime() - 10 * DAY), trialEndsAt: new Date(NOW.getTime() - 3 * DAY) }));
    await service.act(USER, { type: 'extend_trial', days: 7, reason: 'Retour client' }, actor, NOW);
    expect(current()).toMatchObject({ trialStatus: 'ACTIVE', trialEndsAt: new Date(NOW.getTime() + 7 * DAY), trialEndMailAt: null, trialEndScreenSeenAt: null });
  });

  it('offrir un mois : max(now, actuel) + 30 j, plafonné à 365 j ; refus au plafond et avec un abonnement', async () => {
    const { service, current, audit } = setup();
    await service.act(USER, { type: 'grant_pro_month', reason: 'Bêta-testeur' }, actor, NOW);
    expect(current()).toMatchObject({ proGrantedUntil: new Date(NOW.getTime() + 30 * DAY), proGrantEndedAt: null });
    expect(audit.recordInTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'admin.pro_month_granted' }));
    const near = setup(userRow({ proGrantedUntil: new Date(NOW.getTime() + 350 * DAY) }));
    await near.service.act(USER, { type: 'grant_pro_month', reason: 'Bêta-testeur' }, actor, NOW);
    expect(near.current()?.['proGrantedUntil']).toEqual(new Date(NOW.getTime() + 365 * DAY));
    const full = setup(userRow({ proGrantedUntil: new Date(NOW.getTime() + 365 * DAY) }));
    await expect(full.service.act(USER, { type: 'grant_pro_month', reason: 'Bêta-testeur' }, actor, NOW)).rejects.toMatchObject({ code: 'ADMIN_ACTION_NOT_ALLOWED' });
    const sub = setup(userRow(), { proSubscription: true });
    await expect(sub.service.act(USER, { type: 'grant_pro_month', reason: 'Bêta-testeur' }, actor, NOW)).rejects.toMatchObject({ code: 'ADMIN_ACTION_NOT_ALLOWED' });
  });

  it('suspendre : e-mail recopié exigé, sessions révoquées (suspended), push retiré, audité', async () => {
    const { service, prisma, current, audit } = setup();
    await expect(service.act(USER, { type: 'suspend', reason: 'Abus répétés', confirmEmail: 'autre@exemple.fr' }, actor, NOW)).rejects.toMatchObject({ code: 'ADMIN_CONFIRMATION_MISMATCH' });
    await service.act(USER, { type: 'suspend', reason: 'Abus répétés', confirmEmail: 'jean@exemple.fr' }, actor, NOW);
    expect(current()?.['suspendedAt']).toEqual(NOW);
    expect(prisma.session.updateMany).toHaveBeenCalledWith({ where: { userId: USER, revokedAt: null }, data: { revokedAt: NOW, revokedReason: 'suspended' } });
    expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({ where: { userId: USER } });
    expect(audit.recordInTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'admin.user_suspended', metadata: expect.objectContaining({ details: { sessionsRevoked: 2 } }) }));
  });

  it('réactiver un compte suspendu', async () => {
    const { service, current } = setup(userRow({ suspendedAt: NOW }));
    await service.act(USER, { type: 'reactivate', reason: 'Erreur de modération' }, actor, NOW);
    expect(current()?.['suspendedAt']).toBeNull();
    await expect(service.act(USER, { type: 'reactivate', reason: 'Erreur de modération' }, actor, NOW)).rejects.toMatchObject({ code: 'ADMIN_ACTION_NOT_ALLOWED' });
  });

  it('renvoyer la vérification : même service que l’auth, audité', async () => {
    const { service, auth, audit } = setup(userRow({ emailVerifiedAt: null }));
    await service.act(USER, { type: 'resend_verification' }, actor, NOW);
    expect(auth.resendVerification).toHaveBeenCalledWith(USER, undefined);
    expect(audit.recordStrict).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin.verification_resent' }));
  });

  it('supprimer : e-mail recopié + code TOTP frais, flux de DELETE users/me, audit écrit avant la suppression', async () => {
    const { service, security, users, audit } = setup();
    const result = await service.act(USER, { type: 'delete', reason: 'Demande RGPD', confirmEmail: 'jean@exemple.fr', totpCode: '123456' }, actor, NOW);
    expect(security.verifyFreshTotp).toHaveBeenCalledWith(ADMIN, '123456', actor.client, NOW);
    expect(users.deleteAccount).toHaveBeenCalledWith(USER, actor.client, expect.objectContaining({ actorKind: 'admin', actorId: ADMIN }));
    expect(audit.recordInTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'admin.user_deleted', metadata: expect.objectContaining({ reason: 'Demande RGPD' }) }));
    expect(result).toMatchObject({ type: 'delete', user: null });
    expect(result.auditLogId).toMatch(/^0193a1b2/);
  });

  it('code TOTP faux : rien n’est supprimé', async () => {
    const { service, security, users } = setup();
    security.verifyFreshTotp.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'ADMIN_2FA_INVALID' }));
    await expect(service.act(USER, { type: 'delete', reason: 'Demande RGPD', confirmEmail: 'jean@exemple.fr', totpCode: '000000' }, actor, NOW)).rejects.toMatchObject({ code: 'ADMIN_2FA_INVALID' });
    expect(users.deleteAccount).not.toHaveBeenCalled();
  });

  it('interdites sur un admin, sur soi-même, et selon l’état (essai inexistant)', async () => {
    await expect(setup(userRow({ role: 'ADMIN' })).service.act(USER, { type: 'grant_pro_month', reason: 'test test' }, actor, NOW)).rejects.toMatchObject({ code: 'ADMIN_ACTION_NOT_ALLOWED' });
    await expect(setup().service.act(USER, { type: 'grant_pro_month', reason: 'test test' }, { ...actor, userId: USER }, NOW)).rejects.toMatchObject({ code: 'ADMIN_ACTION_NOT_ALLOWED' });
    await expect(setup().service.act(USER, { type: 'extend_trial', days: 3, reason: 'test test' }, actor, NOW)).rejects.toMatchObject({ code: 'ADMIN_ACTION_NOT_ALLOWED' });
    const missing = setup();
    missing.prisma.user.findUnique.mockResolvedValue(null);
    await expect(missing.service.act(USER, { type: 'resend_verification' }, actor, NOW)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
