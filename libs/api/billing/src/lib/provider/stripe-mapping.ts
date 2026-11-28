import { SUBSCRIPTION_STATUSES, type BillingInterval, type SubscriptionStatus } from '@raijin/shared-contracts';
import type { ProviderInvoice, ProviderSubscription } from './billing-provider';

/**
 * Lecture défensive des objets Stripe (réponses du SDK ou `data.object` des webhooks, format de la version
 * d'API épinglée `STRIPE_API_VERSION`) vers les types normalisés. Tolère l'ancien emplacement des champs
 * (`subscription.current_period_end`, `invoice.subscription`) pour les événements rejoués.
 */

type Json = Readonly<Record<string, unknown>>;

function record(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** Identifiant d'une référence Stripe : chaîne ou objet développé `{ id }`. */
export function refId(value: unknown): string | null {
  return str(value) ?? str(record(value)?.['id']);
}

/** Horodatage Unix (s) → `Date`. */
export function unixDate(value: unknown): Date | null {
  const seconds = int(value);
  return seconds !== null && seconds > 0 ? new Date(seconds * 1000) : null;
}

export function subscriptionStatusOf(value: unknown): SubscriptionStatus {
  return (SUBSCRIPTION_STATUSES as readonly unknown[]).includes(value) ? (value as SubscriptionStatus) : 'incomplete';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `metadata.userId` (UUID) ou `null`. */
export function metadataUserId(value: unknown): string | null {
  const id = str(record(value)?.['userId']);
  return id && UUID.test(id) ? id.toLowerCase() : null;
}

export function intervalOf(value: unknown): BillingInterval | null {
  return value === 'month' || value === 'year' ? value : null;
}

/** Abonnement Stripe → `ProviderSubscription` ; `null` si l'objet n'en est pas un. */
export function toProviderSubscription(value: unknown): ProviderSubscription | null {
  const sub = record(value);
  if (!sub || sub['object'] !== 'subscription') return null;
  const id = str(sub['id']);
  const customerId = refId(sub['customer']);
  const items = record(sub['items']);
  const firstItem = record(Array.isArray(items?.['data']) ? (items['data'] as unknown[])[0] : null);
  const price = record(firstItem?.['price']);
  const priceId = str(price?.['id']);
  const periodEnd = unixDate(firstItem?.['current_period_end']) ?? unixDate(sub['current_period_end']);
  if (!id || !customerId || !priceId || !periodEnd) return null;
  return {
    id,
    customerId,
    status: subscriptionStatusOf(sub['status']),
    priceId,
    interval: intervalOf(record(price?.['recurring'])?.['interval']),
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: sub['cancel_at_period_end'] === true || int(sub['cancel_at']) !== null,
    userId: metadataUserId(sub['metadata']),
    latestInvoiceId: refId(sub['latest_invoice']),
  };
}

/** Abonnement d'une facture : `parent.subscription_details.subscription` (API récente) ou `subscription`. */
export function invoiceSubscriptionId(invoice: Json): string | null {
  const details = record(record(invoice['parent'])?.['subscription_details']);
  return refId(details?.['subscription']) ?? refId(invoice['subscription']);
}

/** Facture Stripe → `ProviderInvoice` ; `null` si l'objet n'en est pas une. */
export function toProviderInvoice(value: unknown): ProviderInvoice | null {
  const invoice = record(value);
  if (!invoice || invoice['object'] !== 'invoice') return null;
  const id = str(invoice['id']);
  const currency = str(invoice['currency']);
  if (!id || !currency || !/^[a-z]{3}$/i.test(currency)) return null;
  const hosted = str(invoice['hosted_invoice_url']);
  return {
    id,
    customerId: refId(invoice['customer']),
    subscriptionId: invoiceSubscriptionId(invoice),
    amountPaidCents: Math.max(0, int(invoice['amount_paid']) ?? 0),
    amountDueCents: Math.max(0, int(invoice['amount_due']) ?? 0),
    currency: currency.toUpperCase(),
    number: str(invoice['number']),
    // Lien Stripe uniquement (affiché dans le reçu).
    hostedInvoiceUrl: hosted && /^https:\/\/invoice\.stripe\.com\//.test(hosted) ? hosted : null,
    periodEnd: unixDate(invoice['period_end']),
  };
}

/** Session Checkout terminée : références utiles au rattachement. */
export interface CheckoutSessionRefs {
  readonly subscriptionId: string | null;
  readonly customerId: string | null;
  readonly userId: string | null;
}

export function checkoutSessionRefs(value: unknown): CheckoutSessionRefs | null {
  const session = record(value);
  if (!session || session['object'] !== 'checkout.session') return null;
  const reference = str(session['client_reference_id']);
  return {
    subscriptionId: session['mode'] === 'subscription' ? refId(session['subscription']) : null,
    customerId: refId(session['customer']),
    userId: metadataUserId(session['metadata']) ?? (reference && UUID.test(reference) ? reference.toLowerCase() : null),
  };
}
