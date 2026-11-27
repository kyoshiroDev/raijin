import { billingKit, NOW, type BillingKit } from '../../testing/billing-test-kit';
import { FIXTURE_TOKENS } from '../../testing/webhook-fixtures';
import { WebhookSignatureError } from '../provider/billing-provider';
import { signEventJson, signFakeEvent } from '../provider/fake-billing.provider';

const USER = '0195a0c4-0000-7000-8000-0000000000aa';
const OTHER = '0195a0c4-0000-7000-8000-0000000000bb';
const T0 = '2026-11-22T11:00:00.000Z';
const T1 = '2026-11-22T11:30:00.000Z';

function setup(user: Record<string, unknown> = {}): BillingKit & { userId: string } {
  const kit = billingKit();
  kit.prisma.addUser({ id: USER, email: 'kyo@exemple.fr', ...user });
  return { ...kit, userId: USER };
}

/** Abonnement du fixture connu du faux Stripe (relu par le webhook). */
function knownSubscription(kit: BillingKit, overrides: Record<string, unknown> = {}) {
  const sub = kit.fake.restoreSubscription({
    id: FIXTURE_TOKENS.subscriptionId,
    customerId: FIXTURE_TOKENS.customerId,
    userId: USER,
    status: 'active',
    interval: 'month',
    currentPeriodEnd: new Date('2026-12-22T12:00:00.000Z'),
    cancelAtPeriodEnd: false,
  });
  kit.fake.putSubscription({ ...sub, ...overrides });
}

const overrides = { userId: USER };

function user(kit: BillingKit) {
  return kit.prisma.tables['user']?.find((row) => row['id'] === USER) as Record<string, unknown>;
}

function events(kit: BillingKit, type?: string) {
  return (kit.prisma.tables['productEvent'] ?? []).filter((row) => !type || row['type'] === type);
}

describe('BillingWebhookService : signature et mode', () => {
  it('refuse une signature absente, fausse, un corps modifié ou trop ancien', async () => {
    const kit = setup();
    const good = kit.fixture('checkout.session.completed', overrides);
    await expect(kit.webhook.handle(good.payload, undefined)).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(kit.webhook.handle(good.payload, 't=1,v1=deadbeef')).rejects.toBeInstanceOf(WebhookSignatureError);
    const tampered = Buffer.from(good.payload.toString('utf8').replace('"paid"', '"unpaid"'));
    await expect(kit.webhook.handle(tampered, good.signature)).rejects.toBeInstanceOf(WebhookSignatureError);
    const old = kit.fixture('checkout.session.completed', overrides, Math.floor(Date.now() / 1000) - 3_600);
    await expect(kit.webhook.handle(old.payload, old.signature)).rejects.toBeInstanceOf(WebhookSignatureError);
    const otherSecret = signEventJson('whsec_autresecretautresecret', JSON.parse(good.payload.toString('utf8')));
    await expect(kit.webhook.handle(otherSecret.payload, otherSecret.signature)).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(kit.webhook.handle(Buffer.alloc(0), good.signature)).rejects.toBeInstanceOf(WebhookSignatureError);
    expect(kit.prisma.tables['stripeEvent']).toHaveLength(0);
  });

  it('refuse un événement du mode réel reçu en mode test', async () => {
    const kit = setup();
    const live = signFakeEvent(kit.config.webhookSecret ?? '', 'invoice.paid', { id: 'in_x', object: 'invoice' }, { created: NOW, livemode: true });
    await expect(kit.webhook.handle(live.payload, live.signature)).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('acquitte sans rien écrire un type non traité', async () => {
    const kit = setup();
    const other = kit.fake.signEvent('customer.created', { id: 'cus_x', object: 'customer' });
    await expect(kit.webhook.handle(other.payload, other.signature)).resolves.toBe('ignored');
    expect(kit.prisma.tables['stripeEvent']).toHaveLength(0);
  });
});

describe('BillingWebhookService : passage Pro et idempotence', () => {
  it('checkout.session.completed : abonnement relu chez Stripe, Pro, client Stripe enregistré, suivis repris', async () => {
    const kit = setup();
    knownSubscription(kit);
    const event = kit.fixture('checkout.session.completed', { ...overrides, eventId: 'evt_checkout_1' });
    await expect(kit.webhook.handle(event.payload, event.signature)).resolves.toBe('processed');
    expect(user(kit)).toMatchObject({ plan: 'PRO', stripeCustomerId: FIXTURE_TOKENS.customerId });
    expect(kit.prisma.tables['subscription']?.[0]).toMatchObject({
      userId: USER,
      stripeSubscriptionId: FIXTURE_TOKENS.subscriptionId,
      status: 'ACTIVE',
      interval: 'MONTH',
      cancelAtPeriodEnd: false,
      lastEventAt: NOW,
    });
    expect(events(kit, 'subscription_activated')).toHaveLength(1);
    expect(kit.hooks.resumePlanLimited).toHaveBeenCalledWith(USER);
    expect(kit.hooks.enforcePlanLimit).not.toHaveBeenCalled();
  });

  it('rejouer le même événement ne produit aucun doublon', async () => {
    const kit = setup();
    knownSubscription(kit);
    const event = kit.fixture('checkout.session.completed', { ...overrides, eventId: 'evt_checkout_2' });
    await kit.webhook.handle(event.payload, event.signature);
    const again = kit.fixture('checkout.session.completed', { ...overrides, eventId: 'evt_checkout_2' });
    await expect(kit.webhook.handle(again.payload, again.signature)).resolves.toBe('duplicate');
    expect(kit.prisma.tables['stripeEvent']).toHaveLength(1);
    expect(kit.prisma.tables['subscription']).toHaveLength(1);
    expect(events(kit, 'subscription_activated')).toHaveLength(1);
    expect(kit.hooks.resumePlanLimited).toHaveBeenCalledTimes(1);
  });

  it('erreur pendant le traitement : rollback, événement non marqué, Stripe peut réessayer', async () => {
    const kit = setup();
    knownSubscription(kit);
    kit.prisma.failOnUpsert = 1;
    const event = kit.fixture('checkout.session.completed', { ...overrides, eventId: 'evt_retry' });
    await expect(kit.webhook.handle(event.payload, event.signature)).rejects.toThrow('panne simulée');
    expect(kit.prisma.tables['stripeEvent']).toHaveLength(0);
    expect(user(kit)['plan']).toBe('FREE');
    await expect(kit.webhook.handle(event.payload, event.signature)).resolves.toBe('processed');
    expect(user(kit)['plan']).toBe('PRO');
  });

  it('checkout terminé avant la création de l’abonnement chez Stripe : client rattaché, plan inchangé', async () => {
    const kit = setup();
    const event = kit.fixture('checkout.session.completed', overrides);
    await expect(kit.webhook.handle(event.payload, event.signature)).resolves.toBe('processed');
    expect(user(kit)).toMatchObject({ plan: 'FREE', stripeCustomerId: FIXTURE_TOKENS.customerId });
    expect(kit.prisma.tables['subscription']).toHaveLength(0);
  });

  it('événement plus ancien que le dernier appliqué : marqué traité, ignoré', async () => {
    const kit = setup();
    knownSubscription(kit, { cancel_at_period_end: true });
    const recent = kit.fixture('customer.subscription.updated', { ...overrides, created: T1, cancelAtPeriodEnd: true });
    await expect(kit.webhook.handle(recent.payload, recent.signature)).resolves.toBe('processed');
    knownSubscription(kit, { cancel_at_period_end: false });
    const older = kit.fixture('customer.subscription.updated', { ...overrides, created: T0, cancelAtPeriodEnd: false });
    await expect(kit.webhook.handle(older.payload, older.signature)).resolves.toBe('stale');
    expect(kit.prisma.tables['subscription']?.[0]).toMatchObject({ cancelAtPeriodEnd: true, lastEventAt: new Date(T1) });
    expect(kit.prisma.tables['stripeEvent']).toHaveLength(2);
  });

  it('ordre inverse (updated avant checkout) : état final identique, sans hypothèse d’ordre', async () => {
    const kit = setup();
    knownSubscription(kit);
    const updated = kit.fixture('customer.subscription.updated', { ...overrides, created: T1 });
    await kit.webhook.handle(updated.payload, updated.signature);
    const checkout = kit.fixture('checkout.session.completed', { ...overrides, created: T0 });
    await expect(kit.webhook.handle(checkout.payload, checkout.signature)).resolves.toBe('stale');
    expect(user(kit)).toMatchObject({ plan: 'PRO', stripeCustomerId: FIXTURE_TOKENS.customerId });
    expect(kit.prisma.tables['subscription']).toHaveLength(1);
  });

  it('abonnement inconnu de Stripe : instantané de l’événement (customer.subscription.*)', async () => {
    const kit = setup();
    const event = kit.fixture('customer.subscription.updated', { ...overrides, status: 'active' });
    await expect(kit.webhook.handle(event.payload, event.signature)).resolves.toBe('processed');
    expect(user(kit)['plan']).toBe('PRO');
  });

  it('statut trialing reçu de Stripe : traité comme Pro (garde-fou)', async () => {
    const kit = setup();
    const event = kit.fixture('customer.subscription.updated', { ...overrides, status: 'trialing' });
    await kit.webhook.handle(event.payload, event.signature);
    expect(user(kit)['plan']).toBe('PRO');
  });
});

describe('BillingWebhookService : rattachement', () => {
  it('sans metadata : rattaché par le client Stripe', async () => {
    const kit = setup({ stripeCustomerId: 'cus_connu00001' });
    const event = kit.fixture('customer.subscription.updated', { userId: OTHER, customerId: 'cus_connu00001' });
    await expect(kit.webhook.handle(event.payload, event.signature)).resolves.toBe('processed');
    expect(user(kit)['plan']).toBe('PRO');
  });

  it('metadata d’un compte dont le client Stripe diffère : rattaché au porteur du client', async () => {
    const kit = setup({ stripeCustomerId: 'cus_connu00001' });
    kit.prisma.addUser({ id: OTHER, email: 'autre@exemple.fr', stripeCustomerId: 'cus_autre00001' });
    const event = kit.fixture('customer.subscription.updated', { userId: OTHER, customerId: 'cus_connu00001' });
    await kit.webhook.handle(event.payload, event.signature);
    expect(user(kit)['plan']).toBe('PRO');
    expect(kit.prisma.tables['user']?.find((row) => row['id'] === OTHER)?.['plan']).toBe('FREE');
  });

  it('metadata d’un autre compte alors que le client appartient déjà à un compte : rattaché au porteur du client', async () => {
    const kit = setup({ stripeCustomerId: 'cus_porteur0001' });
    kit.prisma.addUser({ id: OTHER, email: 'autre@exemple.fr' });
    const event = kit.fixture('customer.subscription.updated', { userId: OTHER, customerId: 'cus_porteur0001' });
    await kit.webhook.handle(event.payload, event.signature);
    expect(user(kit)['plan']).toBe('PRO');
    const other = kit.prisma.tables['user']?.find((row) => row['id'] === OTHER);
    expect(other).toMatchObject({ plan: 'FREE', stripeCustomerId: null });
  });

  it('aucun compte : marqué traité (200), journalisé, rien d’autre', async () => {
    const kit = setup();
    const event = kit.fixture('customer.subscription.updated', { userId: OTHER, customerId: 'cus_inconnu0001', eventId: 'evt_unmatched' });
    await expect(kit.webhook.handle(event.payload, event.signature)).resolves.toBe('unmatched');
    await expect(kit.webhook.handle(event.payload, event.signature)).resolves.toBe('duplicate');
    expect(kit.prisma.tables['subscription']).toHaveLength(0);
  });

  it('abonnement déjà rattaché à un autre compte : ignoré', async () => {
    const kit = setup();
    kit.prisma.addUser({ id: OTHER, email: 'autre@exemple.fr' });
    const first = kit.fixture('customer.subscription.updated', { userId: OTHER, customerId: 'cus_autre00001' });
    await kit.webhook.handle(first.payload, first.signature);
    const hijack = kit.fixture('customer.subscription.updated', { userId: USER, customerId: 'cus_moi0000001' });
    await expect(kit.webhook.handle(hijack.payload, hijack.signature)).resolves.toBe('unmatched');
    expect(user(kit)['plan']).toBe('FREE');
  });

  it('prix non configuré : périodicité du prix Stripe', async () => {
    const kit = setup();
    const event = kit.fixture('customer.subscription.updated', { ...overrides, priceId: 'price_inconnu01' });
    await kit.webhook.handle(event.payload, event.signature);
    expect(kit.prisma.tables['subscription']?.[0]).toMatchObject({ interval: 'MONTH', stripePriceId: 'price_inconnu01' });
  });
});

describe('BillingWebhookService : essai Pro', () => {
  it('abonnement pendant l’essai : essai terminé tout de suite, trial_converted during', async () => {
    const kit = setup({ trialStatus: 'ACTIVE', trialStartedAt: new Date('2026-11-20T12:00:00.000Z'), trialEndsAt: new Date('2026-11-27T12:00:00.000Z') });
    const event = kit.fixture('customer.subscription.updated', overrides);
    await kit.webhook.handle(event.payload, event.signature);
    expect(user(kit)).toMatchObject({ plan: 'PRO', trialStatus: 'ENDED', trialEndsAt: NOW });
    expect(events(kit, 'trial_converted').map((row) => row['properties'])).toEqual([{ phase: 'during', interval: 'month' }]);
  });

  it('abonnement dans les 30 jours après l’essai : trial_converted after (une seule fois)', async () => {
    const kit = setup({ trialStatus: 'ACTIVE', trialEndsAt: new Date('2026-11-10T12:00:00.000Z') });
    const event = kit.fixture('customer.subscription.updated', overrides);
    await kit.webhook.handle(event.payload, event.signature);
    expect(user(kit)).toMatchObject({ trialStatus: 'ENDED' });
    expect(events(kit, 'trial_converted').map((row) => row['properties'])).toEqual([{ phase: 'after', interval: 'month' }]);
    const deleted = kit.fixture('customer.subscription.deleted', overrides);
    await kit.webhook.handle(deleted.payload, deleted.signature);
    const again = kit.fixture('customer.subscription.updated', { ...overrides, subscriptionId: 'sub_second00001' });
    await kit.webhook.handle(again.payload, again.signature);
    expect(events(kit, 'trial_converted')).toHaveLength(1);
  });

  it('abonnement longtemps après l’essai ou sans essai : aucune conversion', async () => {
    const late = setup({ trialStatus: 'ENDED', trialEndsAt: new Date('2026-09-01T12:00:00.000Z') });
    const event = late.fixture('customer.subscription.updated', overrides);
    await late.webhook.handle(event.payload, event.signature);
    expect(events(late, 'trial_converted')).toHaveLength(0);
    const never = setup({ trialStatus: 'INELIGIBLE' });
    const other = never.fixture('customer.subscription.updated', overrides);
    await never.webhook.handle(other.payload, other.signature);
    expect(events(never, 'trial_converted')).toHaveLength(0);
    expect(user(never)['trialStatus']).toBe('INELIGIBLE');
  });
});

describe('BillingWebhookService : factures, retard de paiement, résiliation', () => {
  it('invoice.paid : reçu avec le montant relu chez Stripe (pas celui du corps)', async () => {
    const kit = setup();
    knownSubscription(kit);
    const stored = kit.fake.createInvoice(kit.fake.subscription(FIXTURE_TOKENS.subscriptionId) ?? {}, true);
    const event = kit.fixture('invoice.paid', { ...overrides, invoiceId: stored['id'] as string, amountCents: 1 });
    await expect(kit.webhook.handle(event.payload, event.signature)).resolves.toBe('processed');
    expect(kit.mailer.sent).toHaveLength(1);
    expect(kit.mailer.sent[0]).toMatchObject({ to: 'kyo@exemple.fr', subject: 'Ton reçu Raijin Pro (14,90 €)' });
    expect(kit.mailer.sent[0]?.text).toContain('Prochain renouvellement : 22 décembre 2026');
    expect(kit.prisma.tables['subscription']?.[0]?.['latestInvoiceId']).toBe(stored['id']);
  });

  it('session traitée avant la facture (créée 1 s plus tôt) : facture « stale » mais un reçu', async () => {
    const kit = setup();
    knownSubscription(kit);
    const stored = kit.fake.createInvoice(kit.fake.subscription(FIXTURE_TOKENS.subscriptionId) ?? {}, true);
    const checkout = kit.fixture('checkout.session.completed', { ...overrides, created: T1 });
    await expect(kit.webhook.handle(checkout.payload, checkout.signature)).resolves.toBe('processed');
    const paid = kit.fixture('invoice.paid', { ...overrides, created: T0, invoiceId: stored['id'] as string });
    await expect(kit.webhook.handle(paid.payload, paid.signature)).resolves.toBe('stale');
    expect(kit.mailer.sent.map((mail) => mail.subject)).toEqual(['Ton reçu Raijin Pro (14,90 €)']);
    expect(user(kit)['plan']).toBe('PRO');
    expect(kit.prisma.tables['subscription']?.[0]?.['lastEventAt']).toEqual(new Date(T1));
  });

  it('facture traitée avant la session : un seul reçu', async () => {
    const kit = setup();
    knownSubscription(kit);
    const stored = kit.fake.createInvoice(kit.fake.subscription(FIXTURE_TOKENS.subscriptionId) ?? {}, true);
    const paid = kit.fixture('invoice.paid', { ...overrides, created: T0, invoiceId: stored['id'] as string });
    await expect(kit.webhook.handle(paid.payload, paid.signature)).resolves.toBe('processed');
    const checkout = kit.fixture('checkout.session.completed', { ...overrides, created: T1 });
    await expect(kit.webhook.handle(checkout.payload, checkout.signature)).resolves.toBe('processed');
    expect(kit.mailer.sent.map((mail) => mail.subject)).toEqual(['Ton reçu Raijin Pro (14,90 €)']);
    expect(user(kit)['plan']).toBe('PRO');
  });

  it('invoice.paid rejoué (même événement ou nouvel événement pour la même facture) : pas de second reçu', async () => {
    const kit = setup();
    knownSubscription(kit);
    const stored = kit.fake.createInvoice(kit.fake.subscription(FIXTURE_TOKENS.subscriptionId) ?? {}, true);
    const invoiceId = stored['id'] as string;
    const paid = kit.fixture('invoice.paid', { ...overrides, created: T0, invoiceId });
    await expect(kit.webhook.handle(paid.payload, paid.signature)).resolves.toBe('processed');
    await expect(kit.webhook.handle(paid.payload, paid.signature)).resolves.toBe('duplicate');
    const again = kit.fixture('invoice.paid', { ...overrides, created: T1, invoiceId });
    await expect(kit.webhook.handle(again.payload, again.signature)).resolves.toBe('processed');
    const older = kit.fixture('invoice.paid', { ...overrides, created: T0, invoiceId });
    await expect(kit.webhook.handle(older.payload, older.signature)).resolves.toBe('stale');
    expect(kit.mailer.sent).toHaveLength(1);
  });

  it('invoice.payment_failed ancien : e-mail d’échec envoyé une fois, état non réappliqué', async () => {
    const kit = setup();
    knownSubscription(kit);
    const checkout = kit.fixture('checkout.session.completed', { ...overrides, created: T1 });
    await kit.webhook.handle(checkout.payload, checkout.signature);
    knownSubscription(kit, { status: 'past_due' });
    const failed = kit.fixture('invoice.payment_failed', { ...overrides, created: T0 });
    await expect(kit.webhook.handle(failed.payload, failed.signature)).resolves.toBe('stale');
    await expect(kit.webhook.handle(failed.payload, failed.signature)).resolves.toBe('duplicate');
    const retry = kit.fixture('invoice.payment_failed', { ...overrides, created: T0 });
    await expect(kit.webhook.handle(retry.payload, retry.signature)).resolves.toBe('stale');
    expect(kit.mailer.sent.map((mail) => mail.subject)).toEqual(['Ton paiement Raijin Pro n’est pas passé']);
    expect(kit.prisma.tables['subscription']?.[0]?.['status']).toBe('ACTIVE');
  });

  it('invoice.paid à 0 € : aucun reçu', async () => {
    const kit = setup();
    const event = kit.fixture('invoice.paid', { ...overrides, amountCents: 0 });
    await kit.webhook.handle(event.payload, event.signature);
    expect(kit.mailer.sent).toHaveLength(0);
  });

  it('invoice.payment_failed : past_due garde Pro, e-mail d’échec, événement payment_failed', async () => {
    const kit = setup();
    knownSubscription(kit);
    const first = kit.fixture('checkout.session.completed', overrides);
    await kit.webhook.handle(first.payload, first.signature);
    knownSubscription(kit, { status: 'past_due' });
    const failed = kit.fixture('invoice.payment_failed', overrides);
    await expect(kit.webhook.handle(failed.payload, failed.signature)).resolves.toBe('processed');
    expect(user(kit)['plan']).toBe('PRO');
    expect(kit.prisma.tables['subscription']?.[0]?.['status']).toBe('PAST_DUE');
    expect(events(kit, 'payment_failed')).toHaveLength(1);
    expect(kit.mailer.sent.map((mail) => mail.subject)).toEqual(['Ton paiement Raijin Pro n’est pas passé']);
    expect(kit.mailer.sent[0]?.text).toContain(`${kit.app.appUrl}/abonnement`);
    expect(kit.hooks.enforcePlanLimit).not.toHaveBeenCalled();
    const account = await kit.billing.account(USER);
    expect(account).toMatchObject({ plan: 'PRO', source: 'subscription', paymentIssue: true, checkoutAvailable: false, portalAvailable: true });
  });

  it('customer.subscription.deleted : Gratuit, suivis en pause, subscription_canceled', async () => {
    const kit = setup();
    knownSubscription(kit);
    const first = kit.fixture('checkout.session.completed', { ...overrides, created: T0 });
    await kit.webhook.handle(first.payload, first.signature);
    knownSubscription(kit, { status: 'canceled' });
    const deleted = kit.fixture('customer.subscription.deleted', { ...overrides, created: T1 });
    await expect(kit.webhook.handle(deleted.payload, deleted.signature)).resolves.toBe('processed');
    expect(user(kit)['plan']).toBe('FREE');
    expect(kit.prisma.tables['subscription']?.[0]?.['status']).toBe('CANCELED');
    expect(events(kit, 'subscription_canceled')).toHaveLength(1);
    expect(kit.hooks.enforcePlanLimit).toHaveBeenCalledWith(USER);
  });

  it('unpaid après les relances : Gratuit', async () => {
    const kit = setup({ plan: 'PRO' });
    const event = kit.fixture('customer.subscription.updated', { ...overrides, status: 'unpaid' });
    await kit.webhook.handle(event.payload, event.signature);
    expect(user(kit)['plan']).toBe('FREE');
  });

  it('effets après commit en échec (e-mail, suivis) : journalisés, événement traité', async () => {
    const kit = setup();
    knownSubscription(kit);
    kit.mailer.fail = true;
    kit.hooks.resumePlanLimited.mockRejectedValueOnce(new Error('db'));
    const event = kit.fixture('invoice.paid', overrides);
    await expect(kit.webhook.handle(event.payload, event.signature)).resolves.toBe('processed');
    expect(user(kit)['plan']).toBe('PRO');
    const failed = kit.fixture('invoice.payment_failed', overrides);
    await expect(kit.webhook.handle(failed.payload, failed.signature)).resolves.toBe('processed');
  });
});
