import { randomBytes } from 'node:crypto';
import { BILLING_RETURN_PATHS, isProSubscriptionStatus, type BillingInterval, type BillingMode, type SubscriptionStatus } from '@raijin/shared-contracts';
import Stripe from 'stripe';
import type { BillingConfig } from '../config/billing-config';
import {
  BillingProvider,
  WebhookSignatureError,
  type BillingWebhookEvent,
  type CheckoutInput,
  type CustomerInput,
  type PriceCheck,
  type ProviderInvoice,
  type ProviderSubscription,
} from './billing-provider';
import { verifyStripeSignature } from './stripe-billing.provider';
import { toProviderInvoice, toProviderSubscription } from './stripe-mapping';

type Json = Record<string, unknown>;

const ALPHANUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Identifiant aléatoire alphanumérique (`cs_fake_…`, `sub_fake_…`). */
export function fakeId(prefix: string, length = 24): string {
  const bytes = randomBytes(length);
  let id = '';
  for (const byte of bytes) id += ALPHANUM[byte % ALPHANUM.length];
  return `${prefix}${id}`;
}

/** Session du faux Checkout (en mémoire, usage unique). */
export interface FakeCheckoutSession {
  readonly id: string;
  readonly userId: string;
  readonly customerId: string;
  readonly interval: BillingInterval;
  readonly createdAt: number;
}

/** Événement signé localement, prêt à passer par le même chemin que le webhook. */
export interface SignedFakeEvent {
  readonly payload: Buffer;
  readonly signature: string;
}

const SESSION_TTL_MS = 3_600_000;
const MAX_SESSIONS = 10_000;

/** Fin de période : +1 mois ou +1 an (UTC). */
export function addInterval(from: Date, interval: BillingInterval): Date {
  const next = new Date(from.getTime());
  if (interval === 'month') next.setUTCMonth(next.getUTCMonth() + 1);
  else next.setUTCFullYear(next.getUTCFullYear() + 1);
  return next;
}

/**
 * Simulation locale de Stripe (`BILLING_PROVIDER=fake`, refusée en production) : faux Checkout et faux
 * portail servis par l'app (`/abonnement/simulation…`), abonnements et factures en mémoire au format de
 * l'API Stripe, événements signés localement avec `STRIPE_WEBHOOK_SECRET` (ou un secret éphémère) et
 * vérifiés exactement comme de vrais webhooks. Aucun appel réseau, aucune donnée de carte.
 */
export class FakeBillingProvider extends BillingProvider {
  readonly livemode = false;
  private readonly sessions = new Map<string, FakeCheckoutSession>();
  private readonly subscriptions = new Map<string, Json>();
  private readonly invoices = new Map<string, Json>();
  private readonly deletedCustomers = new Set<string>();
  /** Clés d'idempotence des clients (comme Stripe : même clé, même client). */
  private readonly customerKeys = new Map<string, string>();
  /** Pannes simulées (tests e2e) : la prochaine résiliation / suppression de client échoue. */
  private readonly failures = new Set<'cancel' | 'deleteCustomer'>();

  constructor(
    private readonly config: BillingConfig,
    private readonly appUrl: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    super();
  }

  mode(): BillingMode {
    return 'simulation';
  }

  /** Client simulé (aucune donnée envoyée nulle part) ; même clé d'idempotence : même client, comme Stripe. */
  async createCustomer(input: CustomerInput): Promise<string> {
    const known = this.customerKeys.get(input.idempotencyKey);
    if (known) return known;
    if (this.customerKeys.size >= MAX_SESSIONS) {
      const oldest = this.customerKeys.keys().next().value;
      if (oldest !== undefined) this.customerKeys.delete(oldest);
    }
    const id = fakeId('cus_fake_', 16);
    this.customerKeys.set(input.idempotencyKey, id);
    return id;
  }

  /** Client supprimé : refusé comme par Stripe (`resource_missing`). */
  async createCheckoutSession(input: CheckoutInput): Promise<string> {
    if (this.deletedCustomers.has(input.customerId)) throw Object.assign(new Error('No such customer'), { code: 'resource_missing' });
    this.pruneSessions();
    const id = fakeId('cs_fake_', 32);
    this.sessions.set(id, { id, userId: input.userId, customerId: input.customerId, interval: input.interval, createdAt: this.now().getTime() });
    return `${this.appUrl}${BILLING_RETURN_PATHS.simulatedCheckout}?session=${id}`;
  }

  /** Le faux portail ne dépend ni du client ni de l'URL de retour (page fixe de l'app). */
  async createPortalSession(): Promise<string> {
    return `${this.appUrl}${BILLING_RETURN_PATHS.simulatedPortal}`;
  }

  async listProSubscriptions(customerId: string): Promise<ProviderSubscription[]> {
    return [...this.subscriptions.values()]
      .map((raw) => toProviderSubscription(raw))
      .filter((sub): sub is ProviderSubscription => sub !== null && sub.customerId === customerId && isProSubscriptionStatus(sub.status));
  }

  async cancelSubscriptionNow(id: string): Promise<void> {
    if (this.failures.delete('cancel')) throw Object.assign(new Error('panne simulée'), { code: 'FAKE_PROVIDER_DOWN' });
    const current = this.subscriptions.get(id);
    if (current && current['status'] !== 'canceled') this.updateSubscription(id, { status: 'canceled', cancelAtPeriodEnd: false });
  }

  async expireOpenCheckoutSessions(customerId: string): Promise<number> {
    let expired = 0;
    for (const [id, session] of this.sessions) {
      if (session.customerId !== customerId) continue;
      this.sessions.delete(id);
      expired += 1;
    }
    return expired;
  }

  async deleteCustomer(customerId: string): Promise<void> {
    if (this.failures.delete('deleteCustomer')) throw Object.assign(new Error('panne simulée'), { code: 'FAKE_PROVIDER_DOWN' });
    this.deletedCustomers.add(customerId);
  }

  /** Programme une panne de la prochaine opération (route interne de test). */
  failNext(operation: 'cancel' | 'deleteCustomer'): void {
    this.failures.add(operation);
  }

  /** État simulé d'un client (route interne de test) : supprimé ou non, statuts de ses abonnements. */
  customerState(customerId: string): { deleted: boolean; subscriptions: { id: string; status: SubscriptionStatus }[] } {
    const subscriptions = [...this.subscriptions.values()]
      .map((raw) => toProviderSubscription(raw))
      .filter((sub): sub is ProviderSubscription => sub !== null && sub.customerId === customerId)
      .map((sub) => ({ id: sub.id, status: sub.status }));
    return { deleted: this.deletedCustomers.has(customerId), subscriptions };
  }

  async retrieveSubscription(id: string): Promise<ProviderSubscription | null> {
    const raw = this.subscriptions.get(id);
    return raw ? toProviderSubscription(raw) : null;
  }

  async retrieveInvoice(id: string): Promise<ProviderInvoice | null> {
    const raw = this.invoices.get(id);
    return raw ? toProviderInvoice(raw) : null;
  }

  constructWebhookEvent(rawBody: Buffer, signature: string | undefined): BillingWebhookEvent {
    if (!this.config.webhookSecret) throw new WebhookSignatureError();
    return verifyStripeSignature(rawBody, signature, this.config.webhookSecret, this.config.webhookToleranceS);
  }

  async verifyPrices(): Promise<PriceCheck> {
    return 'ok';
  }

  // --- Simulation (utilisé par `BillingSimulationService` et les tests) ---

  /** Prend une session du faux Checkout appartenant à `userId` (usage unique) ; `null` sinon. */
  takeSession(id: string, userId: string): FakeCheckoutSession | null {
    this.pruneSessions();
    const session = this.sessions.get(id);
    if (!session || session.userId !== userId) return null;
    this.sessions.delete(id);
    return session;
  }

  private pruneSessions(): void {
    const limit = this.now().getTime() - SESSION_TTL_MS;
    for (const [id, session] of this.sessions) if (session.createdAt < limit) this.sessions.delete(id);
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }

  private priceObject(interval: BillingInterval): Json {
    const id = interval === 'month' ? this.config.prices.monthlyId : this.config.prices.yearlyId;
    const cents = interval === 'month' ? this.config.prices.monthlyCents : this.config.prices.yearlyCents;
    return { id, object: 'price', currency: this.config.prices.currency.toLowerCase(), unit_amount: cents, type: 'recurring', recurring: { interval, interval_count: 1 } };
  }

  private cents(interval: BillingInterval): number {
    return interval === 'month' ? this.config.prices.monthlyCents : this.config.prices.yearlyCents;
  }

  /** Crée un abonnement simulé (format Stripe). */
  createSubscription(input: { customerId: string; userId: string; interval: BillingInterval; status: SubscriptionStatus }): Json {
    const now = this.now();
    const start = Math.floor(now.getTime() / 1000);
    const id = fakeId('sub_fake_');
    const sub: Json = {
      id,
      object: 'subscription',
      customer: input.customerId,
      status: input.status,
      cancel_at_period_end: false,
      cancel_at: null,
      canceled_at: null,
      created: start,
      livemode: false,
      metadata: { userId: input.userId },
      latest_invoice: null,
      items: {
        object: 'list',
        data: [
          {
            id: fakeId('si_fake_'),
            object: 'subscription_item',
            current_period_start: start,
            current_period_end: Math.floor(addInterval(now, input.interval).getTime() / 1000),
            price: this.priceObject(input.interval),
            quantity: 1,
          },
        ],
      },
    };
    this.subscriptions.set(id, sub);
    return sub;
  }

  /** Reconstruit un abonnement simulé depuis la base (API redémarrée : la mémoire du faux Stripe est vide). */
  restoreSubscription(input: {
    id: string;
    customerId: string;
    userId: string;
    status: SubscriptionStatus;
    interval: BillingInterval;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
  }): Json {
    const end = Math.floor(input.currentPeriodEnd.getTime() / 1000);
    const sub: Json = {
      id: input.id,
      object: 'subscription',
      customer: input.customerId,
      status: input.status,
      cancel_at_period_end: input.cancelAtPeriodEnd,
      cancel_at: null,
      canceled_at: null,
      livemode: false,
      metadata: { userId: input.userId },
      latest_invoice: null,
      items: { object: 'list', data: [{ id: fakeId('si_fake_'), object: 'subscription_item', current_period_end: end, price: this.priceObject(input.interval), quantity: 1 }] },
    };
    this.subscriptions.set(input.id, sub);
    return sub;
  }

  /** Abonnement simulé (format Stripe) ou `undefined`. */
  subscription(id: string): Json | undefined {
    return this.subscriptions.get(id);
  }

  /** Enregistre l'état d'un abonnement (événement rejoué, reprise après redémarrage de l'API). */
  putSubscription(sub: Json): void {
    if (typeof sub['id'] === 'string' && sub['object'] === 'subscription') this.subscriptions.set(sub['id'], sub);
  }

  /** Modifie un abonnement simulé (résiliation, reprise, changement de périodicité). */
  updateSubscription(id: string, change: { status?: SubscriptionStatus; cancelAtPeriodEnd?: boolean; interval?: BillingInterval; latestInvoiceId?: string }): Json | undefined {
    const current = this.subscriptions.get(id);
    if (!current) return undefined;
    const next: Json = { ...current };
    if (change.status) {
      next['status'] = change.status;
      if (change.status === 'canceled') {
        const now = Math.floor(this.now().getTime() / 1000);
        next['canceled_at'] = now;
        next['ended_at'] = now;
      }
    }
    if (change.cancelAtPeriodEnd !== undefined) next['cancel_at_period_end'] = change.cancelAtPeriodEnd;
    if (change.latestInvoiceId) next['latest_invoice'] = change.latestInvoiceId;
    if (change.interval) {
      const items = (current['items'] as { data: Json[] }).data;
      next['items'] = { object: 'list', data: items.map((item) => ({ ...item, price: this.priceObject(change.interval as BillingInterval) })) };
    }
    this.subscriptions.set(id, next);
    return next;
  }

  /** Facture simulée d'un abonnement : payée ou en échec. */
  createInvoice(sub: Json, paid: boolean): Json {
    const items = (sub['items'] as { data: Json[] }).data;
    const price = (items[0]?.['price'] ?? {}) as Json;
    const interval = ((price['recurring'] as Json | undefined)?.['interval'] as BillingInterval | undefined) ?? 'month';
    const amount = this.cents(interval);
    const id = fakeId('in_fake_');
    const invoice: Json = {
      id,
      object: 'invoice',
      customer: sub['customer'],
      currency: this.config.prices.currency.toLowerCase(),
      amount_due: amount,
      amount_paid: paid ? amount : 0,
      status: paid ? 'paid' : 'open',
      number: `SIMU-${id.slice(-8).toUpperCase()}`,
      hosted_invoice_url: null,
      period_end: items[0]?.['current_period_start'] ?? Math.floor(this.now().getTime() / 1000),
      livemode: false,
      parent: { type: 'subscription_details', subscription_details: { subscription: sub['id'], metadata: sub['metadata'] ?? null } },
    };
    this.invoices.set(id, invoice);
    if (typeof sub['id'] === 'string') this.updateSubscription(sub['id'], { latestInvoiceId: id });
    return invoice;
  }

  /** Session Checkout terminée (format Stripe). */
  checkoutSessionObject(session: FakeCheckoutSession, subscriptionId: string): Json {
    return {
      id: session.id,
      object: 'checkout.session',
      mode: 'subscription',
      status: 'complete',
      payment_status: 'paid',
      customer: session.customerId,
      subscription: subscriptionId,
      client_reference_id: session.userId,
      metadata: { userId: session.userId },
      livemode: false,
    };
  }

  /** Construit et signe un événement (même format et même vérification qu'un webhook Stripe). */
  signEvent(type: string, object: Json, options: { id?: string; created?: Date } = {}): SignedFakeEvent {
    return signFakeEvent(this.config.webhookSecret ?? '', type, object, { created: options.created ?? this.now(), ...(options.id ? { id: options.id } : {}) });
  }
}

/** Signe un événement au format Stripe avec `secret` (`generateTestHeaderString` du SDK officiel). */
export function signFakeEvent(secret: string, type: string, object: Json, options: { id?: string; created: Date; livemode?: boolean }): SignedFakeEvent {
  const event = {
    id: options.id ?? fakeId('evt_fake_'),
    object: 'event',
    api_version: null,
    created: Math.floor(options.created.getTime() / 1000),
    livemode: options.livemode ?? false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  };
  return signEventJson(secret, event);
}

/** Sérialise et signe un événement complet (fixtures). `timestamp` : horodatage de la signature (s). */
export function signEventJson(secret: string, event: unknown, timestamp?: number): SignedFakeEvent {
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret, ...(timestamp ? { timestamp } : {}) });
  return { payload: Buffer.from(payload, 'utf8'), signature };
}
