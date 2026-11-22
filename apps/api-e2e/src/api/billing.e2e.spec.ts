import {
  AUTH_EMAIL_LINK_PATHS,
  billingAccountSchema,
  billingPlansResponseSchema,
  isAllowedBillingRedirect,
  type BillingAccount,
  type BillingRedirect,
} from '@raijin/shared-contracts';
import axios from 'axios';
import type { ChildProcess } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client as PgClient } from 'pg';
import { startApi, stopApi } from '../support/api-server';
import { ApiClient, ORIGIN, tokenFrom, uniqueEmail, waitForMail } from '../support/client';

/**
 * Abonnement (phase 6, docs/ARCHITECTURE.md §13) contre l'API réelle (Postgres, Redis, Mailpit) en mode
 * simulation (`BILLING_PROVIDER=fake` par défaut hors production) : faux Checkout → webhooks signés localement
 * → Pro → faux portail → résiliation → Gratuit en fin de période ; idempotence, ordre, signature, retard de
 * paiement. Une 2e instance en `BILLING_PROVIDER=stripe` sans clé vérifie le mode « paiement indisponible ».
 */
const PASSWORD = 'une phrase de passe e2e solide';
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://raijin:changeme-factice@localhost:5433/raijin?schema=public';

function randomIp(): string {
  const b = randomBytes(3);
  return `10.${b[0]}.${b[1]}.${b[2]}`;
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

async function registered(prefix: string, verify = true): Promise<{ client: ApiClient; email: string; userId: string }> {
  const email = uniqueEmail(prefix);
  const client = new ApiClient();
  client.headers['X-Forwarded-For'] = randomIp();
  await client.init();
  expect((await client.post('/auth/register', { email, password: PASSWORD, acceptTerms: true })).status).toBe(202);
  const text = await waitForMail(email, 'Confirme ton adresse');
  if (verify) expect((await client.post('/auth/verify-email', { token: tokenFrom(text, AUTH_EMAIL_LINK_PATHS.verifyEmail) })).status).toBe(200);
  else await client.post('/auth/login', { email, password: PASSWORD });
  const [row] = await sql<{ id: string }>(`SELECT "id" FROM "User" WHERE "email" = $1`, [email]);
  return { client, email, userId: row?.id ?? '' };
}

async function account(client: ApiClient): Promise<BillingAccount> {
  const res = await client.get<BillingAccount>('/billing/subscription');
  expect(res.status).toBe(200);
  expect(billingAccountSchema.safeParse(res.data).success).toBe(true);
  return res.data;
}

async function checkoutSession(client: ApiClient, interval: 'month' | 'year'): Promise<string> {
  const res = await client.post<BillingRedirect>('/billing/checkout-sessions', { interval });
  expect(res.status).toBe(200);
  expect(isAllowedBillingRedirect(res.data.url, ORIGIN)).toBe(true);
  const url = new URL(res.data.url);
  expect(url.pathname).toBe('/abonnement/simulation');
  return url.searchParams.get('session') ?? '';
}

async function replay(client: ApiClient, name: string, overrides: Record<string, unknown>): Promise<{ eventId: string; outcome: string }> {
  const res = await client.post<{ eventId: string; outcome: string }>(`/internal/billing/webhook-fixtures/${name}`, overrides);
  expect(res.status).toBe(200);
  return res.data;
}

async function subscriptionRow(userId: string) {
  const [row] = await sql<{ stripeSubscriptionId: string; status: string; cancelAtPeriodEnd: boolean; customer: string }>(
    `SELECT s."stripeSubscriptionId", s."status"::text AS "status", s."cancelAtPeriodEnd", u."stripeCustomerId" AS "customer"
       FROM "Subscription" s JOIN "User" u ON u."id" = s."userId" WHERE s."userId" = $1::uuid ORDER BY s."createdAt" DESC LIMIT 1`,
    [userId],
  );
  if (!row) throw new Error('aucun abonnement');
  return row;
}

describe('Abonnement (e2e, simulation)', () => {
  it('plans publics : prix en centimes, droits et mode simulation, aucun identifiant Stripe', async () => {
    const res = await new ApiClient().get('/billing/plans');
    expect(res.status).toBe(200);
    expect(billingPlansResponseSchema.safeParse(res.data).success).toBe(true);
    expect(res.data).toMatchObject({ mode: 'simulation', pro: { monthly: { amountCents: 990 }, yearly: { amountCents: 9900 } } });
    expect(JSON.stringify(res.data)).not.toMatch(/price_|sk_|whsec_/);
  });

  it('Checkout : session, CSRF, e-mail vérifié, seule la périodicité est acceptée', async () => {
    const anonymous = await new ApiClient().init();
    expect((await anonymous.post('/billing/checkout-sessions', { interval: 'month' })).status).toBe(401);
    const unverified = await registered('billing-unverified', false);
    const res = await unverified.client.post('/billing/checkout-sessions', { interval: 'month' });
    expect(res.status).toBe(403);
    expect(res.data).toMatchObject({ code: 'AUTH_EMAIL_NOT_VERIFIED' });
    const { client } = await registered('billing-input');
    const noCsrf = client.clone();
    noCsrf.csrfToken = '';
    expect((await noCsrf.post('/billing/checkout-sessions', { interval: 'month' })).status).toBe(403);
    expect((await client.post('/billing/checkout-sessions', { interval: 'month', priceId: 'price_x' })).data).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect((await client.post('/billing/checkout-sessions', { interval: 'week' })).status).toBe(400);
    const portal = await client.post('/billing/portal-sessions', {});
    expect(portal.status).toBe(409);
    expect(portal.data).toMatchObject({ code: 'NO_BILLING_ACCOUNT' });
  });

  it('parcours complet : essai → faux Checkout → Pro (essai terminé) → reçu → portail → résiliation → Gratuit en fin de période', async () => {
    const { client, email, userId } = await registered('billing-flow');
    await sql(`UPDATE "User" SET "trialStatus" = 'ACTIVE', "trialStartedAt" = now() - interval '2 days', "trialEndsAt" = now() + interval '5 days' WHERE "id" = $1::uuid`, [userId]);
    expect(await account(client)).toMatchObject({ plan: 'PRO', source: 'trial', checkoutAvailable: true, portalAvailable: false });
    // 5 suivis actifs (Pro / essai : 50 ; Gratuit : 3).
    for (let i = 0; i < 5; i += 1) {
      await sql(`INSERT INTO "Watch" ("id", "userId", "mint", "createdAt") VALUES (gen_random_uuid(), $1::uuid, $2, now() + ($3 || ' seconds')::interval)`, [userId, `BillingE2eMint${i}${randomBytes(8).toString('hex')}`, String(i)]);
    }

    const session = await checkoutSession(client, 'month');
    // Le retour du Checkout n'accorde rien : seul le webhook passe le compte en Pro.
    expect((await account(client)).source).toBe('trial');
    const paid = await client.post<BillingAccount>('/billing/simulation/checkout', { sessionId: session, outcome: 'paid' });
    expect(paid.status).toBe(200);
    expect(paid.data).toMatchObject({ plan: 'PRO', source: 'subscription', subscription: { status: 'active', interval: 'month', cancelAtPeriodEnd: false }, trial: { status: 'ended' }, portalAvailable: true, checkoutAvailable: false });
    const [user] = await sql<{ plan: string; trialStatus: string }>(`SELECT "plan"::text, "trialStatus"::text FROM "User" WHERE "id" = $1::uuid`, [userId]);
    expect(user).toEqual({ plan: 'PRO', trialStatus: 'ENDED' });
    const converted = await sql<{ properties: unknown }>(`SELECT "properties" FROM "ProductEvent" WHERE "userId" = $1::uuid AND "type" = 'trial_converted'`, [userId]);
    expect(converted.map((row) => row.properties)).toEqual([{ phase: 'during', interval: 'month' }]);
    const receipt = await waitForMail(email, 'Ton reçu Raijin Pro');
    expect(receipt).toContain('9,90');
    expect(receipt).toContain('pas un conseil en investissement');
    // Session à usage unique ; deuxième abonnement refusé.
    expect((await client.post('/billing/simulation/checkout', { sessionId: session, outcome: 'paid' })).status).toBe(404);
    const again = await client.post('/billing/checkout-sessions', { interval: 'year' });
    expect(again.status).toBe(409);
    expect(again.data).toMatchObject({ code: 'ALREADY_SUBSCRIBED' });

    const portal = await client.post<BillingRedirect>('/billing/portal-sessions', {});
    expect(portal.status).toBe(200);
    expect(new URL(portal.data.url).pathname).toBe('/abonnement/simulation-portail');
    const canceled = await client.post<BillingAccount>('/billing/simulation/portal', { action: 'cancel_at_period_end' });
    expect(canceled.data).toMatchObject({ plan: 'PRO', subscription: { cancelAtPeriodEnd: true } });

    // Rejouer le même événement : aucun doublon.
    const sub = await subscriptionRow(userId);
    const ids = { userId, customerId: sub.customer, subscriptionId: sub.stripeSubscriptionId };
    const eventId = `evt_e2e_${randomBytes(8).toString('hex')}`;
    const now = new Date(Date.now() + 1_000).toISOString();
    expect(await replay(client, 'customer.subscription.updated', { ...ids, eventId, created: now, cancelAtPeriodEnd: true })).toEqual({ eventId, outcome: 'processed' });
    expect((await replay(client, 'customer.subscription.updated', { ...ids, eventId, created: now, cancelAtPeriodEnd: true })).outcome).toBe('duplicate');
    expect(await sql(`SELECT 1 FROM "StripeEvent" WHERE "id" = $1`, [eventId])).toHaveLength(1);
    // Événement plus ancien que le dernier appliqué : ignoré.
    const older = await replay(client, 'customer.subscription.updated', { ...ids, created: new Date(Date.now() - 3_600_000).toISOString(), cancelAtPeriodEnd: false });
    expect(older.outcome).toBe('stale');
    expect((await subscriptionRow(userId)).cancelAtPeriodEnd).toBe(true);

    // Fin de période : Stripe supprime l'abonnement → Gratuit, suivis au-delà de 3 mis en pause.
    const ended = await replay(client, 'customer.subscription.deleted', { ...ids, created: new Date(Date.now() + 2_000).toISOString() });
    expect(ended.outcome).toBe('processed');
    expect(await account(client)).toMatchObject({ plan: 'FREE', source: 'free', subscription: { status: 'canceled' }, checkoutAvailable: true });
    const watches = await sql<{ status: string; pausedReason: string | null }>(`SELECT "status"::text, "pausedReason"::text FROM "Watch" WHERE "userId" = $1::uuid ORDER BY "createdAt"`, [userId]);
    expect(watches.map((watch) => watch.status)).toEqual(['active', 'active', 'active', 'paused', 'paused']);
    expect(watches.filter((watch) => watch.pausedReason === 'plan_limit')).toHaveLength(2);
    const types = await sql<{ type: string }>(`SELECT "type" FROM "ProductEvent" WHERE "userId" = $1::uuid AND "type" IN ('checkout_started', 'subscription_activated', 'subscription_canceled') ORDER BY "createdAt"`, [userId]);
    expect(types.map((row) => row.type)).toEqual(['checkout_started', 'subscription_activated', 'subscription_canceled']);
  });

  it('paiement refusé : past_due garde Pro, bandeau de paiement, e-mail d’échec', async () => {
    const { client, email } = await registered('billing-failed');
    const session = await checkoutSession(client, 'year');
    const failed = await client.post<BillingAccount>('/billing/simulation/checkout', { sessionId: session, outcome: 'payment_failed' });
    expect(failed.data).toMatchObject({ plan: 'PRO', source: 'subscription', paymentIssue: true, subscription: { status: 'past_due', interval: 'year' } });
    const text = await waitForMail(email, 'Ton paiement Raijin Pro n’est pas passé');
    expect(text).toContain('/abonnement');
  });

  it('webhook : signature absente ou fausse → 400 BILLING_WEBHOOK_INVALID (corps brut, sans session ni CSRF)', async () => {
    const body = JSON.stringify({ id: 'evt_forge', object: 'event', type: 'customer.subscription.updated', created: 1, livemode: false, data: { object: {} } });
    const forged = `t=${Math.floor(Date.now() / 1000)},v1=${createHmac('sha256', 'whsec_devine').update(body).digest('hex')}`;
    for (const headers of [{}, { 'Stripe-Signature': forged }]) {
      const res = await axios.post('/api/v1/billing/webhook', body, { headers: { 'Content-Type': 'application/json', ...headers }, validateStatus: () => true });
      expect(res.status).toBe(400);
      expect(res.data).toMatchObject({ code: 'BILLING_WEBHOOK_INVALID' });
    }
    expect(await sql(`SELECT 1 FROM "StripeEvent" WHERE "id" = 'evt_forge'`)).toHaveLength(0);
  });
});

describe('Suppression du compte abonné (e2e, audit I1)', () => {
  async function proAccount(prefix: string) {
    const user = await registered(prefix);
    const session = await checkoutSession(user.client, 'month');
    expect((await user.client.post<BillingAccount>('/billing/simulation/checkout', { sessionId: session, outcome: 'paid' })).data.plan).toBe('PRO');
    const sub = await subscriptionRow(user.userId);
    return { ...user, customer: sub.customer, subscriptionId: sub.stripeSubscriptionId };
  }

  it('prestataire en échec : 503, compte et abonnement conservés ; puis suppression : abonnement résilié et client supprimé', async () => {
    const { client, userId, customer, subscriptionId } = await proAccount('billing-delete');
    expect((await client.post(`/internal/billing/fake-failures/cancel`, {})).status).toBe(204);
    const refused = await client.delete('/users/me', { password: PASSWORD });
    expect(refused.status).toBe(503);
    expect(await sql(`SELECT 1 FROM "User" WHERE "id" = $1::uuid`, [userId])).toHaveLength(1);
    const before = await client.get<{ deleted: boolean; subscriptions: { id: string; status: string }[] }>(`/internal/billing/fake-customers?id=${customer}`);
    expect(before.data).toEqual({ deleted: false, subscriptions: [{ id: subscriptionId, status: 'active' }] });
    expect((await account(client)).plan).toBe('PRO');

    const deleted = await client.delete('/users/me', { password: PASSWORD });
    expect(deleted.status).toBe(204);
    expect(await sql(`SELECT 1 FROM "User" WHERE "id" = $1::uuid`, [userId])).toHaveLength(0);
    const observer = await new ApiClient().init();
    const after = await observer.get<{ deleted: boolean; subscriptions: { id: string; status: string }[] }>(`/internal/billing/fake-customers?id=${customer}`);
    expect(after.data).toEqual({ deleted: true, subscriptions: [{ id: subscriptionId, status: 'canceled' }] });
  });
});

describe('Abonnement (e2e, Stripe non configuré)', () => {
  const PORT = 3201;
  const SECRET = `whsec_e2e${randomBytes(12).toString('hex')}`;
  let api: ChildProcess | undefined;
  const http = axios.create({ baseURL: `http://localhost:${PORT}/api/v1`, validateStatus: () => true });

  beforeAll(async () => {
    const saved = { ...process.env };
    Object.assign(process.env, { BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: SECRET, JOBS_ENABLED: 'false' });
    try {
      api = await startApi(join(__dirname, '..', '..', '..', '..'), PORT, 'localhost');
    } finally {
      for (const key of ['BILLING_PROVIDER', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'JOBS_ENABLED']) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  }, 90_000);

  afterAll(async () => {
    await stopApi(api);
  });

  it('mode unavailable, routes de simulation absentes, plus de santé publique de la configuration', async () => {
    expect((await http.get('/billing/plans')).data).toMatchObject({ mode: 'unavailable' });
    // GET health/config retiré (M3) : l'état « non configuré » de Stripe est lu dans GET admin/health (espace admin).
    expect((await http.get('/health/config')).status).toBe(404);
    const client = new ApiClient();
    const origin = axios.defaults.baseURL;
    axios.defaults.baseURL = `http://localhost:${PORT}`;
    try {
      client.headers['X-Forwarded-For'] = randomIp();
      await client.init();
      expect((await client.post('/billing/simulation/checkout', { sessionId: 'cs_fake_abcdefghijklmnop', outcome: 'paid' })).status).toBe(404);
      expect((await client.post('/billing/simulation/portal', { action: 'resume' })).status).toBe(404);
    } finally {
      axios.defaults.baseURL = origin;
    }
  });

  it('webhook signé (corps brut) accepté ; corps modifié refusé', async () => {
    const payload = JSON.stringify({ id: `evt_e2e_${randomBytes(6).toString('hex')}`, object: 'event', type: 'customer.created', created: Math.floor(Date.now() / 1000), livemode: false, data: { object: { id: 'cus_x', object: 'customer' } } });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = `t=${timestamp},v1=${createHmac('sha256', SECRET).update(`${timestamp}.${payload}`).digest('hex')}`;
    const ok = await http.post('/billing/webhook', payload, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Stripe-Signature': signature } });
    expect(ok.status).toBe(200);
    expect(ok.data).toEqual({ received: true });
    const tampered = await http.post('/billing/webhook', payload.replace('cus_x', 'cus_y'), { headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature } });
    expect(tampered.data).toMatchObject({ code: 'BILLING_WEBHOOK_INVALID' });
  });
});
