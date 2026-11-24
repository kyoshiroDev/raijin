import { billingKit } from '../../testing/billing-test-kit';
import { loadBillingConfig } from '../config/billing-config';
import { StripeBillingProvider } from '../provider/stripe-billing.provider';
import { BillingAccountCloseError, BillingAccountCloser } from './billing-account-closer';

const USER = '0195a0c4-0000-7000-8000-0000000000aa';
const CUSTOMER = 'cus_fake_clos0001';

function setup() {
  const kit = billingKit();
  kit.prisma.addUser({ id: USER, plan: 'PRO', stripeCustomerId: CUSTOMER });
  const remote = kit.fake.createSubscription({ customerId: CUSTOMER, userId: USER, interval: 'month', status: 'active' });
  return { kit, remote: remote['id'] as string };
}

describe('BillingAccountCloser', () => {
  it('sans client Stripe : rien à faire', async () => {
    const kit = billingKit();
    kit.prisma.addUser({ id: USER });
    const cancel = jest.spyOn(kit.fake, 'cancelSubscriptionNow');
    await kit.closer.closeForUser(USER);
    await kit.closer.closeForUser('0195a0c4-0000-7000-8000-0000000000ff');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('résilie tout de suite les abonnements Pro (Stripe et base), supprime le client, idempotent', async () => {
    const { kit, remote } = setup();
    await kit.prisma.subscription.create({
      data: { userId: USER, stripeSubscriptionId: 'sub_base_only', stripePriceId: 'p', status: 'PAST_DUE', interval: 'MONTH', currentPeriodEnd: new Date(), cancelAtPeriodEnd: true },
    });
    const cancel = jest.spyOn(kit.fake, 'cancelSubscriptionNow');
    await kit.closer.closeForUser(USER);
    expect(cancel.mock.calls.map(([id]) => id).sort()).toEqual([remote, 'sub_base_only'].sort());
    expect(kit.fake.customerState(CUSTOMER)).toEqual({ deleted: true, subscriptions: [{ id: remote, status: 'canceled' }] });
    expect(kit.prisma.tables['user']?.[0]).toMatchObject({ stripeCustomerId: null, plan: 'FREE' });
    expect(kit.prisma.tables['subscription']?.[0]).toMatchObject({ status: 'CANCELED', cancelAtPeriodEnd: false });
    cancel.mockClear();
    await kit.closer.closeForUser(USER);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('expire les sessions Checkout ouvertes du client avant toute résiliation (celles des autres clients restent)', async () => {
    const { kit } = setup();
    const input = { userId: USER, interval: 'month' as const, successUrl: '', cancelUrl: '', idempotencyKey: 'k' };
    const mine = new URL(await kit.fake.createCheckoutSession({ ...input, customerId: CUSTOMER })).searchParams.get('session') ?? '';
    const other = new URL(await kit.fake.createCheckoutSession({ ...input, userId: 'u2', customerId: 'cus_fake_autre' })).searchParams.get('session') ?? '';
    const expire = jest.spyOn(kit.fake, 'expireOpenCheckoutSessions');
    const cancel = jest.spyOn(kit.fake, 'cancelSubscriptionNow');
    const remove = jest.spyOn(kit.fake, 'deleteCustomer');
    await kit.closer.closeForUser(USER);
    expect(expire).toHaveBeenCalledWith(CUSTOMER);
    await expect(expire.mock.results[0]?.value).resolves.toBe(1);
    expect(expire.mock.invocationCallOrder[0]).toBeLessThan(cancel.mock.invocationCallOrder[0] as number);
    expect(expire.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0] as number);
    expect(kit.fake.takeSession(mine, USER)).toBeNull();
    expect(kit.fake.takeSession(other, 'u2')).toMatchObject({ customerId: 'cus_fake_autre' });
  });

  it('échec de l’expiration des sessions : erreur 503, client conservé', async () => {
    const { kit } = setup();
    jest.spyOn(kit.fake, 'expireOpenCheckoutSessions').mockRejectedValueOnce(new Error('réseau'));
    const remove = jest.spyOn(kit.fake, 'deleteCustomer');
    await expect(kit.closer.closeForUser(USER)).rejects.toBeInstanceOf(BillingAccountCloseError);
    expect(remove).not.toHaveBeenCalled();
    expect(kit.prisma.tables['user']?.[0]).toMatchObject({ stripeCustomerId: CUSTOMER });
  });

  it.each(['cancel', 'deleteCustomer'] as const)('panne du prestataire (%s) : erreur 503 dédiée, base inchangée, réessai possible', async (operation) => {
    const { kit } = setup();
    kit.fake.failNext(operation);
    const error = await kit.closer.closeForUser(USER).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BillingAccountCloseError);
    expect((error as BillingAccountCloseError).getStatus()).toBe(503);
    expect(kit.prisma.tables['user']?.[0]).toMatchObject({ stripeCustomerId: CUSTOMER, plan: 'PRO' });
    await kit.closer.closeForUser(USER);
    expect(kit.fake.customerState(CUSTOMER).deleted).toBe(true);
  });

  it('Stripe non configuré alors qu’un client existe : erreur (compte conservé)', async () => {
    const { kit } = setup();
    const stripe = new StripeBillingProvider(loadBillingConfig({ BILLING_PROVIDER: 'stripe' }, { isProduction: false, appUrl: 'http://localhost:4200' }));
    const closer = new BillingAccountCloser(kit.prisma as never, stripe);
    await expect(closer.closeForUser(USER)).rejects.toBeInstanceOf(BillingAccountCloseError);
  });
});
