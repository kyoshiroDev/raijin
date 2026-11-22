import { adminEnrollmentStartSchema, adminSecurityStatusSchema } from '@raijin/shared-contracts';
import { createAdminSecurityKit } from '../../testing/admin-security-fake';
import { decryptTotpSecret } from './secret-box';
import { base32Decode, hotp, totpStep } from './totp';

const USER = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const SESSION = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60';
const client = { ip: '203.0.113.7', userAgent: 'jest' };
const PASSWORD = 'phrase de passe actuelle';
const T0 = new Date('2026-11-22T10:00:00Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

function setup() {
  const kit = createAdminSecurityKit();
  kit.db.user.rows.push({ id: USER, email: 'admin@exemple.fr', role: 'ADMIN' });
  kit.db.session.rows.push({ id: SESSION, userId: USER, adminVerifiedAt: null, adminLastSeenAt: null });
  return kit;
}

/** Code TOTP du secret renvoyé à l'enrôlement, pour un instant donné. */
const codeFor = (secret: string, at: Date, offset = 0) => hotp(base32Decode(secret), totpStep(at) + offset);

async function enrolled() {
  const kit = setup();
  const start = await kit.service.startEnrollment(USER, T0);
  const confirm = await kit.service.confirmEnrollment(USER, SESSION, codeFor(start.secret, T0), PASSWORD, client, T0);
  return { ...kit, secret: start.secret, recoveryCodes: confirm.recoveryCodes.codes };
}

describe('AdminSecurityService — enrôlement', () => {
  it('secret chiffré en base (AAD totp:<userId>), QR SVG en data URI, contrat respecté', async () => {
    const kit = setup();
    const start = await kit.service.startEnrollment(USER, T0);
    expect(adminEnrollmentStartSchema.parse(start)).toEqual(start);
    expect(start.otpauthUri).toContain('issuer=Raijin+Shield');
    expect(Buffer.from(start.qrCodeDataUri.split(',')[1] ?? '', 'base64').toString()).toContain('<svg');
    const row = kit.db.totpSecret.rows[0] as { secretEncrypted: string; enabledAt: Date | null };
    expect(row.enabledAt).toBeNull();
    expect(row.secretEncrypted).not.toContain(start.secret);
    expect(decryptTotpSecret(kit.config.admin.totpEncryptionKey, USER, row.secretEncrypted).equals(base32Decode(start.secret))).toBe(true);
  });

  it('un nouvel enrôlement remplace l’inachevé ; 409 si la 2FA est déjà active', async () => {
    const kit = setup();
    const first = await kit.service.startEnrollment(USER, T0);
    const second = await kit.service.startEnrollment(USER, T0);
    expect(second.secret).not.toBe(first.secret);
    expect(kit.db.totpSecret.rows).toHaveLength(1);
    await kit.service.confirmEnrollment(USER, SESSION, codeFor(second.secret, T0), PASSWORD, client, T0);
    await expect(kit.service.startEnrollment(USER, T0)).rejects.toMatchObject({ code: 'ADMIN_2FA_ALREADY_ENROLLED' });
    await expect(kit.service.confirmEnrollment(USER, SESSION, '123456', PASSWORD, client, T0)).rejects.toMatchObject({ code: 'ADMIN_2FA_ALREADY_ENROLLED' });
  });

  it('confirmation : 2FA activée, 10 codes de secours hachés, session vérifiée, audit', async () => {
    const kit = await enrolled();
    expect(kit.recoveryCodes).toHaveLength(10);
    const hashes = kit.db.adminRecoveryCode.rows.map((row) => row['codeHash'] as string);
    expect(hashes).toHaveLength(10);
    for (const code of kit.recoveryCodes) expect(hashes).not.toContain(code);
    const status = await kit.service.status(USER, SESSION, T0);
    expect(adminSecurityStatusSchema.parse(status)).toMatchObject({ enrolled: true, verified: true, recoveryCodesRemaining: 10, idleTimeoutSeconds: 1800 });
    expect(kit.db.auditLog.rows.map((row) => row['action'])).toContain('admin.2fa_enrolled');
  });

  it('confirmation expirée après 10 min ou sans enrôlement en cours : 409', async () => {
    const kit = setup();
    await expect(kit.service.confirmEnrollment(USER, SESSION, '123456', PASSWORD, client, T0)).rejects.toMatchObject({ code: 'ADMIN_2FA_ENROLLMENT_EXPIRED' });
    const start = await kit.service.startEnrollment(USER, T0);
    const late = later(601_000);
    await expect(kit.service.confirmEnrollment(USER, SESSION, codeFor(start.secret, late), PASSWORD, client, late)).rejects.toMatchObject({ code: 'ADMIN_2FA_ENROLLMENT_EXPIRED' });
  });

  it('code faux à la confirmation : 400 audité, 2FA non activée', async () => {
    const kit = setup();
    const start = await kit.service.startEnrollment(USER, T0);
    await expect(kit.service.confirmEnrollment(USER, SESSION, codeFor(start.secret, T0, 5), PASSWORD, client, T0)).rejects.toMatchObject({ code: 'ADMIN_2FA_INVALID' });
    expect(kit.db.totpSecret.rows[0]?.['enabledAt']).toBeNull();
    expect(kit.db.auditLog.rows.map((row) => row['action'])).toEqual(['admin.2fa_failed']);
    expect(JSON.stringify(kit.db.auditLog.rows)).not.toContain(start.secret);
  });
});

describe('AdminSecurityService — mot de passe à la confirmation (m4)', () => {
  it('mot de passe actuel vérifié (compteur commun) avant le code ; refus : 2FA non activée', async () => {
    const kit = setup();
    const start = await kit.service.startEnrollment(USER, T0);
    await expect(kit.service.confirmEnrollment(USER, SESSION, codeFor(start.secret, T0), 'mauvais mot de passe', client, T0)).rejects.toMatchObject({
      code: 'AUTH_INVALID_CREDENTIALS',
    });
    expect(kit.auth.confirmPassword).toHaveBeenCalledWith(expect.objectContaining({ id: USER }), 'mauvais mot de passe', client, 'admin.2fa_enroll');
    expect(kit.db.totpSecret.rows[0]?.['enabledAt']).toBeNull();
    await expect(kit.service.confirmEnrollment(USER, SESSION, codeFor(start.secret, T0), PASSWORD, client, T0)).resolves.toMatchObject({ status: { enrolled: true } });
  });
});

describe('AdminSecurityService — vérification', () => {
  it('code TOTP valide : session vérifiée ; rejeu du même code refusé', async () => {
    const kit = await enrolled();
    await kit.service.end(USER, SESSION, client);
    expect((await kit.service.status(USER, SESSION, T0)).verified).toBe(false);
    const at = later(60_000);
    const code = codeFor(kit.secret, at);
    await expect(kit.service.verify(USER, SESSION, { method: 'totp', code }, client, at)).resolves.toMatchObject({ verified: true });
    await expect(kit.service.verify(USER, SESSION, { method: 'totp', code }, client, at)).rejects.toMatchObject({ code: 'ADMIN_2FA_INVALID' });
    const actions = kit.db.auditLog.rows.map((row) => row['action']);
    expect(actions).toEqual(expect.arrayContaining(['admin.session_ended', 'admin.2fa_verified', 'admin.2fa_failed']));
  });

  it('code de secours : usage unique, décompte', async () => {
    const kit = await enrolled();
    const code = kit.recoveryCodes[0] ?? '';
    await expect(kit.service.verify(USER, SESSION, { method: 'recovery', code }, client, T0)).resolves.toMatchObject({ recoveryCodesRemaining: 9 });
    await expect(kit.service.verify(USER, SESSION, { method: 'recovery', code }, client, T0)).rejects.toMatchObject({ code: 'ADMIN_2FA_INVALID' });
    expect(kit.db.auditLog.rows.map((row) => row['action'])).toContain('admin.recovery_code_used');
  });

  it('anti-force brute : 5 codes faux → 429, même avec un bon code ensuite', async () => {
    const kit = await enrolled();
    const at = later(120_000);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(kit.service.verify(USER, SESSION, { method: 'totp', code: '000000' }, client, at)).rejects.toMatchObject({ code: 'ADMIN_2FA_INVALID' });
    }
    await expect(kit.service.verify(USER, SESSION, { method: 'recovery', code: 'AAAAA-AAAAA' }, client, at)).rejects.toMatchObject({ code: 'ADMIN_2FA_LOCKED' });
    await expect(kit.service.verify(USER, SESSION, { method: 'totp', code: codeFor(kit.secret, at) }, client, at)).rejects.toMatchObject({ code: 'ADMIN_2FA_LOCKED' });
  });

  it('rafale parallèle (I1) : 20 vérifications simultanées → au plus 5 codes évalués, les autres en 429', async () => {
    const kit = await enrolled();
    const evaluations = jest.spyOn(kit.db.totpSecret, 'findUnique');
    evaluations.mockClear();
    const at = later(150_000);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) => kit.service.verify(USER, SESSION, { method: 'totp', code: String(100000 + index) }, client, at)),
    );
    const codes = results.map((result) => (result.status === 'rejected' ? (result.reason as { code: string }).code : 'OK'));
    expect(codes.filter((code) => code === 'ADMIN_2FA_LOCKED').length).toBeGreaterThanOrEqual(15);
    // Chaque évaluation relit le secret une fois : au plus ADMIN_TOTP_MAX_ATTEMPTS lectures.
    expect(evaluations.mock.calls.length).toBeLessThanOrEqual(kit.config.admin.totpMaxAttempts);
    expect(kit.db.auditLog.rows.filter((row) => row['action'] === 'admin.2fa_failed').length).toBeLessThanOrEqual(5);
  });

  it('succès : compteur remis à zéro (les tentatives suivantes repartent de 1)', async () => {
    const kit = await enrolled();
    const at = later(60_000);
    await expect(kit.service.verify(USER, SESSION, { method: 'totp', code: '000000' }, client, at)).rejects.toMatchObject({ code: 'ADMIN_2FA_INVALID' });
    await kit.service.verify(USER, SESSION, { method: 'totp', code: codeFor(kit.secret, at) }, client, at);
    await expect(kit.attempts.counters.get('rj:admin-2fa-fail:' + USER)).resolves.toBe(0);
  });

  it('sans 2FA activée : 403 ENROLLMENT_REQUIRED', async () => {
    const kit = setup();
    await expect(kit.service.verify(USER, SESSION, { method: 'totp', code: '123456' }, client, T0)).rejects.toMatchObject({ code: 'ADMIN_2FA_ENROLLMENT_REQUIRED' });
    await expect(kit.service.verify(USER, SESSION, { method: 'recovery', code: 'AAAAA-AAAAA' }, client, T0)).rejects.toMatchObject({ code: 'ADMIN_2FA_ENROLLMENT_REQUIRED' });
  });

  it('secret illisible (clé changée) : code refusé', async () => {
    const kit = await enrolled();
    (kit.db.totpSecret.rows[0] as Record<string, unknown>)['secretEncrypted'] = 'v1.corrompu';
    await expect(kit.service.verifyFreshTotp(USER, codeFor(kit.secret, later(60_000)), client, later(60_000))).rejects.toMatchObject({ code: 'ADMIN_2FA_INVALID' });
  });

  it('statut : session expirée après 30 min d’inactivité', async () => {
    const kit = await enrolled();
    expect((await kit.service.status(USER, SESSION, later(29 * 60_000))).verified).toBe(true);
    expect(await kit.service.status(USER, SESSION, later(31 * 60_000))).toMatchObject({ verified: false, idleExpiresAt: null });
  });
});

describe('AdminSecurityService — codes de secours', () => {
  it('régénération sur code TOTP frais : anciens codes invalidés', async () => {
    const kit = await enrolled();
    const at = later(90_000);
    const fresh = await kit.service.regenerateRecoveryCodes(USER, codeFor(kit.secret, at), client, at);
    expect(fresh.codes).toHaveLength(10);
    expect(fresh.codes).not.toContain(kit.recoveryCodes[0]);
    await expect(kit.service.verify(USER, SESSION, { method: 'recovery', code: kit.recoveryCodes[0] ?? '' }, client, at)).rejects.toMatchObject({ code: 'ADMIN_2FA_INVALID' });
    await expect(kit.service.verify(USER, SESSION, { method: 'recovery', code: fresh.codes[0] ?? '' }, client, at)).resolves.toMatchObject({ verified: true });
    expect(kit.db.auditLog.rows.map((row) => row['action'])).toContain('admin.recovery_codes_regenerated');
  });

  it('fin de session admin sans session vérifiée : pas d’audit', async () => {
    const kit = setup();
    await kit.service.end(USER, SESSION, client);
    expect(kit.db.auditLog.rows).toHaveLength(0);
  });
});
