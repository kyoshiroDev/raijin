import {
  AUTH_EMAIL_LINK_PATHS,
  alertListResponseSchema,
  notificationSettingsSchema,
  pushNotificationPayloadSchema,
  watchListResponseSchema,
  watchSchema,
} from '@raijin/shared-contracts';
import axios from 'axios';
import { randomBytes } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { ApiClient, MAILPIT_URL, tokenFrom, uniqueEmail, waitForMail } from '../support/client';

/**
 * Suivis, jobs, alertes et push contre l'API réelle (Postgres, Redis/BullMQ, Mailpit), sources simulées :
 * le scénario de fixtures en séquence `watch-mint-reactivated` (autorités révoquées → mint réactivé)
 * est avancé par `POST internal/fixtures/:scenario`, les passes déclenchées par `POST internal/jobs/:name/run`
 * (`JOBS_TEST_TRIGGER=1`, `PUSH_PROVIDER=fake`, e-mails groupés après 1 s, délai de grâce coupé).
 */
const SCENARIO = 'watch-mint-reactivated';
const MINT = '6kA3B4uMv3vuePwmUcH5ca3xWtV3KnfHzBfzTtWziG83';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';
const PASSWORD = 'une phrase de passe e2e solide';
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://raijin:changeme-factice@localhost:5433/raijin?schema=public';

function randomIp(): string {
  const b = randomBytes(3);
  return `10.${b[0]}.${b[1]}.${b[2]}`;
}

async function verifiedUser(prefix: string): Promise<{ client: ApiClient; email: string }> {
  const email = uniqueEmail(prefix);
  const client = new ApiClient();
  client.headers['X-Forwarded-For'] = randomIp();
  await client.init();
  expect((await client.post('/auth/register', { email, password: PASSWORD, acceptTerms: true })).status).toBe(202);
  const text = await waitForMail(email, 'Confirme ton adresse');
  expect((await client.post('/auth/verify-email', { token: tokenFrom(text, AUTH_EMAIL_LINK_PATHS.verifyEmail) })).status).toBe(200);
  return { client, email };
}

/** Essai Pro de 7 jours posé directement en base (l'activation de l'essai arrive en phase 6). */
async function startTrial(email: string): Promise<void> {
  const pg = new PgClient({ connectionString: DATABASE_URL });
  await pg.connect();
  try {
    await pg.query(`UPDATE "User" SET "trialStatus" = 'ACTIVE', "trialEndsAt" = now() + interval '7 days' WHERE "email" = $1`, [email]);
  } finally {
    await pg.end();
  }
}

async function runJob(client: ApiClient, name: string, mints?: string[]) {
  const res = await client.post<{ results: Record<string, number>[] }>(`/internal/jobs/${name}/run`, mints ? { mints } : {});
  expect(res.status).toBe(200);
  return res.data.results;
}

async function step(client: ApiClient, value: number): Promise<void> {
  expect((await client.post(`/internal/fixtures/${SCENARIO}`, { step: value })).status).toBe(200);
}

interface MailpitMessage {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

async function waitForHtml(to: string, subject: string, timeoutMs = 15_000): Promise<{ html: string; subject: string; count: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await axios.get<{ messages: MailpitMessage[] }>(`${MAILPIT_URL}/api/v1/messages?limit=200`);
    const found = list.data.messages.filter((m) => m.To.some((t) => t.Address === to) && m.Subject.includes(subject));
    const first = found[0];
    if (first) {
      const message = await axios.get<{ HTML: string }>(`${MAILPIT_URL}/api/v1/message/${first.ID}`);
      return { html: message.data.HTML, subject: first.Subject, count: found.length };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Aucun e-mail « ${subject} » reçu`);
}

describe('API Raijin : suivis, alertes et push (jobs sur fixtures en séquence)', () => {
  let free: { client: ApiClient; email: string };
  let pro: { client: ApiClient; email: string };
  let other: { client: ApiClient; email: string };
  const created: { client: ApiClient; id: string }[] = [];

  beforeAll(async () => {
    [free, pro, other] = await Promise.all([verifiedUser('suivi-gratuit'), verifiedUser('suivi-pro'), verifiedUser('suivi-autre')]);
    await startTrial(pro.email);
    await step(free.client, 0);
  }, 60_000);

  afterAll(async () => {
    // Retire les suivis du test : l'état des mints disparaît, le prochain passage repart d'une référence.
    for (const { client, id } of created) await client.delete(`/watches/${id}`);
  });

  async function follow(client: ApiClient, mint: string, expected = 201) {
    expect((await client.post('/analyses', { input: mint })).status).toBe(200);
    const res = await client.post('/watches', { mint });
    expect(res.status).toBe(expected);
    const watch = watchSchema.parse(res.data);
    if (expected === 201) created.push({ client, id: watch.id });
    return watch;
  }

  it('route interne inconnue ou corps invalide : refus', async () => {
    expect((await free.client.post('/internal/jobs/inconnu/run', {})).status).toBe(400);
    expect((await free.client.post('/internal/fixtures/inconnu', { step: 0 })).status).toBe(404);
  });

  it('suivre : 201 puis 200 (idempotent), sans analyse récente 404, sans session 401', async () => {
    const watch = await follow(free.client, MINT);
    expect(watch).toMatchObject({ mint: MINT, status: 'active', pausedReason: null, unreadAlerts: 0 });
    const again = await free.client.post('/watches', { mint: MINT });
    expect(again.status).toBe(200);
    expect(again.data['id']).toBe(watch.id);
    const unknown = await free.client.post('/watches', { mint: 'Y3Pg4fGfK1jz4exHgF2duMUhZvjAa1FdBuJYMsyZfWD' });
    expect(unknown.status).toBe(404);
    expect(unknown.data['code']).toBe('ANALYSIS_NOT_FOUND');
    expect((await new ApiClient().init().then((anon) => anon.get('/watches'))).status).toBe(401);
  });

  it('limite Gratuit 3 relue en base : 4e suivi refusé, pause libère une place, reprise refusée au-delà', async () => {
    const bonk = await follow(free.client, BONK);
    await follow(free.client, USDC);
    expect((await free.client.post('/analyses', { input: PYUSD })).status).toBe(200);
    const over = await free.client.post('/watches', { mint: PYUSD });
    expect(over.status).toBe(403);
    expect(over.data['code']).toBe('WATCH_LIMIT_REACHED');

    const paused = await free.client.patch(`/watches/${bonk.id}`, { status: 'paused' });
    expect(paused.status).toBe(200);
    expect(paused.data).toMatchObject({ status: 'paused', pausedReason: 'user' });
    const pyusd = await free.client.post('/watches', { mint: PYUSD });
    expect(pyusd.status).toBe(201);
    created.push({ client: free.client, id: String(pyusd.data['id']) });
    const resume = await free.client.patch(`/watches/${bonk.id}`, { status: 'active' });
    expect(resume.status).toBe(403);
    expect(resume.data['code']).toBe('WATCH_LIMIT_REACHED');

    const list = watchListResponseSchema.parse((await free.client.get('/watches')).data);
    expect(list.limits).toMatchObject({ plan: 'FREE', trialActive: false, maxActiveWatches: 3, pushAlerts: false, alertHistoryDays: 30 });
    expect(list).toMatchObject({ activeCount: 3, pausedCount: 1 });
  });

  it('ressource d’un autre utilisateur : toujours 404', async () => {
    const mine = watchListResponseSchema.parse((await free.client.get('/watches')).data).items[0];
    expect(mine).toBeDefined();
    const patch = await other.client.patch(`/watches/${mine?.id}`, { status: 'paused' });
    expect(patch.status).toBe(404);
    expect(patch.data['code']).toBe('WATCH_NOT_FOUND');
    expect((await other.client.delete(`/watches/${mine?.id}`)).status).toBe(404);
    expect((await other.client.patch('/watches/pas-un-uuid', { status: 'paused' })).status).toBe(404);
  });

  it('push : Gratuit refusé (PUSH_PLAN_REQUIRED), essai Pro abonné, endpoint hors liste refusé', async () => {
    const key = await new ApiClient().get<{ publicKey: string }>('/push/vapid-public-key');
    expect(key.status).toBe(200);
    expect(key.data.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    const keys = { p256dh: `B${'A'.repeat(86)}`, auth: 'a'.repeat(22) };
    const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-${randomBytes(6).toString('hex')}`;

    const refused = await free.client.post('/push/subscriptions', { endpoint, keys });
    expect(refused.status).toBe(403);
    expect(refused.data['code']).toBe('PUSH_PLAN_REQUIRED');
    const ssrf = await pro.client.post('/push/subscriptions', { endpoint: 'https://169.254.169.254/latest', keys });
    expect(ssrf.status).toBe(400);
    expect(ssrf.data['code']).toBe('PUSH_SUBSCRIPTION_INVALID');

    expect((await pro.client.post('/push/subscriptions', { endpoint, keys })).status).toBe(201);
    const gone = `https://fcm.googleapis.com/fcm/send/gone-${randomBytes(6).toString('hex')}`;
    expect((await pro.client.post('/push/subscriptions', { endpoint: gone, keys })).status).toBe(201);
    const settings = notificationSettingsSchema.parse((await pro.client.get('/notifications/settings')).data);
    expect(settings).toMatchObject({ pushAllowed: true, pushConfigured: true, pushDevices: 2, emailVerified: true });
  });

  it('préférences : push réservé au Pro, résumé hebdomadaire activable', async () => {
    const push = await free.client.patch('/notifications/preferences', { pushAlerts: true });
    expect(push.status).toBe(403);
    expect(push.data['code']).toBe('PUSH_PLAN_REQUIRED');
    const digest = await free.client.patch('/notifications/preferences', { weeklyDigest: true });
    expect(digest.status).toBe(200);
    expect(notificationSettingsSchema.parse(digest.data).preferences).toEqual({ emailAlerts: true, pushAlerts: true, weeklyDigest: true });
    expect((await free.client.patch('/notifications/preferences', {})).status).toBe(400);
  });

  it('passe rapide : référence puis mint réactivé → une seule alerte même rejouée, e-mail et push', async () => {
    await follow(pro.client, MINT);
    // Première observation : référence, aucune alerte.
    const [reference] = await runJob(free.client, 'watch-fast', [MINT]);
    expect(reference).toMatchObject({ mints: 1, events: 0, alerts: 0 });

    await step(free.client, 1);
    const [detected] = await runJob(free.client, 'watch-fast', [MINT]);
    expect(detected?.['events']).toBeGreaterThanOrEqual(1);
    const [replayed] = await runJob(free.client, 'watch-fast', [MINT]);
    expect(replayed).toMatchObject({ events: 0, alerts: 0 });

    const page = alertListResponseSchema.parse((await free.client.get(`/alerts?mint=${MINT}`)).data);
    const reactivated = page.items.filter((alert) => alert.type === 'mint_reactivated');
    expect(reactivated).toHaveLength(1);
    expect(reactivated[0]).toMatchObject({ mint: MINT, severity: 'danger', readAt: null });
    expect(page.unread).toBeGreaterThanOrEqual(1);
    // L'autre compte ne voit rien.
    expect(alertListResponseSchema.parse((await other.client.get('/alerts')).data).items).toHaveLength(0);

    // E-mail groupé (Mailpit) : Rai en PNG 2x avec texte alternatif, lien vers l'analyse, préférences.
    const mail = await waitForHtml(free.email, 'Alerte');
    expect(mail.html).toContain('/email/rai-alerte@2x.png');
    expect(mail.html).toContain('alt="Rai, la mascotte de Raijin, en alerte"');
    expect(mail.html).toContain(`/analyse/${MINT}`);
    expect(mail.html).toContain('pas un conseil en investissement');
    expect(mail.html).toContain('/compte?section=notifications');
    expect(mail.count).toBe(1);

    // Push simulé pour le compte en essai ; l'abonnement expiré (410) est supprimé.
    const proAlerts = alertListResponseSchema.parse((await pro.client.get(`/alerts?mint=${MINT}&types=mint_reactivated`)).data);
    const proAlert = proAlerts.items[0];
    expect(proAlert).toBeDefined();
    const deadline = Date.now() + 15_000;
    let pushed: unknown;
    while (!pushed && Date.now() < deadline) {
      const outbox = await free.client.get<{ items: { payload: { notification: { data: { alertId: string } } } }[] }>('/internal/push/outbox');
      pushed = outbox.data.items.find((item) => item.payload.notification.data.alertId === proAlert?.id)?.payload;
      if (!pushed) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const payload = pushNotificationPayloadSchema.parse(pushed);
    expect(payload.notification.data.onActionClick.default.url).toBe(`/alertes?alerte=${proAlert?.id}`);
    expect(payload.notification.tag).toBe(`alert:${MINT}`);
    expect(JSON.stringify(payload)).not.toContain(pro.email);
    const settings = notificationSettingsSchema.parse((await pro.client.get('/notifications/settings')).data);
    expect(settings.pushDevices).toBe(1);

    // Rejouer l'envoi des e-mails ne renvoie rien.
    await runJob(free.client, 'alert-email');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await waitForHtml(free.email, 'Alerte')).count).toBe(1);
  }, 60_000);

  it('lu / non lu par lot, tout lu, compteur de non-lues', async () => {
    const page = alertListResponseSchema.parse((await free.client.get('/alerts?status=unread')).data);
    const id = page.items[0]?.id as string;
    expect(id).toBeDefined();
    const read = await free.client.post<{ unread: number }>('/alerts/read', { ids: [id], read: true });
    expect(read.status).toBe(200);
    expect(read.data.unread).toBe(page.unread - 1);
    const readList = alertListResponseSchema.parse((await free.client.get('/alerts?status=read')).data);
    expect(readList.items.map((alert) => alert.id)).toContain(id);
    expect((await free.client.post<{ unread: number }>('/alerts/read', { ids: [id], read: false })).data.unread).toBe(page.unread);
    // Identifiant d'un autre compte : ignoré.
    expect((await other.client.post<{ unread: number }>('/alerts/read', { ids: [id], read: true })).data.unread).toBe(0);
    expect((await free.client.post<{ unread: number }>('/alerts/read', { all: true, read: true })).data.unread).toBe(0);
    expect((await free.client.get<{ unread: number }>('/alerts/unread-count')).data.unread).toBe(0);
    expect((await free.client.get('/alerts?cursor=a%2Fb')).status).toBe(400);
  });

  it('passe complète, holders et planificateur : exécutés sans erreur ; purge journalisée', async () => {
    await step(free.client, 2);
    const [full] = await runJob(free.client, 'watch-full', [MINT]);
    expect(full).toMatchObject({ failures: 0 });
    const watches = watchListResponseSchema.parse((await free.client.get('/watches')).data);
    expect(watches.items.find((watch) => watch.mint === MINT)?.lastCheckedAt).not.toBeNull();
    await runJob(free.client, 'watch-holders', [MINT]);
    const [planner] = await runJob(free.client, 'watch-planner');
    expect(planner).toEqual(expect.objectContaining({ mints: expect.any(Number) }));
    const [purge] = await runJob(free.client, 'purge');
    expect(purge).toEqual(expect.objectContaining({ alert: expect.any(Number), jobRun: expect.any(Number), mintWatchState: expect.any(Number) }));
  }, 60_000);
});

describe('API Raijin : holder vendeur (passe holders sur fixtures en séquence)', () => {
  const HOLDER_MINT = '7kyyXC5ZbjLDGucQA2ucEHb6wrq8fiWxDRCcf2HWzQu4';
  let user: { client: ApiClient; email: string };
  let watchId = '';

  beforeAll(async () => {
    user = await verifiedUser('suivi-holder');
    expect((await user.client.post('/internal/fixtures/watch-holder-sold', { step: 0 })).status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    if (watchId) await user.client.delete(`/watches/${watchId}`);
  });

  it('référence puis holder de 10 % qui cède 40 % → holder_sold (Prudence), une seule fois', async () => {
    expect((await user.client.post('/analyses', { input: HOLDER_MINT })).status).toBe(200);
    const created = await user.client.post('/watches', { mint: HOLDER_MINT });
    expect(created.status).toBe(201);
    watchId = watchSchema.parse(created.data).id;

    const [reference] = await runJob(user.client, 'watch-holders', [HOLDER_MINT]);
    expect(reference).toMatchObject({ mints: 1, events: 0, failures: 0 });
    expect((await user.client.post('/internal/fixtures/watch-holder-sold', { step: 1 })).status).toBe(200);
    const [detected] = await runJob(user.client, 'watch-holders', [HOLDER_MINT]);
    expect(detected).toMatchObject({ events: 1, alerts: 1 });
    const [replayed] = await runJob(user.client, 'watch-holders', [HOLDER_MINT]);
    expect(replayed).toMatchObject({ events: 0, alerts: 0 });

    const page = alertListResponseSchema.parse((await user.client.get(`/alerts?types=holder_sold&mint=${HOLDER_MINT}`)).data);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ type: 'holder_sold', severity: 'warn', payload: { beforePct: 10 } });
  }, 60_000);
});
