import { testConfig } from '@raijin/api-core';
import type { PrismaService } from '@raijin/api-prisma';
import { createAdminSecurityDb } from '../../testing/admin-security-fake';
import { AuditService } from './audit.service';

const ADMIN = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const TARGET = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';

function setup() {
  const db = createAdminSecurityDb();
  db.user.rows.push({ id: ADMIN, email: 'admin@exemple.fr' });
  const prisma = db as unknown as PrismaService;
  return { db, audit: new AuditService(prisma, testConfig()) };
}

describe('AuditService', () => {
  it('recordInTx : entrée structurée, IP hachée, métadonnées validées', async () => {
    const { db, audit } = setup();
    const { id } = await audit.recordInTx(db as never, {
      action: 'admin.user_suspended',
      actorKind: 'admin',
      actorId: ADMIN,
      userId: TARGET,
      client: { ip: '203.0.113.9', userAgent: 'jest' },
      metadata: { before: { suspendedAt: null }, after: { suspendedAt: '2026-11-22T10:00:00.000Z' }, reason: 'Abus' },
    });
    const row = db.auditLog.rows[0] as Record<string, unknown>;
    expect(row['id']).toBe(id);
    expect(row['ipHash']).not.toContain('203.0.113.9');
    expect(row).toMatchObject({ actorKind: 'admin', actorId: ADMIN, userId: TARGET, userAgent: 'jest' });
  });

  it('recordInTx : action, auteur ou métadonnées invalides → lève (transaction annulée)', async () => {
    const { audit } = setup();
    await expect(audit.recordStrict({ action: 'INVALIDE', actorKind: 'admin', actorId: null, userId: null })).rejects.toThrow('AUDIT_ACTION_INVALID');
    await expect(audit.recordStrict({ action: 'admin.x', actorKind: 'pirate' as never, actorId: null, userId: null })).rejects.toThrow();
    await expect(
      audit.recordStrict({ action: 'admin.x', actorKind: 'admin', actorId: null, userId: null, metadata: { details: { 'clé invalide': 1 } } as never }),
    ).rejects.toThrow();
  });

  it('record : n’échoue jamais (parcours utilisateur)', async () => {
    const { db, audit } = setup();
    db.auditLog.create.mockRejectedValueOnce(Object.assign(new Error('down'), { code: 'P1001' }));
    await expect(audit.record('auth.login', TARGET, null)).resolves.toBeUndefined();
  });

  it('toEntries : auteur résolu, métadonnées hors schéma réduites, action inconnue neutralisée', async () => {
    const { audit } = setup();
    const createdAt = new Date('2026-11-22T10:00:00Z');
    const entries = await audit.toEntries([
      { id: 'a', action: 'admin.user_viewed', actorKind: 'admin', actorId: ADMIN, userId: TARGET, metadata: null, createdAt },
      { id: 'b', action: 'auth.login', actorKind: 'user', actorId: null, userId: TARGET, metadata: { method: 'password' }, createdAt },
      { id: 'c', action: 'BAD ACTION', actorKind: 'robot', actorId: 'disparu', userId: null, metadata: null, createdAt },
    ]);
    expect(entries[0]).toMatchObject({ actor: { id: ADMIN, email: 'admin@exemple.fr' }, metadata: {}, targetUserId: TARGET });
    expect(entries[1]).toMatchObject({ actor: null, metadata: {} });
    expect(entries[2]).toMatchObject({ action: 'audit.unknown', actorKind: 'user', actor: null });
  });

  it('list : pagination par curseur, curseur invalide → 400', async () => {
    const { db, audit } = setup();
    for (let index = 0; index < 3; index += 1) {
      db.auditLog.rows.push({ id: `0193a1b2-c3d4-7e5f-8a9b-00000000000${index}`, action: 'admin.user_viewed', actorKind: 'admin', actorId: ADMIN, userId: TARGET, metadata: null, createdAt: new Date(2026, 10, 22, 10, index) });
    }
    const page = await audit.list({ limit: 2, userId: TARGET });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    await expect(audit.list({ limit: 2, cursor: 'xx' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(audit.forUser(TARGET, 20)).resolves.toHaveLength(3);
  });

  it('fingerprint : HMAC stable, jamais le texte', () => {
    const { audit } = setup();
    expect(audit.fingerprint('jean@')).toBe(audit.fingerprint('jean@'));
    expect(audit.fingerprint('jean@')).not.toContain('jean');
  });
});
