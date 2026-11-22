import { ApiException, testConfig } from '@raijin/api-core';
import express from 'express';
import { join } from 'node:path';
import request from 'supertest';
import { billingKit } from '../../testing/billing-test-kit';
import { FIXTURE_TOKENS } from '../../testing/webhook-fixtures';
import { BillingInternalController } from './billing-internal.controller';
import { BillingThrottleGuard } from './billing-throttle.guard';
import { BillingController } from './billing.controller';
import { billingWebhookRawBody } from './raw-body.middleware';
import { SimulationOnlyGuard } from './simulation.guard';

const USER = '0195a0c4-0000-7000-8000-0000000000aa';
const auth = { userId: USER, sessionId: 's', role: 'USER' as const, accessTokenExpiresAt: new Date() };

function controller() {
  const kit = billingKit();
  kit.prisma.addUser({ id: USER, email: 'kyo@exemple.fr' });
  return { kit, http: new BillingController(kit.billing, kit.webhook, kit.simulation) };
}

async function code(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiException) return `${error.getStatus()} ${error.code}`;
    throw error;
  }
  return 'ok';
}

describe('BillingController', () => {
  it('webhook : corps non brut ou signature invalide → 400 BILLING_WEBHOOK_INVALID ; valide → 200', async () => {
    const { kit, http } = controller();
    expect(await code(() => http.webhook({ body: { id: 'evt' } } as never, 'sig'))).toBe('400 BILLING_WEBHOOK_INVALID');
    const event = kit.fixture('customer.subscription.updated', { userId: USER });
    expect(await code(() => http.webhook({ body: event.payload } as never, 'v1=faux'))).toBe('400 BILLING_WEBHOOK_INVALID');
    await expect(http.webhook({ body: event.payload } as never, event.signature)).resolves.toEqual({ received: true });
    expect(kit.prisma.tables['user']?.[0]?.['plan']).toBe('PRO');
  });

  it('webhook : erreur de traitement propagée (500, Stripe réessaie)', async () => {
    const { kit, http } = controller();
    kit.prisma.failOnUpsert = 1;
    const event = kit.fixture('customer.subscription.updated', { userId: USER });
    await expect(http.webhook({ body: event.payload } as never, event.signature)).rejects.toThrow('panne simulée');
  });

  it('plans, Checkout, simulation et portail par le contrôleur', async () => {
    const { http } = controller();
    expect(http.plans().mode).toBe('simulation');
    const { url } = await http.checkout(auth, { interval: 'month' });
    const sessionId = new URL(url).searchParams.get('session');
    expect(await code(() => http.simulateCheckout(auth, { sessionId, outcome: 'paid', priceId: 'x' }))).toBe('400 VALIDATION_ERROR');
    await expect(http.simulateCheckout(auth, { sessionId, outcome: 'paid' })).resolves.toMatchObject({ plan: 'PRO' });
    await expect(http.portal(auth)).resolves.toEqual({ url: expect.stringContaining('/abonnement/simulation-portail') });
    await expect(http.simulatePortal(auth, { action: 'cancel_at_period_end' })).resolves.toMatchObject({ subscription: { cancelAtPeriodEnd: true } });
    await expect(http.subscription(auth)).resolves.toMatchObject({ plan: 'PRO' });
  });

  it('garde de simulation : 404 hors simulation', () => {
    const { kit } = controller();
    expect(new SimulationOnlyGuard(kit.simulation).canActivate()).toBe(true);
    const prod = { fake: () => { throw new Error('non'); } };
    expect(() => new SimulationOnlyGuard(prod as never).canActivate()).toThrow(ApiException);
  });

  it('limite par utilisateur et par minute', async () => {
    const { kit } = controller();
    const hits = new Map<string, number>();
    const storage = { increment: jest.fn(async (key: string) => ({ totalHits: (hits.set(key, (hits.get(key) ?? 0) + 1), hits.get(key) ?? 0) })) };
    const guard = new BillingThrottleGuard(storage as never, { ...kit.config, perMinute: 2 });
    const context = (withAuth: boolean) => ({ switchToHttp: () => ({ getRequest: () => (withAuth ? { auth } : {}) }) }) as never;
    await expect(guard.canActivate(context(true))).resolves.toBe(true);
    await expect(guard.canActivate(context(true))).resolves.toBe(true);
    expect(await code(() => guard.canActivate(context(true)))).toBe('429 RATE_LIMITED');
    expect(await code(() => guard.canActivate(context(false)))).toBe('401 AUTH_SESSION_EXPIRED');
  });
});

describe('BillingInternalController (fixtures signées)', () => {
  it('404 sans JOBS_TEST_TRIGGER ; rejoue une fixture personnalisée sinon', async () => {
    const { kit } = controller();
    const off = new BillingInternalController(kit.app, kit.config, kit.webhook, kit.fake);
    expect(await code(() => off.replay('invoice.paid', {}))).toBe('404 NOT_FOUND');
    const on = new BillingInternalController(testConfig({ JOBS_TEST_TRIGGER: '1' }), kit.config, kit.webhook, kit.fake);
    expect(await code(() => on.replay('inconnu', {}))).toBe('404 NOT_FOUND');
    expect(await code(() => on.replay('invoice.paid', { userId: 'pas-un-uuid' }))).toBe('400 VALIDATION_ERROR');
    const cwd = jest.spyOn(process, 'cwd').mockReturnValue(join(__dirname, '../../../../../..'));
    try {
      const replay = await on.replay('customer.subscription.updated', { userId: USER, eventId: 'evt_internal_1' });
      expect(replay).toEqual({ eventId: 'evt_internal_1', outcome: 'processed' });
      expect(kit.fake.subscription(FIXTURE_TOKENS.subscriptionId)).toBeDefined();
      await expect(on.replay('customer.subscription.updated', { userId: USER, eventId: 'evt_internal_1' })).resolves.toMatchObject({ outcome: 'duplicate' });
    } finally {
      cwd.mockRestore();
    }
  });
});

describe('billingWebhookRawBody', () => {
  const app = express();
  app.post('/hook', billingWebhookRawBody(), express.json(), (req, res) => {
    res.json({ buffer: Buffer.isBuffer(req.body), length: (req.body as Buffer).length });
  });

  it('garde le corps brut (même en application/json) et ignore le parseur JSON suivant', async () => {
    const res = await request(app).post('/hook').set('Content-Type', 'application/json; charset=utf-8').send('{"id":"evt_1"}');
    expect(res.body).toEqual({ buffer: true, length: 14 });
  });

  it('corps de plus de 1 Mo : 400 BILLING_WEBHOOK_INVALID', async () => {
    const res = await request(app).post('/hook').set('Content-Type', 'application/json').send('x'.repeat(1024 * 1024 + 10));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'BILLING_WEBHOOK_INVALID' });
  });
});
