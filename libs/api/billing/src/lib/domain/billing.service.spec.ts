import { ApiException } from '@raijin/api-core';
import { billingAccountSchema, billingPlansResponseSchema, isAllowedBillingRedirect, TRIAL_INELIGIBLE_NOTICE } from '@raijin/shared-contracts';
import { billingKit, NOW } from '../../testing/billing-test-kit';
import { loadBillingConfig } from '../config/billing-config';
import { StripeBillingProvider } from '../provider/stripe-billing.provider';

const USER = '0195a0c4-0000-7000-8000-0000000000aa';

async function rejection(promise: Promise<unknown>): Promise<{ code: string; status: number }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiException) return { code: error.code, status: error.getStatus() };
    throw error;
  }
  throw new Error('aucune erreur');
}

describe('BillingService : plans', () => {
  it('prix et droits viennent de la configuration (centimes entiers), mode simulation', () => {
    const kit = billingKit({ env: { PRO_PRICE_MONTHLY_CENTS: '1290', PRO_PRICE_YEARLY_CENTS: '12900', BILLING_CURRENCY: 'usd' }, appEnv: { TRIAL_DAYS: '5' } });
    const plans = kit.billing.plans();
    expect(billingPlansResponseSchema.safeParse(plans).success).toBe(true);
    expect(plans.pro.monthly).toEqual({ interval: 'month', amountCents: 1290, currency: 'USD' });
    expect(plans.pro.yearly).toEqual({ interval: 'year', amountCents: 12900, currency: 'USD' });
    expect(plans.trial.days).toBe(5);
    expect(plans.free.entitlements.maxActiveWatches).toBe(kit.app.watch.freeLimit);
    expect(plans.pro.entitlements.analysesPerDay).toBeNull();
    expect(plans.trial.entitlements.analysesPerDay).toBe(kit.app.analysis.trialDailyLimit);
    expect(plans.mode).toBe('simulation');
    expect(JSON.stringify(plans)).not.toContain('price_');
  });
});

describe('BillingService : compte', () => {
  it('Gratuit sans abonnement : Checkout ouvrable, portail fermé', async () => {
    const kit = billingKit();
    kit.prisma.addUser({ id: USER });
    const account = await kit.billing.account(USER);
    expect(billingAccountSchema.safeParse(account).success).toBe(true);
    expect(account).toMatchObject({ plan: 'FREE', source: 'free', subscription: null, paymentIssue: false, portalAvailable: false, checkoutAvailable: true, mode: 'simulation' });
  });

  it('essai actif : plan Pro (source trial), jours restants ; inéligible : message neutre', async () => {
    const kit = billingKit();
    kit.prisma.addUser({ id: USER, trialStatus: 'ACTIVE', trialStartedAt: new Date('2026-11-20T12:00:00.000Z'), trialEndsAt: new Date('2026-11-27T12:00:00.000Z') });
    const account = await kit.billing.account(USER);
    expect(account).toMatchObject({ plan: 'PRO', source: 'trial', trial: { status: 'active', daysRemaining: 5 }, checkoutAvailable: true });
    const other = '0195a0c4-0000-7000-8000-0000000000cc';
    kit.prisma.addUser({ id: other, email: 'x@exemple.fr', trialStatus: 'INELIGIBLE' });
    expect((await kit.billing.account(other)).trial.notice).toBe(TRIAL_INELIGIBLE_NOTICE);
  });

  it('e-mail non vérifié : Checkout indisponible', async () => {
    const kit = billingKit();
    kit.prisma.addUser({ id: USER, emailVerifiedAt: null });
    expect((await kit.billing.account(USER)).checkoutAvailable).toBe(false);
  });

  it('abonnement résilié en fin de période : Pro jusqu’à la fin, puis dernier abonnement affiché', async () => {
    const kit = billingKit();
    kit.prisma.addUser({ id: USER, plan: 'PRO', stripeCustomerId: 'cus_fake_x' });
    await kit.prisma.subscription.create({
      data: { userId: USER, stripeSubscriptionId: 'sub_1', stripePriceId: 'price_fake_yearly', status: 'ACTIVE', interval: 'YEAR', currentPeriodEnd: new Date('2027-11-22T12:00:00.000Z'), cancelAtPeriodEnd: true },
    });
    expect(await kit.billing.account(USER)).toMatchObject({
      plan: 'PRO',
      source: 'subscription',
      subscription: { status: 'active', interval: 'year', cancelAtPeriodEnd: true, currentPeriodEnd: '2027-11-22T12:00:00.000Z' },
      checkoutAvailable: false,
      portalAvailable: true,
    });
  });

  it('compte supprimé : 401', async () => {
    const kit = billingKit();
    expect(await rejection(kit.billing.account(USER))).toEqual({ code: 'AUTH_SESSION_EXPIRED', status: 401 });
  });
});

describe('BillingService : Checkout et portail', () => {
  it('e-mail non vérifié : 403 AUTH_EMAIL_NOT_VERIFIED', async () => {
    const kit = billingKit();
    kit.prisma.addUser({ id: USER, emailVerifiedAt: null });
    expect(await rejection(kit.billing.createCheckout(USER, 'month'))).toEqual({ code: 'AUTH_EMAIL_NOT_VERIFIED', status: 403 });
  });

  it('crée le client une seule fois (verrou), URL de simulation de la même origine, checkout_started', async () => {
    const kit = billingKit();
    kit.prisma.addUser({ id: USER });
    const first = await kit.billing.createCheckout(USER, 'year');
    const customer = kit.prisma.tables['user']?.[0]?.['stripeCustomerId'];
    expect(customer).toMatch(/^cus_fake_/);
    await kit.billing.createCheckout(USER, 'month');
    expect(kit.prisma.tables['user']?.[0]?.['stripeCustomerId']).toBe(customer);
    expect(first.url).toMatch(new RegExp(`^${kit.app.appUrl}/abonnement/simulation\\?session=cs_fake_[A-Za-z0-9]{32}$`));
    expect(isAllowedBillingRedirect(first.url, kit.app.appUrl)).toBe(true);
    expect(kit.prisma.tables['productEvent']?.map((row) => row['properties'])).toEqual([{ interval: 'year' }, { interval: 'month' }]);
    expect(kit.prisma.rawQueries.some((query) => query.includes('FOR UPDATE'))).toBe(true);
  });

  it('abonnement Pro en cours (actif ou en retard) : 409 ALREADY_SUBSCRIBED', async () => {
    const kit = billingKit();
    kit.prisma.addUser({ id: USER, plan: 'PRO' });
    await kit.prisma.subscription.create({
      data: { userId: USER, stripeSubscriptionId: 'sub_1', stripePriceId: 'p', status: 'PAST_DUE', interval: 'MONTH', currentPeriodEnd: NOW, cancelAtPeriodEnd: false },
    });
    expect(await rejection(kit.billing.createCheckout(USER, 'month'))).toEqual({ code: 'ALREADY_SUBSCRIBED', status: 409 });
  });

  it('portail sans compte de facturation : 409 NO_BILLING_ACCOUNT ; sinon URL fixe', async () => {
    const kit = billingKit();
    kit.prisma.addUser({ id: USER });
    expect(await rejection(kit.billing.createPortal(USER))).toEqual({ code: 'NO_BILLING_ACCOUNT', status: 409 });
    await kit.prisma.user.update({ where: { id: USER }, data: { stripeCustomerId: 'cus_fake_x' } });
    expect((await kit.billing.createPortal(USER)).url).toBe(`${kit.app.appUrl}/abonnement/simulation-portail`);
  });

  it('Stripe non configuré : mode unavailable, 503 BILLING_NOT_CONFIGURED', async () => {
    const config = loadBillingConfig({ BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_factice' }, { isProduction: false });
    const kit = billingKit({ provider: new StripeBillingProvider(config) });
    kit.prisma.addUser({ id: USER, stripeCustomerId: 'cus_x' });
    expect(kit.billing.plans().mode).toBe('unavailable');
    expect(await rejection(kit.billing.createCheckout(USER, 'month'))).toEqual({ code: 'BILLING_NOT_CONFIGURED', status: 503 });
    expect(await rejection(kit.billing.createPortal(USER))).toEqual({ code: 'BILLING_NOT_CONFIGURED', status: 503 });
    expect(await kit.billing.account(USER)).toMatchObject({ mode: 'unavailable', checkoutAvailable: false, portalAvailable: false });
  });

  it('panne du prestataire : 503 UPSTREAM_UNAVAILABLE, sans détail', async () => {
    const kit = billingKit();
    kit.prisma.addUser({ id: USER, stripeCustomerId: 'cus_x' });
    jest.spyOn(kit.fake, 'createCheckoutSession').mockRejectedValueOnce(new Error('réseau'));
    expect(await rejection(kit.billing.createCheckout(USER, 'month'))).toEqual({ code: 'UPSTREAM_UNAVAILABLE', status: 503 });
  });
});
