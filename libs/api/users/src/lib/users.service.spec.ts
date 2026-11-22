import { ApiException } from '@raijin/api-core';
import type { AuditService, PasswordService, SessionService } from '@raijin/api-auth';
import type { PrismaService, User } from '@raijin/api-prisma';
import { UsersService } from './users.service';

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
  const prisma = {
    user: { findUnique: jest.fn(), delete: jest.fn() },
  };
  const passwords = { verify: jest.fn() };
  const sessions = { revokeAllForUser: jest.fn() };
  const audit = { record: jest.fn() };
  const service = new UsersService(
    prisma as unknown as PrismaService,
    passwords as unknown as PasswordService,
    sessions as unknown as SessionService,
    audit as unknown as AuditService,
  );
  return { prisma, passwords, sessions, audit, service };
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
    prisma.user.findUnique.mockResolvedValue({ id: 'u', email: 'jean@exemple.fr', sessions: [] });
    const data = await service.export('u', client);
    expect(data).toMatchObject({ format: 'raijin-export-v1', account: { id: 'u' } });
    const select = prisma.user.findUnique.mock.calls[0][0].select;
    expect(select.passwordHash).toBeUndefined();
    expect(select.totpSecret).toBeUndefined();
    expect(select.trialFingerprints).toBeUndefined();
    expect(audit.record).toHaveBeenCalledWith('account.exported', 'u', client);
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.export('u', client)).rejects.toBeInstanceOf(ApiException);
  });

  it('suppression : mot de passe exigé, sessions révoquées, audit avant suppression', async () => {
    const { prisma, passwords, sessions, audit, service } = setup();
    prisma.user.findUnique.mockResolvedValue(user);
    passwords.verify.mockResolvedValueOnce(false);
    await expect(service.delete('u', 'faux', client)).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    expect(prisma.user.delete).not.toHaveBeenCalled();

    passwords.verify.mockResolvedValueOnce(true);
    await service.delete('u', 'bon', client);
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith('u', 'account_deleted');
    expect(audit.record).toHaveBeenCalledWith('account.deleted', 'u', client);
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'u' } });

    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.delete('u', 'bon', client)).rejects.toMatchObject({ code: 'AUTH_SESSION_EXPIRED' });
  });
});
