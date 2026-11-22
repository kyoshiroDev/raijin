import { loadBillingConfig } from '../config/billing-config';
import { addInterval, FakeBillingProvider, fakeId } from './fake-billing.provider';

const config = loadBillingConfig({}, { isProduction: false, appUrl: 'http://localhost:4200' });

describe('FakeBillingProvider', () => {
  it('identifiants, fin de période, mode', async () => {
    expect(fakeId('cs_fake_', 32)).toMatch(/^cs_fake_[A-Za-z0-9]{32}$/);
    expect(addInterval(new Date('2026-01-31T00:00:00.000Z'), 'year').toISOString()).toBe('2027-01-31T00:00:00.000Z');
    const fake = new FakeBillingProvider(config, 'http://localhost:4200');
    expect(fake.mode()).toBe('simulation');
    expect(fake.livemode).toBe(false);
    await expect(fake.verifyPrices()).resolves.toBe('ok');
    await expect(fake.retrieveSubscription('sub_x')).resolves.toBeNull();
    await expect(fake.retrieveInvoice('in_x')).resolves.toBeNull();
    expect(fake.updateSubscription('sub_x', { cancelAtPeriodEnd: true })).toBeUndefined();
  });

  it('sessions du faux Checkout : usage unique, propriétaire, expiration', async () => {
    let now = new Date('2026-11-22T12:00:00.000Z');
    const fake = new FakeBillingProvider(config, 'http://localhost:4200', () => now);
    const url = await fake.createCheckoutSession({ userId: 'u1', customerId: 'cus_1', interval: 'month', successUrl: '', cancelUrl: '', idempotencyKey: 'k' });
    const id = new URL(url).searchParams.get('session') ?? '';
    expect(fake.takeSession(id, 'u2')).toBeNull();
    expect(fake.takeSession(id, 'u1')).toMatchObject({ customerId: 'cus_1', interval: 'month' });
    expect(fake.takeSession(id, 'u1')).toBeNull();
    const late = new URL(await fake.createCheckoutSession({ userId: 'u1', customerId: 'cus_1', interval: 'year', successUrl: '', cancelUrl: '', idempotencyKey: 'k' })).searchParams.get('session') ?? '';
    now = new Date(now.getTime() + 2 * 3_600_000);
    expect(fake.takeSession(late, 'u1')).toBeNull();
  });

  it('abonnements et factures au format Stripe, événements vérifiables', async () => {
    const fake = new FakeBillingProvider(config, 'http://localhost:4200');
    const sub = fake.createSubscription({ customerId: 'cus_1', userId: '0195a0c4-0000-7000-8000-0000000000aa', interval: 'year', status: 'active' });
    const invoice = fake.createInvoice(sub, true);
    await expect(fake.retrieveSubscription(sub['id'] as string)).resolves.toMatchObject({ interval: 'year', priceId: 'price_fake_yearly', latestInvoiceId: invoice['id'] });
    await expect(fake.retrieveInvoice(invoice['id'] as string)).resolves.toMatchObject({ amountPaidCents: 9900, currency: 'EUR', subscriptionId: sub['id'] });
    const signed = fake.signEvent('invoice.paid', invoice, { id: 'evt_x' });
    expect(fake.constructWebhookEvent(signed.payload, signed.signature)).toMatchObject({ id: 'evt_x', type: 'invoice.paid' });
  });
});
