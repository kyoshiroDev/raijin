import Stripe from 'stripe';
import { loadBillingConfig } from '../config/billing-config';
import { BillingUnavailableError, WebhookSignatureError } from './billing-provider';
import { signFakeEvent } from './fake-billing.provider';
import { STRIPE_API_VERSION, StripeBillingProvider } from './stripe-billing.provider';

const ENV = {
  BILLING_PROVIDER: 'stripe',
  STRIPE_SECRET_KEY: 'sk_test_51abcdefghijklmnopqrstuvwxyz',
  STRIPE_WEBHOOK_SECRET: 'whsec_abcdefghijklmnopqrstuvwxyz',
  STRIPE_PRICE_PRO_MONTHLY: 'price_1Monthly0001',
  STRIPE_PRICE_PRO_YEARLY: 'price_1Yearly00001',
  STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_1portal01',
};
const config = loadBillingConfig(ENV, { isProduction: false });

function price(interval: 'month' | 'year', cents: number, extra: Record<string, unknown> = {}) {
  return { id: `price_${interval}`, active: true, type: 'recurring', currency: 'eur', unit_amount: cents, recurring: { interval, interval_count: 1 }, ...extra };
}

function notFound() {
  return new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', message: 'No such object', statusCode: 404 } as never);
}

/** Client Stripe simulé (aucun appel réseau). */
function client() {
  return {
    customers: { create: jest.fn(async () => ({ id: 'cus_1' })) },
    checkout: { sessions: { create: jest.fn(async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' })) } },
    billingPortal: { sessions: { create: jest.fn(async () => ({ url: 'https://billing.stripe.com/p/session/x' })) } },
    prices: { retrieve: jest.fn(async (id: string) => (id.includes('Monthly') ? price('month', 990) : price('year', 9900))) },
    subscriptions: { retrieve: jest.fn() },
    invoices: { retrieve: jest.fn() },
  };
}

function provider(mock = client()) {
  return { mock, stripe: new StripeBillingProvider(config, mock as unknown as Stripe) };
}

describe('StripeBillingProvider', () => {
  it('épingle la version d’API du SDK installé', () => {
    expect(STRIPE_API_VERSION).toBe(Stripe.API_VERSION);
  });

  it('Checkout : prix de la configuration, metadata userId, aucun essai Stripe, clé d’idempotence', async () => {
    const { mock, stripe } = provider();
    const url = await stripe.createCheckoutSession({ userId: 'u1', customerId: 'cus_1', interval: 'year', successUrl: 'https://app/s', cancelUrl: 'https://app/c', idempotencyKey: 'checkout:u1:year:1' });
    expect(url).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    const [params, options] = mock.checkout.sessions.create.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(params).toMatchObject({
      mode: 'subscription',
      customer: 'cus_1',
      client_reference_id: 'u1',
      line_items: [{ price: 'price_1Yearly00001', quantity: 1 }],
      metadata: { userId: 'u1' },
      subscription_data: { metadata: { userId: 'u1' } },
    });
    expect(JSON.stringify(params)).not.toContain('trial');
    expect(options).toEqual({ idempotencyKey: 'checkout:u1:year:1' });
    expect(stripe.mode()).toBe('stripe');
  });

  it('client, portail (configuration optionnelle)', async () => {
    const { mock, stripe } = provider();
    await expect(stripe.createCustomer({ userId: 'u1', email: 'a@b.fr', idempotencyKey: 'customer:u1' })).resolves.toBe('cus_1');
    expect(mock.customers.create).toHaveBeenCalledWith({ email: 'a@b.fr', metadata: { userId: 'u1' } }, { idempotencyKey: 'customer:u1' });
    await expect(stripe.createPortalSession('cus_1', 'https://app/abonnement')).resolves.toBe('https://billing.stripe.com/p/session/x');
    expect(mock.billingPortal.sessions.create).toHaveBeenCalledWith({ customer: 'cus_1', return_url: 'https://app/abonnement', locale: 'fr', configuration: 'bpc_1portal01' });
  });

  it('prix Stripe différents de la configuration : indisponible', async () => {
    const mock = client();
    mock.prices.retrieve.mockImplementation(async (id: string) => (id.includes('Monthly') ? price('month', 1090) : price('year', 9900)));
    const { stripe } = provider(mock);
    await expect(stripe.verifyPrices()).resolves.toBe('mismatch');
    expect(stripe.mode()).toBe('unavailable');
    await expect(stripe.createCheckoutSession({ userId: 'u', customerId: 'c', interval: 'month', successUrl: '', cancelUrl: '', idempotencyKey: 'k' })).rejects.toBeInstanceOf(BillingUnavailableError);
  });

  it('vérification impossible (réseau) : réessayée au Checkout suivant', async () => {
    const mock = client();
    mock.prices.retrieve.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    const { stripe } = provider(mock);
    await expect(stripe.verifyPrices()).resolves.toBe('error');
    expect(stripe.mode()).toBe('stripe');
    await expect(stripe.createCheckoutSession({ userId: 'u', customerId: 'c', interval: 'month', successUrl: '', cancelUrl: '', idempotencyKey: 'k' })).resolves.toContain('checkout.stripe.com');
  });

  it('relit abonnements et factures ; 404 → null ; autre erreur propagée', async () => {
    const { mock, stripe } = provider();
    mock.subscriptions.retrieve.mockResolvedValueOnce({
      id: 'sub_1',
      object: 'subscription',
      customer: { id: 'cus_1' },
      status: 'past_due',
      cancel_at_period_end: false,
      cancel_at: 1_800_000_000,
      metadata: { userId: '0195A0C4-0000-7000-8000-0000000000AA' },
      latest_invoice: { id: 'in_1' },
      items: { data: [{ current_period_end: 1_800_000_000, price: { id: 'price_1Monthly0001', recurring: { interval: 'month' } } }] },
    });
    await expect(stripe.retrieveSubscription('sub_1')).resolves.toEqual({
      id: 'sub_1',
      customerId: 'cus_1',
      status: 'past_due',
      priceId: 'price_1Monthly0001',
      interval: 'month',
      currentPeriodEnd: new Date(1_800_000_000_000),
      cancelAtPeriodEnd: true,
      userId: '0195a0c4-0000-7000-8000-0000000000aa',
      latestInvoiceId: 'in_1',
    });
    mock.subscriptions.retrieve.mockRejectedValueOnce(notFound());
    await expect(stripe.retrieveSubscription('sub_x')).resolves.toBeNull();
    mock.subscriptions.retrieve.mockRejectedValueOnce(new Error('panne'));
    await expect(stripe.retrieveSubscription('sub_x')).rejects.toThrow('panne');
    mock.invoices.retrieve.mockResolvedValueOnce({ id: 'in_1', object: 'invoice', currency: 'eur', amount_paid: 990, subscription: 'sub_1', hosted_invoice_url: 'https://evil.example/x' });
    await expect(stripe.retrieveInvoice('in_1')).resolves.toMatchObject({ amountPaidCents: 990, currency: 'EUR', subscriptionId: 'sub_1', hostedInvoiceUrl: null });
    mock.invoices.retrieve.mockRejectedValueOnce(notFound());
    await expect(stripe.retrieveInvoice('in_x')).resolves.toBeNull();
  });

  it('vérifie la signature avec le secret du webhook', () => {
    const { stripe } = provider();
    const good = signFakeEvent(ENV.STRIPE_WEBHOOK_SECRET, 'invoice.paid', { id: 'in_1', object: 'invoice' }, { created: new Date() });
    expect(stripe.constructWebhookEvent(good.payload, good.signature)).toMatchObject({ type: 'invoice.paid', livemode: false });
    expect(() => stripe.constructWebhookEvent(good.payload, 'x'.repeat(3000))).toThrow(WebhookSignatureError);
  });

  it('sans configuration : indisponible, aucun appel possible', async () => {
    const stripe = new StripeBillingProvider(loadBillingConfig({ BILLING_PROVIDER: 'stripe' }, { isProduction: false }));
    expect(stripe.mode()).toBe('unavailable');
    await expect(stripe.verifyPrices()).resolves.toBe('error');
    await expect(stripe.createPortalSession('cus_1', 'x')).rejects.toBeInstanceOf(BillingUnavailableError);
    const event = signFakeEvent('whsec_x', 'invoice.paid', { id: 'in_1', object: 'invoice' }, { created: new Date() });
    expect(() => stripe.constructWebhookEvent(event.payload, event.signature)).toThrow(WebhookSignatureError);
  });
});
