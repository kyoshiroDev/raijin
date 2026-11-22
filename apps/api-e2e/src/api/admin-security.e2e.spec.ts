import {
  AUTH_EMAIL_LINK_PATHS,
  adminAuditLogPageSchema,
  adminEnrollmentConfirmResponseSchema,
  adminEnrollmentStartSchema,
  adminSecurityStatusSchema,
  adminUserActionResultSchema,
  adminUserDetailSchema,
  adminUserPageSchema,
} from '@raijin/shared-contracts';
import { execFile } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Redis from 'ioredis';
import { Client as PgClient } from 'pg';
import { ApiClient, tokenFrom, uniqueEmail, uniqueFreeEmail, waitForMail } from '../support/client';

/**
 * Sécurité de l'espace admin (phase 6 bis, docs/ARCHITECTURE.md §14.2, §14.3, §14.8) contre l'API construite :
 * rôle par la CLI (`dist/apps/api/cli.js`), enrôlement 2FA, codes de secours, session admin (inactivité simulée par
 * `internal/admin/age-session`), non-admin = 404, actions sur les comptes auditées, suspension, aucune usurpation.
 */
const PASSWORD = 'une phrase de passe e2e solide';
const ROOT = join(__dirname, '..', '..', '..', '..');
const CLI = join(ROOT, 'dist', 'apps', 'api', 'cli.js');
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://raijin:changeme-factice@localhost:5433/raijin?schema=public';
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6380';
const run = promisify(execFile);

async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
  const pg = new PgClient({ connectionString: DATABASE_URL });
  await pg.connect();
  try {
    return (await pg.query(query, params)).rows as T[];
  } finally {
    await pg.end();
  }
}

function randomIp(): string {
  const b = randomBytes(3);
  return `10.${b[0]}.${b[1]}.${b[2]}`;
}

function freshClient(): ApiClient {
  const client = new ApiClient();
  client.headers['X-Forwarded-For'] = randomIp();
  client.headers['User-Agent'] = `e2e-${randomUUID()}`;
  return client;
}

async function verifiedUser(email: string): Promise<ApiClient> {
  const client = await freshClient().init();
  expect((await client.post('/auth/register', { email, password: PASSWORD, acceptTerms: true })).status).toBe(202);
  const text = await waitForMail(email, 'Confirme ton adresse');
  expect((await client.post('/auth/verify-email', { token: tokenFrom(text, AUTH_EMAIL_LINK_PATHS.verifyEmail) })).status).toBe(200);
  return client;
}

async function userId(email: string): Promise<string> {
  const [row] = await sql<{ id: string }>(`SELECT "id" FROM "User" WHERE "email" = $1`, [email]);
  if (!row) throw new Error('compte introuvable');
  return row.id;
}

/** Code TOTP (RFC 6238) d'un secret base32, `offsetSteps` pas de 30 s plus tard (fenêtre ±1 acceptée par l'API). */
function totp(secret: string, offsetSteps = 0): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)?.map((byte) => parseInt(byte, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offsetSteps));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** CLI d'administration, environnement de l'API de test (base locale). */
async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run('node', [CLI, ...args], { cwd: ROOT, env: { ...process.env, NODE_ENV: 'development' }, timeout: 60_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

const ADMIN_ROUTES = ['/admin/security/status', '/admin/users', '/admin/audit-logs', '/admin/trial-conversion'] as const;

describe('Espace admin : sécurité, comptes, audit', () => {
  const adminEmail = uniqueEmail('admin-securite');
  let admin: ApiClient;
  let adminId: string;
  let secret = '';
  let recoveryCodes: string[] = [];

  beforeAll(async () => {
    admin = await verifiedUser(adminEmail);
    adminId = await userId(adminEmail);
  }, 60_000);

  it('visiteur anonyme : 404 sur admin/* (pas de 401 ni de 403 CSRF qui révéleraient les routes)', async () => {
    const anonymous = freshClient();
    for (const path of ADMIN_ROUTES) expect((await anonymous.get(path)).status).toBe(404);
    // Sans jeton CSRF ni session : 404 aussi (le filtre d'entrée passe avant la garde CSRF).
    expect((await anonymous.post('/admin/security/verify', { method: 'totp', code: '123456' })).status).toBe(404);
  });

  it('compte non admin : toutes les routes admin/* en 404 (espace invisible), mutations comprises', async () => {
    for (const path of ADMIN_ROUTES) {
      const res = await admin.get(path);
      expect(res.status).toBe(404);
      expect(res.data['code']).toBe('NOT_FOUND');
    }
    expect((await admin.post('/admin/security/enrollment')).status).toBe(404);
    expect((await admin.post(`/admin/users/${adminId}/actions`, { type: 'resend_verification' })).status).toBe(404);
  });

  it('CLI make-admin : arguments invalides refusés, compte inconnu refusé, rôle attribué et audité', async () => {
    expect((await cli('make-admin', '--email=pas-un-email')).code).toBe(2);
    expect((await cli('make-admin', `--email=${uniqueEmail('inconnu')}`)).code).toBe(1);
    const granted = await cli('make-admin', `--email=${adminEmail}`);
    expect(granted.code).toBe(0);
    expect(granted.stdout).toContain('Rôle admin attribué');
    const [audit] = await sql<{ actorKind: string; metadata: unknown }>(
      `SELECT "actorKind", "metadata" FROM "AuditLog" WHERE "userId" = $1::uuid AND "action" = 'admin.role_granted'`,
      [adminId],
    );
    expect(audit).toMatchObject({ actorKind: 'cli', metadata: { before: { role: 'USER' }, after: { role: 'ADMIN' } } });
  }, 120_000);

  it('admin sans 2FA : 403 ADMIN_2FA_ENROLLMENT_REQUIRED, statut lisible, no-store', async () => {
    const blocked = await admin.get('/admin/users');
    expect(blocked.status).toBe(403);
    expect(blocked.data['code']).toBe('ADMIN_2FA_ENROLLMENT_REQUIRED');
    expect(blocked.headers['cache-control']).toBe('no-store');
    const status = await admin.get('/admin/security/status');
    expect(status.status).toBe(200);
    expect(adminSecurityStatusSchema.parse(status.data)).toMatchObject({ enrolled: false, verified: false, recoveryCodesRemaining: null });
  });

  it('enrôlement : QR + secret, code faux refusé, confirmation → 10 codes de secours et session vérifiée', async () => {
    const start = await admin.post('/admin/security/enrollment');
    expect(start.status).toBe(201);
    const enrollment = adminEnrollmentStartSchema.parse(start.data);
    secret = enrollment.secret;
    expect(start.headers['set-cookie']).toBeUndefined();
    const badPassword = await admin.post('/admin/security/enrollment/confirm', { code: totp(secret), currentPassword: 'mauvais mot de passe e2e' });
    expect(badPassword.status).toBe(400);
    expect(badPassword.data['code']).toBe('AUTH_INVALID_CREDENTIALS');
    expect((await admin.post('/admin/security/enrollment/confirm', { code: totp(secret) })).status).toBe(400);
    const wrong = await admin.post('/admin/security/enrollment/confirm', { code: totp(secret, 5), currentPassword: PASSWORD });
    expect(wrong.status).toBe(400);
    expect(wrong.data['code']).toBe('ADMIN_2FA_INVALID');
    const confirm = await admin.post('/admin/security/enrollment/confirm', { code: totp(secret), currentPassword: PASSWORD });
    expect(confirm.status).toBe(200);
    const body = adminEnrollmentConfirmResponseSchema.parse(confirm.data);
    recoveryCodes = body.recoveryCodes.codes;
    expect(body.status).toMatchObject({ enrolled: true, verified: true, recoveryCodesRemaining: 10 });
    const [row] = await sql<{ secretEncrypted: string }>(`SELECT "secretEncrypted" FROM "TotpSecret" WHERE "userId" = $1::uuid`, [adminId]);
    expect(row?.secretEncrypted.startsWith('v1.')).toBe(true);
    expect(row?.secretEncrypted).not.toContain(secret);
    expect((await admin.post('/admin/security/enrollment')).data['code']).toBe('ADMIN_2FA_ALREADY_ENROLLED');
  });

  it('session vérifiée : accès, no-store, aucune route admin ne pose de cookie (pas d’usurpation)', async () => {
    for (const path of ADMIN_ROUTES) {
      const res = await admin.get(path);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('inactivité de 30 min (horloge simulée) : 403 ADMIN_SESSION_EXPIRED ; code de secours → session rouverte ; rejeu refusé', async () => {
    expect((await admin.post('/internal/admin/age-session', { minutes: 31 })).status).toBe(204);
    const expired = await admin.get('/admin/users');
    expect(expired.status).toBe(403);
    expect(expired.data['code']).toBe('ADMIN_SESSION_EXPIRED');
    expect((await admin.get('/admin/users')).data['code']).toBe('ADMIN_2FA_REQUIRED');
    // La session de l'app reste ouverte (403, jamais 401).
    expect((await admin.get('/users/me')).status).toBe(200);
    const code = recoveryCodes[0] ?? '';
    const verified = await admin.post('/admin/security/verify', { method: 'recovery', code });
    expect(verified.status).toBe(200);
    expect(adminSecurityStatusSchema.parse(verified.data)).toMatchObject({ verified: true, recoveryCodesRemaining: 9 });
    expect((await admin.post('/admin/security/verify', { method: 'recovery', code })).data['code']).toBe('ADMIN_2FA_INVALID');
    expect((await admin.get('/admin/users')).status).toBe(200);
  });

  it('rafale parallèle de codes faux (I1) : au plus ADMIN_TOTP_MAX_ATTEMPTS évalués, le reste en 429', async () => {
    const before = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM "AuditLog" WHERE "userId" = $1::uuid AND "action" = 'admin.2fa_failed'`, [adminId]);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => admin.post('/admin/security/verify', { method: 'totp', code: String(200000 + index) })),
    );
    expect(results.filter((res) => res.status === 429).length).toBeGreaterThanOrEqual(15);
    const after = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM "AuditLog" WHERE "userId" = $1::uuid AND "action" = 'admin.2fa_failed'`, [adminId]);
    expect(Number(after[0]?.n) - Number(before[0]?.n)).toBeLessThanOrEqual(5);
    // Fin du blocage (compteur Redis de l'instance de test) pour la suite du parcours.
    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    try {
      await redis.del(`rj:admin-2fa-fail:${adminId}`);
    } finally {
      redis.disconnect();
    }
  });

  it('durée maximale de 8 h : expirée même avec de l’activité', async () => {
    expect((await admin.post('/internal/admin/age-session', { minutes: 8 * 60 + 1 })).status).toBe(204);
    // L'âge simulé recule aussi la dernière activité : on la remet à maintenant pour isoler la durée maximale.
    await sql(`UPDATE "Session" SET "adminLastSeenAt" = now() WHERE "userId" = $1::uuid AND "adminVerifiedAt" IS NOT NULL`, [adminId]);
    expect((await admin.get('/admin/users')).data['code']).toBe('ADMIN_SESSION_EXPIRED');
    expect((await admin.post('/admin/security/verify', { method: 'recovery', code: recoveryCodes[1] ?? '' })).status).toBe(200);
  });

  it('recherche et fiche auditées ; Pro offert un mois (source gift) ; journal paginé', async () => {
    const targetEmail = uniqueFreeEmail('cible-gift');
    const target = await verifiedUser(targetEmail);
    const targetId = await userId(targetEmail);
    const search = await admin.get(`/admin/users?q=${encodeURIComponent(targetEmail.slice(0, 18))}`);
    expect(search.status).toBe(200);
    const page = adminUserPageSchema.parse(search.data);
    expect(page.items.map((item) => item.id)).toContain(targetId);
    expect((await admin.get('/admin/users?q=%25%25%25')).data['total']).toBe(0);
    const detail = adminUserDetailSchema.parse((await admin.get(`/admin/users/${targetId}`)).data);
    expect(detail).toMatchObject({ plan: 'FREE', planSource: 'free', status: 'active' });
    expect(detail.availableActions).toEqual(expect.arrayContaining(['grant_pro_month', 'suspend', 'delete']));
    expect(detail.availableActions).not.toContain('extend_trial');

    const missingReason = await admin.post(`/admin/users/${targetId}/actions`, { type: 'grant_pro_month', reason: '' });
    expect(missingReason.status).toBe(400);
    const granted = await admin.post(`/admin/users/${targetId}/actions`, { type: 'grant_pro_month', reason: 'Bêta-testeur e2e' });
    expect(granted.status).toBe(200);
    const result = adminUserActionResultSchema.parse(granted.data);
    expect(result.user).toMatchObject({ plan: 'PRO', planSource: 'gift' });
    const account = await target.get<{ source: string; giftEndsAt: string | null }>('/billing/subscription');
    expect(account.data).toMatchObject({ source: 'gift' });
    expect(account.data.giftEndsAt).not.toBeNull();

    const actions = (await sql<{ action: string; metadata: Record<string, unknown> | null }>(
      `SELECT "action", "metadata" FROM "AuditLog" WHERE "actorId" = $1::uuid ORDER BY "createdAt"`,
      [adminId],
    )).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(['admin.user_searched', 'admin.user_viewed', 'admin.pro_month_granted', 'admin.2fa_enrolled', 'admin.recovery_code_used']));
    const searched = await sql<{ metadata: string }>(`SELECT "metadata"::text FROM "AuditLog" WHERE "actorId" = $1::uuid AND "action" = 'admin.user_searched'`, [adminId]);
    for (const row of searched) expect(row.metadata).not.toContain(targetEmail.slice(0, 18));

    const journal = adminAuditLogPageSchema.parse((await admin.get(`/admin/audit-logs?userId=${targetId}&limit=5`)).data);
    expect(journal.items.map((entry) => entry.action)).toEqual(expect.arrayContaining(['admin.pro_month_granted', 'admin.user_viewed']));
    expect(journal.items.find((entry) => entry.action === 'admin.pro_month_granted')?.actor?.id).toBe(adminId);
  }, 60_000);

  it('suspension : e-mail recopié exigé, sessions coupées, connexion et refresh → 403 ACCOUNT_SUSPENDED ; réactivation', async () => {
    const targetEmail = uniqueEmail('cible-suspension');
    const target = await verifiedUser(targetEmail);
    const targetId = await userId(targetEmail);
    const mismatch = await admin.post(`/admin/users/${targetId}/actions`, { type: 'suspend', reason: 'Abus e2e', confirmEmail: 'autre@exemple.fr' });
    expect(mismatch.data['code']).toBe('ADMIN_CONFIRMATION_MISMATCH');
    const suspended = await admin.post(`/admin/users/${targetId}/actions`, { type: 'suspend', reason: 'Abus e2e', confirmEmail: targetEmail });
    expect(suspended.status).toBe(200);
    expect(adminUserActionResultSchema.parse(suspended.data).user).toMatchObject({ status: 'suspended' });

    expect((await target.get('/users/me')).status).toBe(401);
    const refresh = await target.post('/auth/refresh');
    expect(refresh.status).toBe(403);
    expect(refresh.data['code']).toBe('ACCOUNT_SUSPENDED');
    const login = await (await freshClient().init()).post('/auth/login', { email: targetEmail, password: PASSWORD });
    expect(login.status).toBe(403);
    expect(login.data['code']).toBe('ACCOUNT_SUSPENDED');
    // Mauvais mot de passe : même réponse qu'un compte quelconque (pas d'énumération).
    const wrong = await (await freshClient().init()).post('/auth/login', { email: targetEmail, password: 'mauvais mot de passe e2e' });
    expect(wrong.data['code']).toBe('AUTH_INVALID_CREDENTIALS');

    expect((await admin.post(`/admin/users/${targetId}/actions`, { type: 'reactivate', reason: 'Levée e2e' })).status).toBe(200);
    expect((await (await freshClient().init()).post('/auth/login', { email: targetEmail, password: PASSWORD })).status).toBe(200);
    const audited = await sql<{ action: string; metadata: { before?: unknown; after?: unknown; reason?: string } }>(
      `SELECT "action", "metadata" FROM "AuditLog" WHERE "userId" = $1::uuid AND "action" IN ('admin.user_suspended', 'admin.user_reactivated') ORDER BY "createdAt"`,
      [targetId],
    );
    expect(audited).toEqual([
      expect.objectContaining({ action: 'admin.user_suspended', metadata: expect.objectContaining({ reason: 'Abus e2e', before: { suspendedAt: null } }) }),
      expect.objectContaining({ action: 'admin.user_reactivated', metadata: expect.objectContaining({ after: { suspendedAt: null } }) }),
    ]);
  }, 60_000);

  it('actions interdites sur un admin et sur soi-même ; compte inconnu : 404', async () => {
    const self = await admin.post(`/admin/users/${adminId}/actions`, { type: 'grant_pro_month', reason: 'Moi-même' });
    expect(self.status).toBe(409);
    expect(self.data['code']).toBe('ADMIN_ACTION_NOT_ALLOWED');
    expect((await admin.get(`/admin/users/${randomUUID()}`)).status).toBe(404);
    expect((await admin.get('/admin/users/pas-un-uuid')).status).toBe(404);
  });

  it('suppression RGPD : e-mail recopié + code TOTP frais ; audit conservé sans e-mail', async () => {
    const targetEmail = uniqueEmail('cible-suppression');
    await verifiedUser(targetEmail);
    const targetId = await userId(targetEmail);
    const wrongCode = await admin.post(`/admin/users/${targetId}/actions`, { type: 'delete', reason: 'Demande RGPD e2e', confirmEmail: targetEmail, totpCode: totp(secret, 9) });
    expect(wrongCode.data['code']).toBe('ADMIN_2FA_INVALID');
    const deleted = await admin.post(`/admin/users/${targetId}/actions`, { type: 'delete', reason: 'Demande RGPD e2e', confirmEmail: targetEmail, totpCode: totp(secret, 1) });
    expect(deleted.status).toBe(200);
    expect(adminUserActionResultSchema.parse(deleted.data)).toMatchObject({ type: 'delete', user: null });
    expect(await sql(`SELECT 1 FROM "User" WHERE "id" = $1::uuid`, [targetId])).toHaveLength(0);
    const [entry] = await sql<{ userId: string | null; metadata: string }>(`SELECT "userId", "metadata"::text FROM "AuditLog" WHERE "id" = $1::uuid`, [deleted.data['auditLogId']]);
    expect(entry?.userId).toBeNull();
    expect(entry?.metadata).not.toContain(targetEmail);
  }, 60_000);

  it('CLI admin-reset-2fa puis --revoke : 2FA effacée, puis rôle retiré et sessions révoquées', async () => {
    expect((await cli('admin-reset-2fa', `--email=${adminEmail}`)).code).toBe(0);
    const status = adminSecurityStatusSchema.parse((await admin.get('/admin/security/status')).data);
    expect(status).toMatchObject({ enrolled: false, verified: false });
    expect((await cli('make-admin', `--email=${adminEmail}`, '--revoke')).code).toBe(0);
    expect((await admin.get('/admin/security/status')).status).toBe(401);
    const actions = (await sql<{ action: string }>(`SELECT "action" FROM "AuditLog" WHERE "userId" = $1::uuid AND "actorKind" = 'cli'`, [adminId])).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(['admin.role_granted', 'admin.2fa_reset', 'admin.role_revoked']));
  }, 120_000);
});
