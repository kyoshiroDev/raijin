import {
  AUTH_EMAIL_LINK_PATHS,
  publicUserSchema,
  trialConversionReportSchema,
  trialRecapSchema,
  watchListResponseSchema,
} from '@raijin/shared-contracts';
import axios from 'axios';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { ApiClient, MAILPIT_URL, tokenFrom, uniqueEmail, uniqueFreeEmail, waitForMail } from '../support/client';

/**
 * Essai Pro de 7 jours sans carte (phase 6, docs/ARCHITECTURE.md §13) contre l'API réelle (Postgres, Redis/BullMQ,
 * Mailpit) : démarrage à la vérification de l'e-mail, anti-abus (domaine jetable, e-mail déjà utilisé après
 * suppression du compte, même empreinte IP + navigateur), job de fin d'essai sous horloge simulée
 * (`POST internal/trial/tick {now, userId}`, limité au compte du test), e-mails J+1 / J-2 une seule fois, J0,
 * suivis au-delà de 3 mis en pause puis choix des suivis gardés, tableau de conversion réservé à l'ADMIN.
 */
const PASSWORD = 'une phrase de passe e2e solide';
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://raijin:changeme-factice@localhost:5433/raijin?schema=public';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Code TOTP RFC 6238 (HMAC-SHA1, 6 chiffres, 30 s) d'un secret base32 (2FA admin). */
function totp(secret: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)?.map((byte) => parseInt(byte, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

function randomIp(): string {
  const b = randomBytes(3);
  return `10.${b[0]}.${b[1]}.${b[2]}`;
}

/** Adresse base58 de 32 octets, unique par test (aucune existence on-chain, jamais réanalysée ici). */
function randomMint(): string {
  let n = BigInt(`0x${createHash('sha256').update(randomUUID()).digest('hex')}`) | (1n << 255n);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
}

async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
  const pg = new PgClient({ connectionString: DATABASE_URL });
  await pg.connect();
  try {
    return (await pg.query(query, params)).rows as T[];
  } finally {
    await pg.end();
  }
}

/** Inscription + vérification depuis une IP et un navigateur donnés. */
async function verifiedUser(email: string, ip = randomIp(), userAgent = `e2e-${randomUUID()}`): Promise<ApiClient> {
  const client = new ApiClient();
  client.headers['X-Forwarded-For'] = ip;
  client.headers['User-Agent'] = userAgent;
  await client.init();
  expect((await client.post('/auth/register', { email, password: PASSWORD, acceptTerms: true })).status).toBe(202);
  const text = await waitForMail(email, 'Confirme ton adresse');
  expect((await client.post('/auth/verify-email', { token: tokenFrom(text, AUTH_EMAIL_LINK_PATHS.verifyEmail) })).status).toBe(200);
  return client;
}

async function me(client: ApiClient) {
  const res = await client.get('/users/me');
  expect(res.status).toBe(200);
  return publicUserSchema.parse(res.data);
}

async function refusalReason(email: string): Promise<string | undefined> {
  const rows = await sql<{ reason: string }>(
    `SELECT e."properties"->>'reason' AS reason FROM "ProductEvent" e JOIN "User" u ON u."id" = e."userId" WHERE u."email" = $1 AND e."type" = 'trial_refused'`,
    [email],
  );
  return rows[0]?.reason;
}

/** Heure de Paris d'un instant. */
function parisHour(date: Date): number {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Paris' }).format(date));
}

/** Premier instant ≥ `from` (par pas de 30 min) entre 10 h et 21 h à Paris : fenêtre d'envoi des e-mails J+1 / J-2. */
function nextSendingSlot(from: Date): Date {
  let at = new Date(from.getTime() + 60_000);
  while (parisHour(at) < 10 || parisHour(at) >= 21) at = new Date(at.getTime() + 30 * 60_000);
  return at;
}

async function tick(client: ApiClient, now: Date, userId: string) {
  const res = await client.post<Record<string, number>>('/internal/trial/tick', { now: now.toISOString(), userId });
  expect(res.status).toBe(200);
  return res.data;
}

interface MailpitMessage {
  Subject: string;
  To: { Address: string }[];
}

async function mailCount(to: string, subject: string): Promise<number> {
  const list = await axios.get<{ messages: MailpitMessage[] }>(`${MAILPIT_URL}/api/v1/messages?limit=500`);
  return list.data.messages.filter((m) => m.To.some((t) => t.Address === to) && m.Subject.includes(subject)).length;
}

describe('API Raijin : essai Pro 7 jours (anti-abus, fin d’essai sous horloge simulée)', () => {
  it('vérification de l’e-mail → essai Pro actif, bienvenue qui l’annonce, récapitulatif, limites Pro', async () => {
    const email = uniqueEmail('essai');
    const client = await verifiedUser(email);
    const user = await me(client);
    expect(user).toMatchObject({ plan: 'PRO', trial: { status: 'active' } });
    const ends = Date.parse(user.trial.endsAt ?? '');
    const starts = Date.parse(user.trial.startedAt ?? '');
    expect(ends - starts).toBe(7 * DAY);
    const welcome = await waitForMail(email, 'Bienvenue sur Raijin');
    expect(welcome).toContain('essai Pro de 7 jours');
    const recap = trialRecapSchema.parse((await client.get('/trial/recap')).data);
    expect(recap).toMatchObject({ status: 'active', analysesCount: 0, activeWatches: 0 });
    const watches = watchListResponseSchema.parse((await client.get('/watches')).data);
    expect(watches.limits).toMatchObject({ plan: 'FREE', trialActive: true, maxActiveWatches: 50, pushAlerts: true, alertHistoryDays: 90 });
    const quota = (await client.get<{ limit: number }>('/analyses/quota')).data;
    expect(quota.limit).toBe(50);
    expect((await client.get('/wallet-scans/quota')).data).toMatchObject({ allowed: true, quota: { limit: 10 } });
    const events = await sql(`SELECT e."type" FROM "ProductEvent" e JOIN "User" u ON u."id" = e."userId" WHERE u."email" = $1 AND e."type" = 'trial_started'`, [email]);
    expect(events).toHaveLength(1);
  });

  it('domaine jetable : compte en Gratuit, message neutre, aucun motif exposé', async () => {
    const email = uniqueFreeEmail('jetable');
    const client = await verifiedUser(email);
    expect(await me(client)).toMatchObject({ plan: 'FREE', trial: { status: 'ineligible', startedAt: null, endsAt: null } });
    const welcome = await waitForMail(email, 'Bienvenue sur Raijin');
    expect(welcome).toContain('Ton compte Gratuit est prêt');
    expect(welcome).not.toContain('jetable');
    expect(await refusalReason(email)).toBe('disposable_domain');
    const recap = await client.get('/trial/recap');
    expect(recap.status).toBe(404);
    expect(recap.data).toEqual({ code: 'TRIAL_NOT_FOUND', message: expect.any(String) });
  });

  it('un essai par e-mail : supprimer puis recréer le compte (même alias +) ne redonne pas d’essai', async () => {
    const base = uniqueEmail('rejoue');
    const first = await verifiedUser(base);
    expect((await me(first)).trial.status).toBe('active');
    expect((await first.delete('/users/me', { password: PASSWORD })).status).toBe(204);
    const alias = base.replace('@', '+bis@');
    const second = await verifiedUser(alias);
    expect(await me(second)).toMatchObject({ plan: 'FREE', trial: { status: 'ineligible' } });
    expect(await refusalReason(alias)).toBe('email_already_used');
  });

  it('même empreinte (IP /64 + navigateur) dans les 90 jours : second compte en Gratuit', async () => {
    const ip = randomIp();
    const userAgent = `e2e-meme-machine-${randomUUID()}`;
    const first = await verifiedUser(uniqueEmail('empreinte-a'), ip, userAgent);
    expect((await me(first)).trial.status).toBe('active');
    const email = uniqueEmail('empreinte-b');
    const second = await verifiedUser(email, ip, userAgent);
    expect((await me(second)).trial.status).toBe('ineligible');
    expect(await refusalReason(email)).toBe('fingerprint_seen');
  });

  it('J+1 et J-2 une seule fois, puis expiration : Gratuit, suivis 4-5 en pause, e-mail J0, choix des 3 suivis gardés', async () => {
    const email = uniqueEmail('fin-essai');
    const client = await verifiedUser(email);
    const user = await me(client);
    const startedAt = new Date(user.trial.startedAt ?? '');
    const endsAt = new Date(user.trial.endsAt ?? '');

    // 5 suivis (plus anciens d'abord) posés en base : la fin d'essai doit en mettre 2 en pause.
    for (let index = 0; index < 5; index += 1) {
      await sql(`INSERT INTO "Watch" ("id", "userId", "mint", "status", "createdAt") VALUES ($1, $2, $3, 'active', $4)`, [
        randomUUID(),
        user.id,
        randomMint(),
        new Date(startedAt.getTime() + (index + 1) * 60_000),
      ]);
    }
    expect(watchListResponseSchema.parse((await client.get('/watches')).data).activeCount).toBe(5);

    const day1 = nextSendingSlot(new Date(startedAt.getTime() + DAY));
    expect(await tick(client, day1, user.id)).toMatchObject({ day1: 1, expired: 0 });
    expect(await tick(client, new Date(day1.getTime() + HOUR), user.id)).toMatchObject({ day1: 0 });
    await waitForMail(email, 'Voilà ce que Raijin a vérifié pour toi');

    const minus2 = nextSendingSlot(new Date(endsAt.getTime() - 2 * DAY));
    expect(await tick(client, minus2, user.id)).toMatchObject({ dayMinus2: 1, expired: 0 });
    expect(await tick(client, new Date(minus2.getTime() + HOUR), user.id)).toMatchObject({ dayMinus2: 0 });
    const j2 = await waitForMail(email, 'Ton essai se termine dans 2 jours');
    expect(j2).toContain('Garder Pro');
    expect(j2).toContain('pas un conseil en investissement');

    // Avant l'échéance : rien ; après : fin d'essai.
    expect(await tick(client, new Date(endsAt.getTime() - 60_000), user.id)).toMatchObject({ expired: 0 });
    expect(await tick(client, new Date(endsAt.getTime() + 5 * 60_000), user.id)).toMatchObject({ expired: 1, pausedWatches: 2, ended: 1 });
    expect(await tick(client, new Date(endsAt.getTime() + 2 * HOUR), user.id)).toMatchObject({ expired: 0, ended: 0 });
    const j0 = await waitForMail(email, 'Tu repasses en Gratuit');
    expect(j0).toContain('2 suivis ont été mis en pause');

    const [row] = await sql<{ trialStatus: string; plan: string }>(`SELECT "trialStatus", "plan" FROM "User" WHERE "id" = $1`, [user.id]);
    expect(row).toEqual({ trialStatus: 'ENDED', plan: 'FREE' });
    const expired = await sql<{ properties: Record<string, unknown> }>(`SELECT "properties" FROM "ProductEvent" WHERE "userId" = $1 AND "type" = 'trial_expired'`, [user.id]);
    expect(expired.map((event) => event.properties)).toEqual([{ pausedWatches: 2 }]);

    // L'essai est réellement terminé (date de fin avancée en base pour l'horloge réelle du reste de l'API).
    await sql(`UPDATE "User" SET "trialEndsAt" = now() - interval '1 hour' WHERE "id" = $1`, [user.id]);
    const after = await me(client);
    expect(after).toMatchObject({ plan: 'FREE', trial: { status: 'ended' } });
    const list = watchListResponseSchema.parse((await client.get('/watches')).data);
    expect(list).toMatchObject({ activeCount: 3, pausedCount: 2, limits: { maxActiveWatches: 3, trialActive: false } });
    const paused = list.items.filter((item) => item.status === 'paused');
    expect(paused.every((item) => item.pausedReason === 'plan_limit')).toBe(true);
    const recap = trialRecapSchema.parse((await client.get('/trial/recap')).data);
    expect(recap).toMatchObject({ status: 'ended', activeWatches: 3, planLimitPausedWatches: 2 });

    // Choix des 3 suivis gardés : 2 en pause + 1 actif ; les 2 autres actifs passent en pause (jamais supprimés).
    const active = list.items.filter((item) => item.status === 'active');
    const keep = [paused[0]?.id, paused[1]?.id, active[0]?.id] as string[];
    const tooMany = await client.post('/watches/keep', { watchIds: [...keep, active[1]?.id] });
    expect(tooMany.status).toBe(400);
    expect(tooMany.data['code']).toBe('WATCH_KEEP_INVALID');
    const kept = await client.post('/watches/keep', { watchIds: keep });
    expect(kept.status).toBe(200);
    const result = watchListResponseSchema.parse(kept.data);
    expect(result).toMatchObject({ activeCount: 3, pausedCount: 2 });
    expect(result.items.filter((item) => item.status === 'active').map((item) => item.id).sort()).toEqual([...keep].sort());
    expect(result.items).toHaveLength(5);

    // Écran de fin vu : posé une fois ; CSRF exigé.
    const noCsrf = client.clone();
    noCsrf.csrfToken = '';
    expect((await noCsrf.post('/trial/end-screen/seen')).status).toBe(403);
    expect((await client.post('/trial/end-screen/seen')).status).toBe(204);
    const [seen] = await sql<{ trialEndScreenSeenAt: Date | null }>(`SELECT "trialEndScreenSeenAt" FROM "User" WHERE "id" = $1`, [user.id]);
    expect(seen?.trialEndScreenSeenAt).toBeInstanceOf(Date);

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await mailCount(email, 'Voilà ce que Raijin a vérifié pour toi')).toBe(1);
    expect(await mailCount(email, 'Ton essai se termine dans 2 jours')).toBe(1);
    expect(await mailCount(email, 'Tu repasses en Gratuit')).toBe(1);
  });

  it('keep : suivis d’un autre compte refusés (400 sans indice), sans session 401', async () => {
    const owner = await verifiedUser(uniqueFreeEmail('keep-a'));
    const intruder = await verifiedUser(uniqueFreeEmail('keep-b'));
    const ownerId = (await me(owner)).id;
    const watchId = randomUUID();
    await sql(`INSERT INTO "Watch" ("id", "userId", "mint", "status", "createdAt") VALUES ($1, $2, $3, 'active', now())`, [watchId, ownerId, randomMint()]);
    const res = await intruder.post('/watches/keep', { watchIds: [watchId] });
    expect(res.status).toBe(400);
    expect(res.data['code']).toBe('WATCH_KEEP_INVALID');
    expect((await (await new ApiClient().init()).post('/watches/keep', { watchIds: [watchId] })).status).toBe(401);
  });

  it('horloge simulée : corps invalide refusé ; tableau de conversion dans l’espace admin (404 non-admin, 2FA exigée)', async () => {
    const client = await verifiedUser(uniqueFreeEmail('admin'));
    expect((await client.post('/internal/trial/tick', { now: 'demain' })).status).toBe(400);
    // Phase 6 bis : sous @AdminRoute(), un non-admin reçoit 404 (espace invisible) au lieu de 403.
    const hidden = await client.get('/admin/trial-conversion');
    expect(hidden.status).toBe(404);
    expect(hidden.data['code']).toBe('NOT_FOUND');
    expect((await (await new ApiClient().init()).get('/admin/trial-conversion')).status).toBe(401);
    const { id } = await me(client);
    await sql(`UPDATE "User" SET "role" = 'ADMIN' WHERE "id" = $1`, [id]);
    const enrollment = await client.get('/admin/trial-conversion');
    expect(enrollment.status).toBe(403);
    expect(enrollment.data['code']).toBe('ADMIN_2FA_ENROLLMENT_REQUIRED');
    const start = await client.post<{ secret: string }>('/admin/security/enrollment');
    expect(start.status).toBe(201);
    expect((await client.post('/admin/security/enrollment/confirm', { code: totp(start.data.secret), currentPassword: PASSWORD })).status).toBe(200);
    const report = await client.get('/admin/trial-conversion');
    expect(report.status).toBe(200);
    const parsed = trialConversionReportSchema.parse(report.data);
    expect(parsed.totals.started).toBeGreaterThan(0);
    expect(parsed.refusals.disposable_domain).toBeGreaterThan(0);
  });
});
