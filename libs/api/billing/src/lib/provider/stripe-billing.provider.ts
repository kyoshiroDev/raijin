import { Logger } from '@nestjs/common';
import { errorCode } from '@raijin/api-core';
import { isProSubscriptionStatus, type BillingInterval, type BillingMode } from '@raijin/shared-contracts';
import Stripe from 'stripe';
import { stripeConfigured, type BillingConfig } from '../config/billing-config';
import {
  BillingProvider,
  BillingUnavailableError,
  WebhookSignatureError,
  type BillingWebhookEvent,
  type CheckoutInput,
  type CustomerInput,
  type PriceCheck,
  type ProviderInvoice,
  type ProviderSubscription,
} from './billing-provider';
import { toProviderInvoice, toProviderSubscription } from './stripe-mapping';

/**
 * Version de l'API Stripe épinglée (unique constante du dépôt). L'endpoint de webhook du dashboard doit
 * utiliser la même version (https://dashboard.stripe.com/test/webhooks).
 */
export const STRIPE_API_VERSION = '2026-11-18.endive' as const;

/** Vérifie la signature d'un corps brut avec le secret donné (SDK officiel, hors réseau). */
export function verifyStripeSignature(rawBody: Buffer, signature: string | undefined, secret: string, toleranceS: number): BillingWebhookEvent {
  if (!signature || signature.length > 2048 || !Buffer.isBuffer(rawBody) || rawBody.length === 0) throw new WebhookSignatureError();
  let event: Stripe.Event;
  try {
    event = Stripe.webhooks.constructEvent(rawBody, signature, secret, toleranceS);
  } catch {
    throw new WebhookSignatureError();
  }
  const object = (event.data as { object?: unknown } | undefined)?.object;
  if (typeof event.id !== 'string' || typeof event.type !== 'string' || typeof event.created !== 'number' || typeof object !== 'object' || object === null) {
    throw new WebhookSignatureError();
  }
  return { id: event.id, type: event.type, created: new Date(event.created * 1000), livemode: event.livemode === true, object: object as Record<string, unknown> };
}

/** Pages de 100 sessions ouvertes parcourues au plus par client (borne défensive). */
const MAX_SESSION_PAGES = 10;

/** Objet introuvable chez Stripe (404 / `resource_missing`). */
function isMissing(error: unknown): boolean {
  return error instanceof Stripe.errors.StripeInvalidRequestError && (error.statusCode === 404 || error.code === 'resource_missing');
}

/**
 * Stripe réel (Checkout hébergé, portail client). Sans configuration complète, ou si les prix Stripe
 * diffèrent de la configuration : mode `unavailable` (503 `BILLING_NOT_CONFIGURED`). Aucun secret journalisé.
 */
export class StripeBillingProvider extends BillingProvider {
  private readonly logger = new Logger('Stripe');
  private readonly client: Stripe | null;
  private priceState: PriceCheck | 'pending' = 'pending';

  constructor(private readonly config: BillingConfig, client?: Stripe) {
    super();
    this.client = stripeConfigured(config)
      ? (client ?? new Stripe(config.secretKey as string, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 2, timeout: 10_000, telemetry: false }))
      : null;
  }

  get livemode(): boolean {
    return this.config.livemode;
  }

  mode(): BillingMode {
    return this.client && this.priceState !== 'mismatch' ? 'stripe' : 'unavailable';
  }

  private stripe(): Stripe {
    if (!this.client) throw new BillingUnavailableError();
    return this.client;
  }

  private priceId(interval: BillingInterval): string {
    const id = interval === 'month' ? this.config.prices.monthlyId : this.config.prices.yearlyId;
    if (!id) throw new BillingUnavailableError();
    return id;
  }

  async createCustomer(input: CustomerInput): Promise<string> {
    const customer = await this.stripe().customers.create(
      { email: input.email, metadata: { userId: input.userId } },
      { idempotencyKey: input.idempotencyKey },
    );
    return customer.id;
  }

  async createCheckoutSession(input: CheckoutInput): Promise<string> {
    if (this.priceState !== 'ok' && (await this.verifyPrices()) !== 'ok') throw new BillingUnavailableError();
    const session = await this.stripe().checkout.sessions.create(
      {
        mode: 'subscription',
        customer: input.customerId,
        client_reference_id: input.userId,
        line_items: [{ price: this.priceId(input.interval), quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        locale: 'fr',
        metadata: { userId: input.userId },
        // L'essai est géré en base : jamais de `trial_period_days` côté Stripe.
        subscription_data: { metadata: { userId: input.userId } },
      },
      { idempotencyKey: input.idempotencyKey },
    );
    if (!session.url) throw new Error('CHECKOUT_URL_MISSING');
    return session.url;
  }

  async createPortalSession(customerId: string, returnUrl: string): Promise<string> {
    const session = await this.stripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
      locale: 'fr',
      ...(this.config.portalConfigurationId ? { configuration: this.config.portalConfigurationId } : {}),
    });
    return session.url;
  }

  async listProSubscriptions(customerId: string): Promise<ProviderSubscription[]> {
    const page = await this.stripe().subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    return page.data
      .map((sub) => toProviderSubscription(sub))
      .filter((sub): sub is ProviderSubscription => sub !== null && isProSubscriptionStatus(sub.status));
  }

  async cancelSubscriptionNow(id: string): Promise<void> {
    try {
      const current = await this.stripe().subscriptions.retrieve(id);
      if (current.status === 'canceled' || current.status === 'incomplete_expired') return;
      await this.stripe().subscriptions.cancel(id, { prorate: false, invoice_now: false }, { idempotencyKey: `cancel:${id}` });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }

  async expireOpenCheckoutSessions(customerId: string): Promise<number> {
    let expired = 0;
    let after: string | undefined;
    for (let page = 0; page < MAX_SESSION_PAGES; page += 1) {
      const list = await this.stripe().checkout.sessions.list({ customer: customerId, status: 'open', limit: 100, ...(after ? { starting_after: after } : {}) });
      for (const session of list.data) {
        try {
          await this.stripe().checkout.sessions.expire(session.id, {}, { idempotencyKey: `expire:${session.id}` });
          expired += 1;
        } catch (error) {
          // Session terminée ou expirée entre la liste et l'appel : plus rien à fermer.
          if (!(error instanceof Stripe.errors.StripeInvalidRequestError)) throw error;
        }
      }
      const last = list.data.at(-1);
      if (!list.has_more || !last) break;
      after = last.id;
    }
    return expired;
  }

  async deleteCustomer(customerId: string): Promise<void> {
    try {
      await this.stripe().customers.del(customerId);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }

  async retrieveSubscription(id: string): Promise<ProviderSubscription | null> {
    try {
      return toProviderSubscription(await this.stripe().subscriptions.retrieve(id));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async retrieveInvoice(id: string): Promise<ProviderInvoice | null> {
    try {
      return toProviderInvoice(await this.stripe().invoices.retrieve(id));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  constructWebhookEvent(rawBody: Buffer, signature: string | undefined): BillingWebhookEvent {
    if (!this.config.webhookSecret) throw new WebhookSignatureError();
    return verifyStripeSignature(rawBody, signature, this.config.webhookSecret, this.config.webhookToleranceS);
  }

  async verifyPrices(): Promise<PriceCheck> {
    if (!this.client) return 'error';
    try {
      const expected: [BillingInterval, number][] = [
        ['month', this.config.prices.monthlyCents],
        ['year', this.config.prices.yearlyCents],
      ];
      for (const [interval, cents] of expected) {
        const price = await this.client.prices.retrieve(this.priceId(interval));
        const matches =
          price.active &&
          price.type === 'recurring' &&
          price.recurring?.interval === interval &&
          price.recurring.interval_count === 1 &&
          price.unit_amount === cents &&
          price.currency.toUpperCase() === this.config.prices.currency;
        if (!matches) {
          this.priceState = 'mismatch';
          this.logger.error(`Prix Stripe ${interval === 'month' ? 'mensuel' : 'annuel'} différent de la configuration (PRO_PRICE_*_CENTS, BILLING_CURRENCY) : paiement indisponible.`);
          return 'mismatch';
        }
      }
      this.priceState = 'ok';
      return 'ok';
    } catch (error) {
      // Erreur réseau ou clé refusée : nouvelle tentative au prochain Checkout.
      this.priceState = 'error';
      this.logger.warn(`Vérification des prix Stripe impossible (${errorCode(error)}).`);
      return 'error';
    }
  }
}
