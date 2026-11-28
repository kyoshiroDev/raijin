import { join } from 'node:path';
import { buildFixtureEvent, FIXTURE_TOKENS, isFixtureName } from '../../testing/webhook-fixtures';
import { checkoutSessionRefs, metadataUserId, subscriptionStatusOf, toProviderInvoice, toProviderSubscription } from './stripe-mapping';

const DIR = join(__dirname, '../../testing/fixtures');
const NOW = new Date('2026-11-22T12:00:00.000Z');

describe('lecture des objets Stripe', () => {
  it('abonnement : ancien emplacement de current_period_end, statut inconnu → incomplete', () => {
    const sub = toProviderSubscription({
      id: 'sub_1',
      object: 'subscription',
      customer: 'cus_1',
      status: 'nouveau_statut',
      current_period_end: 1_800_000_000,
      items: { data: [{ price: { id: 'price_1', recurring: { interval: 'week' } } }] },
    });
    expect(sub).toMatchObject({ status: 'incomplete', interval: null, currentPeriodEnd: new Date(1_800_000_000_000), cancelAtPeriodEnd: false, userId: null });
    expect(toProviderSubscription({ object: 'subscription', id: 'sub_1' })).toBeNull();
    expect(toProviderSubscription({ object: 'invoice' })).toBeNull();
    expect(toProviderSubscription('x')).toBeNull();
    expect(subscriptionStatusOf('past_due')).toBe('past_due');
  });

  it('metadata.userId : UUID uniquement', () => {
    expect(metadataUserId({ userId: "1' OR 1=1" })).toBeNull();
    expect(metadataUserId(null)).toBeNull();
  });

  it('facture : devise invalide refusée, lien hébergé limité à invoice.stripe.com', () => {
    expect(toProviderInvoice({ id: 'in_1', object: 'invoice', currency: 'euro' })).toBeNull();
    expect(toProviderInvoice({ id: 'in_1', object: 'invoice', currency: 'eur', hosted_invoice_url: 'https://invoice.stripe.com/i/x' })).toMatchObject({ hostedInvoiceUrl: 'https://invoice.stripe.com/i/x', amountPaidCents: 0, subscriptionId: null });
  });

  it('session Checkout : abonnement seulement en mode subscription, client_reference_id en repli', () => {
    expect(checkoutSessionRefs({ object: 'checkout.session', mode: 'payment', subscription: 'sub_1', client_reference_id: FIXTURE_TOKENS.userId })).toEqual({ subscriptionId: null, customerId: null, userId: FIXTURE_TOKENS.userId });
    expect(checkoutSessionRefs({ object: 'other' })).toBeNull();
  });
});

describe('fixtures des webhooks', () => {
  it.each(['checkout.session.completed', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.payment_failed', 'invoice.paid'] as const)(
    '%s : lisible et personnalisable',
    (name) => {
      expect(isFixtureName(name)).toBe(true);
      const event = buildFixtureEvent(name, { eventId: 'evt_custom_1', created: '2026-11-22T10:00:00.000Z', userId: '0195a0c4-0000-7000-8000-0000000000aa', customerId: 'cus_custom01' }, { dir: DIR, now: NOW });
      expect(event).toMatchObject({ id: 'evt_custom_1', type: name, created: Date.parse('2026-11-22T10:00:00.000Z') / 1000, livemode: false });
      const text = JSON.stringify(event);
      expect(text).not.toContain(FIXTURE_TOKENS.userId);
      expect(text).not.toContain(FIXTURE_TOKENS.customerId);
    },
  );

  it('abonnement : statut, résiliation, fin de période ; facture : montant', () => {
    const sub = buildFixtureEvent('customer.subscription.updated', { status: 'past_due', cancelAtPeriodEnd: true, currentPeriodEnd: '2027-01-01T00:00:00.000Z', priceId: 'price_custom01' }, { dir: DIR, now: NOW });
    expect(toProviderSubscription((sub['data'] as { object: unknown }).object)).toMatchObject({ status: 'past_due', cancelAtPeriodEnd: true, currentPeriodEnd: new Date('2027-01-01T00:00:00.000Z'), priceId: 'price_custom01' });
    const invoice = buildFixtureEvent('invoice.paid', { amountCents: 14900 }, { dir: DIR, now: NOW });
    expect(toProviderInvoice((invoice['data'] as { object: unknown }).object)).toMatchObject({ amountPaidCents: 14900, amountDueCents: 14900 });
    expect(isFixtureName('../etc/passwd')).toBe(false);
  });
});
