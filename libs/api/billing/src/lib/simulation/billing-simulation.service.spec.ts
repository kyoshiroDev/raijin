import { ApiException } from '@raijin/api-core';
import { billingKit } from '../../testing/billing-test-kit';
import { loadBillingConfig } from '../config/billing-config';
import { FakeBillingProvider } from '../provider/fake-billing.provider';
import { StripeBillingProvider } from '../provider/stripe-billing.provider';
import { BillingSimulationService } from './billing-simulation.service';

const USER = '0195a0c4-0000-7000-8000-0000000000aa';
const OTHER = '0195a0c4-0000-7000-8000-0000000000bb';

function sessionOf(url: string): string {
  return new URL(url).searchParams.get('session') ?? '';
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiException) return error.code;
    throw error;
  }
  return 'aucune erreur';
}

describe('BillingSimulationService', () => {
  it('faux Checkout payé → webhooks signés → Pro, reçu ; faux portail → résiliation en fin de période → Gratuit à la suppression', async () => {
    const kit = billingKit();
    kit.prisma.addUser({ id: USER, email: 'kyo@exemple.fr', trialStatus: 'ACTIVE', trialStartedAt: new Date('2026-11-20T12:00:00.000Z'), trialEndsAt: new Date('2026-11-27T12:00:00.000Z') });
    const { url } = await kit.billing.createCheckout(USER, 'month');
    await expect(kit.simulation.completeCheckout(USER, { sessionId: sessionOf(url), outcome: 'paid' })).resolves.toEqual(['processed', 'processed']);
    let account = await kit.billing.account(USER);
    expect(account).toMatchObject({ plan: 'PRO', source: 'subscription', subscription: { status: 'active', interval: 'month', cancelAtPeriodEnd: false }, trial: { status: 'ended' } });
    expect(kit.mailer.sent.map((mail) => mail.subject)).toEqual(['Ton reçu Raijin Pro (9,90 €)']);
    // Session à usage unique.
    expect(await code(kit.simulation.completeCheckout(USER, { sessionId: sessionOf(url), outcome: 'paid' }))).toBe('NOT_FOUND');

    await kit.simulation.portalAction(USER, { action: 'switch_interval' });
    expect((await kit.billing.account(USER)).subscription).toMatchObject({ interval: 'year' });
    await kit.simulation.portalAction(USER, { action: 'cancel_at_period_end' });
    account = await kit.billing.account(USER);
    expect(account).toMatchObject({ plan: 'PRO', subscription: { cancelAtPeriodEnd: true } });
    await kit.simulation.portalAction(USER, { action: 'resume' });
    expect((await kit.billing.account(USER)).subscription?.cancelAtPeriodEnd).toBe(false);
    await kit.simulation.portalAction(USER, { action: 'cancel_now' });
    account = await kit.billing.account(USER);
    expect(account).toMatchObject({ plan: 'FREE', source: 'free', subscription: { status: 'canceled' }, checkoutAvailable: true });
    expect(kit.hooks.enforcePlanLimit).toHaveBeenCalledWith(USER);
    expect(await code(kit.simulation.portalAction(USER, { action: 'cancel_now' }))).toBe('NO_BILLING_ACCOUNT');
  });

  it('faux Checkout refusé : past_due, Pro gardé, e-mail d’échec', async () => {
    const kit = billingKit();
    kit.prisma.addUser({ id: USER, email: 'kyo@exemple.fr' });
    const { url } = await kit.billing.createCheckout(USER, 'year');
    await kit.simulation.completeCheckout(USER, { sessionId: sessionOf(url), outcome: 'payment_failed' });
    expect(await kit.billing.account(USER)).toMatchObject({ plan: 'PRO', paymentIssue: true, subscription: { status: 'past_due', interval: 'year' } });
    expect(kit.mailer.sent.map((mail) => mail.subject)).toEqual(['Ton paiement Raijin Pro n’est pas passé']);
  });

  it('session d’un autre compte : 404', async () => {
    const kit = billingKit();
    kit.prisma.addUser({ id: USER });
    kit.prisma.addUser({ id: OTHER, email: 'autre@exemple.fr' });
    const { url } = await kit.billing.createCheckout(USER, 'month');
    expect(await code(kit.simulation.completeCheckout(OTHER, { sessionId: sessionOf(url), outcome: 'paid' }))).toBe('NOT_FOUND');
  });

  it('API redémarrée (faux Stripe vide) : le portail reconstruit l’abonnement depuis la base', async () => {
    const kit = billingKit();
    kit.prisma.addUser({ id: USER });
    const { url } = await kit.billing.createCheckout(USER, 'month');
    await kit.simulation.completeCheckout(USER, { sessionId: sessionOf(url), outcome: 'paid' });
    const restarted = new FakeBillingProvider(kit.config, kit.app.appUrl, () => kit.clock.current);
    const webhook = Object.assign(Object.create(Object.getPrototypeOf(kit.webhook)), kit.webhook, { provider: restarted });
    const simulation = new BillingSimulationService(restarted, webhook, kit.prisma as never, kit.app);
    kit.clock.current = new Date(kit.clock.current.getTime() + 60_000);
    await simulation.portalAction(USER, { action: 'cancel_at_period_end' });
    expect((await kit.billing.account(USER)).subscription?.cancelAtPeriodEnd).toBe(true);
  });

  it('hors simulation (Stripe) ou en production : 404', async () => {
    const stripe = new StripeBillingProvider(loadBillingConfig({ BILLING_PROVIDER: 'stripe' }, { isProduction: false }));
    const kit = billingKit({ provider: stripe });
    expect(await code(kit.simulation.completeCheckout(USER, { sessionId: 'cs_fake_abcdefghijklmnop', outcome: 'paid' }))).toBe('NOT_FOUND');
    expect(await code(kit.simulation.portalAction(USER, { action: 'resume' }))).toBe('NOT_FOUND');
    const prod = billingKit();
    const simulation = new BillingSimulationService(prod.fake, prod.webhook, prod.prisma as never, { ...prod.app, isProduction: true });
    expect(() => simulation.fake()).toThrow(ApiException);
  });
});
