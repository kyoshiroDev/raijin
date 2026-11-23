import { testConfig } from '@raijin/api-core';
import type { PrismaService } from '@raijin/api-prisma';
import { createAdminSecurityDb } from '../../testing/admin-security-fake';
import { AuditService } from '../audit/audit.service';
import { AdminCliService, parseAdminCliArgs, readStdin, runAdminCli } from './admin-cli';

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

describe('CLI notify-admins (phase 8 : watchdog, sauvegardes)', () => {
  const config = testConfig();

  function notifySetup(options: { mailFails?: boolean; push?: 'sent' | 'failed' } = {}) {
    const db = createAdminSecurityDb();
    const sub = { endpoint: 'https://push.exemple/endpoint-secret', p256dh: 'p', auth: 'a' };
    db.user.rows.push(
      { id: 'a1', email: 'admin1@exemple.fr', role: 'ADMIN', suspendedAt: null, emailVerifiedAt: NOW, pushSubscriptions: [sub] },
      { id: 'a2', email: 'admin-suspendu@exemple.fr', role: 'ADMIN', suspendedAt: NOW, emailVerifiedAt: NOW, pushSubscriptions: [] },
      { id: 'u1', email: 'user@exemple.fr', role: 'USER', suspendedAt: null, emailVerifiedAt: NOW, pushSubscriptions: [] },
    );
    const mailer = { send: jest.fn(async () => (options.mailFails ? Promise.reject(Object.assign(new Error('smtp'), { code: 'ECONNREFUSED' })) : undefined)) };
    const push = { configured: true, publicKey: 'k', send: jest.fn(async () => ({ status: options.push ?? 'sent' })) };
    const prisma = db as unknown as PrismaService;
    const cli = new AdminCliService(prisma, new AuditService(prisma, config), mailer as never, push as never, config);
    return { db, cli, mailer, push };
  }

  it('arguments : --title et --stdin obligatoires, titre nettoyé et borné', () => {
    expect(parseAdminCliArgs(['notify-admins', '--title=Sauvegarde échouée', '--stdin'])).toEqual({ command: 'notify-admins', title: 'Sauvegarde échouée', stdin: true });
    expect(parseAdminCliArgs(['notify-admins', '--title', 'x'.repeat(300), '--stdin'])).toMatchObject({ title: 'x'.repeat(120) });
    expect(parseAdminCliArgs(['notify-admins', '--title=Objet'])).toHaveProperty('error');
    expect(parseAdminCliArgs(['notify-admins', '--stdin'])).toHaveProperty('error');
    expect(parseAdminCliArgs(['notify-admins', '--title=\u0000', '--stdin'])).toHaveProperty('error');
    expect(parseAdminCliArgs(['notify-admins', '--title=a', '--stdin', '--email=x@y.fr'])).toHaveProperty('error');
  });

  it('e-mail + push aux seuls admins actifs, corps borné à 2 000 caractères et échappé, audité (cli)', async () => {
    const { db, cli, mailer, push } = notifySetup();
    const outcome = await cli.run({ command: 'notify-admins', title: 'Watchdog', stdin: true }, NOW, `<b>API</b> redémarrée\n${'z'.repeat(5_000)}`);
    expect(outcome).toMatchObject({ ok: true, message: expect.stringContaining('1 e-mail(s), 1 push') });
    expect(mailer.send).toHaveBeenCalledTimes(1);
    const mail = (mailer.send.mock.calls[0] as unknown[])[0] as { to: string; subject: string; html: string; text: string };
    expect(mail.to).toBe('admin1@exemple.fr');
    expect(mail.subject).toBe('Raijin admin : Watchdog');
    expect(mail.html).toContain('&lt;b&gt;API&lt;/b&gt;');
    expect(mail.text.length).toBeLessThan(2_600);
    expect(push.send).toHaveBeenCalledWith(expect.objectContaining({ endpoint: expect.any(String) }), expect.objectContaining({ notification: expect.objectContaining({ tag: 'admin-notice' }) }), { ttlSeconds: 3_600, urgency: 'high' });
    expect(db.auditLog.rows[0]).toMatchObject({ action: 'admin.cli_notified', actorKind: 'cli', actorId: null, userId: null });
    expect(JSON.stringify(db.auditLog.rows)).not.toMatch(/admin1@|endpoint-secret/);
    expect(outcome.message).not.toMatch(/admin1@|endpoint-secret/);
  });

  it('aucun envoi réussi (SMTP et push en échec) ou aucun admin : échec (code de sortie ≠ 0)', async () => {
    const failing = notifySetup({ mailFails: true, push: 'failed' });
    await expect(failing.cli.notifyAdmins('Watchdog', 'corps', NOW)).resolves.toMatchObject({ ok: false });
    const empty = notifySetup();
    empty.db.user.rows.splice(0, 1);
    await expect(empty.cli.notifyAdmins('Watchdog', 'corps', NOW)).resolves.toMatchObject({ ok: false, message: expect.stringContaining('Aucun compte admin') });
    // Push seul réussi : succès.
    await expect(notifySetup({ mailFails: true }).cli.notifyAdmins('Watchdog', 'corps', NOW)).resolves.toMatchObject({ ok: true });
  });

  it('readStdin : corps lu et borné en octets', async () => {
    const { Readable } = await import('node:stream');
    await expect(readStdin(Readable.from([Buffer.from('ab'), Buffer.from('cdef')]), 4)).resolves.toBe('abcd');
  });
});
