import { ApiException } from '@raijin/api-core';
import type { AuditService, AuthService, SessionService } from '@raijin/api-auth';
import type { PrismaService, User } from '@raijin/api-prisma';
import { UsersService } from './users.service';
import { NoopAccountBillingCloser, type AccountBillingCloser } from './account-billing-closer';

const client = { ip: '192.0.2.1', userAgent: 'jest' };
const user = {
  id: 'u',
  email: 'jean@exemple.fr',
  passwordHash: '$argon2id$x',
  emailVerifiedAt: null,
  plan: 'FREE',
  role: 'USER',
  trialStatus: 'NONE',
  trialStartedAt: null,
  trialEndsAt: null,
  createdAt: new Date('2026-11-22T10:00:00Z'),
} as unknown as User;

function setup() {
  const prisma: Record<string, unknown> & { user: { findUnique: jest.Mock; delete: jest.Mock } } = {
    user: { findUnique: jest.fn(), delete: jest.fn() },
  };
  prisma['$transaction'] = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
  const auth = { confirmPassword: jest.fn() };
  const sessions = { revokeAllForUser: jest.fn() };
  const audit = { record: jest.fn(), recordInTx: jest.fn<Promise<{ id: string }>, [unknown, { action: string }]>(async () => ({ id: 'a' })) };
  const billing = { closeForUser: jest.fn(async () => undefined) };
  const service = new UsersService(
    prisma as unknown as PrismaService,
    auth as unknown as AuthService,
    sessions as unknown as SessionService,
    audit as unknown as AuditService,
    billing as unknown as AccountBillingCloser,
  );
  return { prisma, auth, sessions, audit, service, billing };
}

describe('UsersService', () => {
  it('me : profil public', async () => {
    const { prisma, service } = setup();
    prisma.user.findUnique.mockResolvedValue(user);
    await expect(service.me('u')).resolves.toMatchObject({ id: 'u', email: 'jean@exemple.fr', plan: 'FREE' });
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.me('u')).rejects.toBeInstanceOf(ApiException);
  });

  it('export : sans hash ni secret, journalisé', async () => {
    const { prisma, audit, service } = setup();
    prisma.user.findUnique.mockResolvedValue({
      id: 'u',
      email: 'jean@exemple.fr',
      sessions: [],
      stripeCustomerId: 'cus_secret',
      auditLogs: [
        { action: 'auth.login', actorKind: 'user', userAgent: 'Firefox', createdAt: new Date() },
        { action: 'admin.user_suspended', actorKind: 'admin', userAgent: 'Navigateur de l’admin', createdAt: new Date() },
      ],
    });
    const data = await service.export('u', client);
    expect(data).toMatchObject({ format: 'raijin-export-v1', account: { id: 'u', hasPaymentCustomer: true } });
    expect(JSON.stringify(data)).not.toContain('cus_secret');
    // Action admin : auteur réduit à « admin », sans son navigateur (docs/ARCHITECTURE.md §14.8).
    expect(JSON.stringify(data)).not.toContain('Navigateur de l’admin');
    expect((data['account'] as { auditLogs: unknown[] }).auditLogs).toEqual([
      expect.objectContaining({ action: 'auth.login', userAgent: 'Firefox' }),
      expect.objectContaining({ action: 'admin.user_suspended', actorKind: 'admin', userAgent: null }),
    ]);
    const select = prisma.user.findUnique.mock.calls[0][0].select;
    for (const field of ['notifyTrialEmails', 'trialStartedAt', 'trialEndsAt', 'trialDay1MailAt', 'trialDayMinus2MailAt', 'trialEndMailAt', 'trialEndScreenSeenAt']) {
      expect(select[field]).toBe(true);
    }
    expect(select.subscriptions.select).toMatchObject({ status: true, interval: true, currentPeriodEnd: true });
    expect(select.productEvents.select).toMatchObject({ type: true, properties: true });
    expect(select.passwordHash).toBeUndefined();
    expect(select.totpSecret).toBeUndefined();
    expect(select.trialFingerprints).toBeUndefined();
    expect(audit.record).toHaveBeenCalledWith('account.exported', 'u', client);
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.export('u', client)).rejects.toBeInstanceOf(ApiException);
  });

  it('suppression : mot de passe confirmé (compteur d’échecs partagé), sessions révoquées, audit', async () => {
    const { prisma, auth, sessions, audit, service } = setup();
    prisma.user.findUnique.mockResolvedValue(user);
    auth.confirmPassword.mockRejectedValueOnce(new ApiException('AUTH_INVALID_CREDENTIALS', 400));
    await expect(service.delete('u', 'faux', client)).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    expect(auth.confirmPassword).toHaveBeenCalledWith(user, 'faux', client, 'account.delete');
    expect(prisma.user.delete).not.toHaveBeenCalled();

    auth.confirmPassword.mockResolvedValueOnce(undefined);
    await service.delete('u', 'bon', client);
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith('u', 'account_deleted');
    expect(audit.recordInTx).toHaveBeenCalledWith(prisma, { action: 'account.deleted', actorKind: 'user', actorId: 'u', userId: 'u', client });
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'u' } });

    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.delete('u', 'bon', client)).rejects.toMatchObject({ code: 'AUTH_SESSION_EXPIRED' });
  });

  it('suppression : abonnement résilié avant ; échec du prestataire → 503, compte conservé', async () => {
    const { prisma, auth, sessions, billing, service } = setup();
    prisma.user.findUnique.mockResolvedValue(user);
    auth.confirmPassword.mockResolvedValue(undefined);
    billing.closeForUser.mockRejectedValueOnce(new Error('stripe down'));
    await expect(service.delete('u', 'bon', client)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', status: 503 });
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(prisma.user.delete).not.toHaveBeenCalled();
    const dedicated = new ApiException('BILLING_NOT_CONFIGURED', 503);
    billing.closeForUser.mockRejectedValueOnce(dedicated);
    await expect(service.delete('u', 'bon', client)).rejects.toBe(dedicated);
    expect(prisma.user.delete).not.toHaveBeenCalled();
    await service.delete('u', 'bon', client);
    expect(billing.closeForUser).toHaveBeenLastCalledWith('u');
    expect(billing.closeForUser.mock.invocationCallOrder[2]).toBeLessThan(prisma.user.delete.mock.invocationCallOrder[0] as number);
    await expect(new NoopAccountBillingCloser().closeForUser()).resolves.toBeUndefined();
  });
});

describe('UsersService.deleteAccount (flux partagé avec l’espace admin)', () => {
  it('entrée de l’appelant écrite avant la suppression, dans la même transaction ; auteur admin', async () => {
    const { prisma, audit, service } = setup();
    const order: string[] = [];
    audit.recordInTx.mockImplementation(async (_tx: unknown, entry: { action: string }) => {
      order.push(entry.action);
      return { id: 'a' };
    });
    prisma.user.delete.mockImplementation(async () => order.push('delete'));
    await service.deleteAccount('u', client, {
      actorKind: 'admin',
      actorId: 'admin-id',
      beforeDelete: async (tx) => {
        await audit.recordInTx(tx, { action: 'admin.user_deleted' });
      },
    });
    expect(order).toEqual(['admin.user_deleted', 'account.deleted', 'delete']);
    expect(audit.recordInTx).toHaveBeenCalledWith(prisma, expect.objectContaining({ action: 'account.deleted', actorKind: 'admin', actorId: 'admin-id' }));
  });
});
