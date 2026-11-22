import { testConfig } from '@raijin/api-core';
import type { PrismaService } from '@raijin/api-prisma';
import { createAdminSecurityDb } from '../../testing/admin-security-fake';
import { AuditService } from '../audit/audit.service';
import { AdminCliService, parseAdminCliArgs, runAdminCli } from './admin-cli';

const USER = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const NOW = new Date('2026-11-22T10:00:00Z');

function setup(user: Record<string, unknown> = {}) {
  const db = createAdminSecurityDb();
  db.user.rows.push({ id: USER, emailNormalized: 'admin@exemple.fr', role: 'USER', emailVerifiedAt: NOW, suspendedAt: null, ...user });
  db.session.rows.push({ id: 's1', userId: USER, revokedAt: null, adminVerifiedAt: NOW, adminLastSeenAt: NOW });
  const prisma = db as unknown as PrismaService;
  return { db, cli: new AdminCliService(prisma, new AuditService(prisma, testConfig())) };
}

describe('parseAdminCliArgs', () => {
  it('lit la commande, l’e-mail (validé, minuscules) et --revoke', () => {
    expect(parseAdminCliArgs(['make-admin', '--email=Admin@Exemple.fr'])).toEqual({ command: 'make-admin', email: 'admin@exemple.fr', revoke: false });
    expect(parseAdminCliArgs(['make-admin', '--email', 'a@b.fr', '--revoke'])).toEqual({ command: 'make-admin', email: 'a@b.fr', revoke: true });
    expect(parseAdminCliArgs(['admin-reset-2fa', '--email=a@b.fr'])).toMatchObject({ command: 'admin-reset-2fa' });
  });

  it('refuse commande inconnue, e-mail invalide, option inconnue, --revoke hors make-admin', () => {
    expect(parseAdminCliArgs(['drop-db'])).toHaveProperty('error');
    expect(parseAdminCliArgs(['make-admin', '--email=pas-un-email'])).toHaveProperty('error');
    expect(parseAdminCliArgs(['make-admin'])).toHaveProperty('error');
    expect(parseAdminCliArgs(['make-admin', '--email=a@b.fr', '--force'])).toHaveProperty('error');
    expect(parseAdminCliArgs(['admin-reset-2fa', '--email=a@b.fr', '--revoke'])).toHaveProperty('error');
  });

  it('runAdminCli : arguments invalides → code 2 et usage, sans connexion', async () => {
    const out = { log: jest.fn(), error: jest.fn() };
    await expect(runAdminCli(['inconnue'], out, {})).resolves.toBe(2);
    expect(out.error.mock.calls[0]?.[0]).toContain('pnpm nx run api:make-admin');
  });

  it('runAdminCli : configuration de production invalide → code 1', async () => {
    const out = { log: jest.fn(), error: jest.fn() };
    await expect(runAdminCli(['make-admin', '--email=a@b.fr'], out, { NODE_ENV: 'production' })).resolves.toBe(1);
  });
});

describe('AdminCliService', () => {
  it('make-admin : rôle attribué et audité (cli, avant / après)', async () => {
    const { db, cli } = setup();
    await expect(cli.run({ command: 'make-admin', email: 'admin@exemple.fr', revoke: false }, NOW)).resolves.toMatchObject({ ok: true });
    expect(db.user.rows[0]?.['role']).toBe('ADMIN');
    expect(db.auditLog.rows[0]).toMatchObject({ action: 'admin.role_granted', actorKind: 'cli', actorId: null, userId: USER, metadata: { before: { role: 'USER' }, after: { role: 'ADMIN' } } });
    await expect(cli.run({ command: 'make-admin', email: 'admin@exemple.fr', revoke: false }, NOW)).resolves.toMatchObject({ ok: true, message: expect.stringContaining('déjà') });
    expect(db.auditLog.rows).toHaveLength(1);
  });

  it('make-admin : compte inconnu, non vérifié ou suspendu refusé', async () => {
    await expect(setup().cli.makeAdmin('autre@exemple.fr')).resolves.toMatchObject({ ok: false });
    await expect(setup({ emailVerifiedAt: null }).cli.makeAdmin('admin@exemple.fr')).resolves.toMatchObject({ ok: false });
    await expect(setup({ suspendedAt: NOW }).cli.makeAdmin('admin@exemple.fr')).resolves.toMatchObject({ ok: false });
  });

  it('--revoke : rôle retiré, sessions révoquées, audité', async () => {
    const { db, cli } = setup({ role: 'ADMIN' });
    await expect(cli.run({ command: 'make-admin', email: 'admin@exemple.fr', revoke: true }, NOW)).resolves.toMatchObject({ ok: true });
    expect(db.user.rows[0]?.['role']).toBe('USER');
    expect(db.session.rows[0]).toMatchObject({ revokedAt: NOW, revokedReason: 'admin_revoked' });
    expect(db.auditLog.rows[0]).toMatchObject({ action: 'admin.role_revoked', actorKind: 'cli' });
    await expect(cli.revokeAdmin('admin@exemple.fr', NOW)).resolves.toMatchObject({ ok: true, message: expect.stringContaining('pas admin') });
    await expect(cli.revokeAdmin('x@exemple.fr', NOW)).resolves.toMatchObject({ ok: false });
  });

  it('admin-reset-2fa : secret et codes effacés, sessions admin non vérifiées, audité', async () => {
    const { db, cli } = setup({ role: 'ADMIN' });
    db.totpSecret.rows.push({ userId: USER, enabledAt: NOW });
    db.adminRecoveryCode.rows.push({ userId: USER, codeHash: 'h1' }, { userId: USER, codeHash: 'h2' });
    await expect(cli.run({ command: 'admin-reset-2fa', email: 'admin@exemple.fr', revoke: false }, NOW)).resolves.toMatchObject({ ok: true });
    expect(db.totpSecret.rows).toHaveLength(0);
    expect(db.adminRecoveryCode.rows).toHaveLength(0);
    expect(db.session.rows[0]).toMatchObject({ adminVerifiedAt: null, adminLastSeenAt: null });
    expect(db.auditLog.rows[0]).toMatchObject({ action: 'admin.2fa_reset', metadata: { details: { recoveryCodesRemoved: 2 } } });
    await expect(cli.resetTwoFactor('admin@exemple.fr')).resolves.toMatchObject({ ok: true, message: expect.stringContaining('Aucune') });
    await expect(cli.resetTwoFactor('x@exemple.fr')).resolves.toMatchObject({ ok: false });
  });
});
