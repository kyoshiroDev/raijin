import type { BillingInterval, BillingMode, SubscriptionStatus } from '@raijin/shared-contracts';

/**
 * Abstraction du prestataire de paiement (docs/ARCHITECTURE.md §13.8). Le domaine (webhook, Checkout,
 * portail) ne manipule que ces types normalisés : `StripeBillingProvider` (SDK officiel) et
 * `FakeBillingProvider` (simulation locale, sans réseau ni donnée de carte) les produisent.
 */

/** Abonnement relu chez le prestataire (source de vérité de l'état). */
export interface ProviderSubscription {
  readonly id: string;
  readonly customerId: string;
  readonly status: SubscriptionStatus;
  readonly priceId: string;
  /** Périodicité du prix (`null` : prix non mensuel / annuel). */
  readonly interval: BillingInterval | null;
  readonly currentPeriodEnd: Date;
  /** Résiliation programmée (`cancel_at_period_end` ou `cancel_at`). */
  readonly cancelAtPeriodEnd: boolean;
  /** `metadata.userId` posé à la création du Checkout (`subscription_data.metadata`). */
  readonly userId: string | null;
  readonly latestInvoiceId: string | null;
}

/** Facture relue chez le prestataire (reçu, échec de paiement). */
export interface ProviderInvoice {
  readonly id: string;
  readonly customerId: string | null;
  readonly subscriptionId: string | null;
  readonly amountPaidCents: number;
  readonly amountDueCents: number;
  /** ISO 4217 en majuscules. */
  readonly currency: string;
  readonly number: string | null;
  readonly hostedInvoiceUrl: string | null;
  readonly periodEnd: Date | null;
}

/** Événement de webhook vérifié (signature, horodatage). `object` : `data.object` brut, à interpréter. */
export interface BillingWebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly created: Date;
  readonly livemode: boolean;
  readonly object: Readonly<Record<string, unknown>>;
}

export interface CheckoutInput {
  readonly userId: string;
  readonly customerId: string;
  readonly interval: BillingInterval;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly idempotencyKey: string;
}

export interface CustomerInput {
  readonly userId: string;
  readonly email: string;
  readonly idempotencyKey: string;
}

/** Signature absente, invalide, trop ancienne ou corps illisible : 400 `BILLING_WEBHOOK_INVALID`. */
export class WebhookSignatureError extends Error {
  constructor() {
    super('Signature de webhook invalide');
    this.name = 'WebhookSignatureError';
  }
}

/** Prestataire non configuré ou prix non vérifiés : 503 `BILLING_NOT_CONFIGURED`. */
export class BillingUnavailableError extends Error {
  constructor() {
    super('Paiement indisponible');
    this.name = 'BillingUnavailableError';
  }
}

/** Résultat de la vérification des prix au démarrage. */
export type PriceCheck = 'ok' | 'mismatch' | 'error';

export abstract class BillingProvider {
  /** Mode exposé au front (`GET billing/plans`, `GET billing/subscription`). */
  abstract mode(): BillingMode;
  /** Mode réel (clé live) : `event.livemode` doit correspondre. */
  abstract readonly livemode: boolean;
  abstract createCustomer(input: CustomerInput): Promise<string>;
  /** URL de redirection vers Checkout (ou la page de simulation). */
  abstract createCheckoutSession(input: CheckoutInput): Promise<string>;
  /** URL du portail client (ou de la page de simulation du portail). */
  abstract createPortalSession(customerId: string, returnUrl: string): Promise<string>;
  /** Abonnements ouvrant Pro (`active`, `trialing`, `past_due`) d'un client chez le prestataire. */
  abstract listProSubscriptions(customerId: string): Promise<ProviderSubscription[]>;
  /** Résiliation immédiate, sans prorata ni facture finale ; abonnement déjà résilié ou introuvable : sans effet. */
  abstract cancelSubscriptionNow(id: string): Promise<void>;
  /** Suppression du client (moyens de paiement compris) ; client déjà supprimé ou introuvable : sans effet. */
  abstract deleteCustomer(customerId: string): Promise<void>;
  /** `null` : abonnement introuvable chez le prestataire. */
  abstract retrieveSubscription(id: string): Promise<ProviderSubscription | null>;
  abstract retrieveInvoice(id: string): Promise<ProviderInvoice | null>;
  /** Vérifie la signature (corps brut) ; lève `WebhookSignatureError`. */
  abstract constructWebhookEvent(rawBody: Buffer, signature: string | undefined): BillingWebhookEvent;
  /** Compare les prix du prestataire à la configuration (`PRO_PRICE_*_CENTS`, devise, périodicité). */
  abstract verifyPrices(): Promise<PriceCheck>;
}
