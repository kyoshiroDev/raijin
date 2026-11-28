import * as z from '../zod';
import { billingIntervalSchema } from './plans';

/**
 * Événements produit de l'essai et de l'abonnement (table `ProductEvent`, colonne `type`), lus par le
 * tableau de conversion (phase 6) puis par l'admin (phase 6 bis). Propriétés sans donnée personnelle.
 */
export const TRIAL_EVENT_TYPES = [
  'trial_started',
  'trial_refused',
  'trial_converted',
  'trial_expired',
] as const;
export const BILLING_EVENT_TYPES = [
  'checkout_started',
  'subscription_activated',
  'subscription_canceled',
  'payment_failed',
] as const;
export const billingProductEventTypeSchema = z.enum([
  ...TRIAL_EVENT_TYPES,
  ...BILLING_EVENT_TYPES,
]);
export type BillingProductEventType = z.infer<
  typeof billingProductEventTypeSchema
>;

/** Motif interne d'un refus d'essai : jamais renvoyé à l'utilisateur (message neutre), compté par l'admin. */
export const TRIAL_REFUSAL_REASONS = [
  'email_already_used',
  'disposable_domain',
  'fingerprint_seen',
] as const;
export const trialRefusalReasonSchema = z.enum(TRIAL_REFUSAL_REASONS);
export type TrialRefusalReason = z.infer<typeof trialRefusalReasonSchema>;

/** Propriétés (`ProductEvent.properties`) par type ; `{}` pour les autres. */
export const trialRefusedPropertiesSchema = z
  .object({ reason: trialRefusalReasonSchema })
  .strict();
export const trialConvertedPropertiesSchema = z
  .object({
    /** `during` : abonné pendant l'essai (qui prend fin) ; `after` : dans `TRIAL_CONVERSION_WINDOW_DAYS` après. */
    phase: z.enum(['during', 'after']),
    interval: billingIntervalSchema,
  })
  .strict();
export const trialExpiredPropertiesSchema = z
  .object({ pausedWatches: z.number().int().min(0) })
  .strict();
export const checkoutStartedPropertiesSchema = z
  .object({ interval: billingIntervalSchema })
  .strict();

/** Événements Stripe traités par `POST billing/webhook` ; les autres sont acquittés (200) et ignorés. */
export const STRIPE_WEBHOOK_EVENT_TYPES = [
  'checkout.session.completed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
  /** Reçus (premier paiement et renouvellements), idempotents par facture. */
  'invoice.paid',
] as const;
export type StripeWebhookEventType =
  (typeof STRIPE_WEBHOOK_EVENT_TYPES)[number];
