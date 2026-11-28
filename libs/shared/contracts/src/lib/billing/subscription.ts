import * as z from '../zod';
import { planSchema } from '../auth/user';
import { trialDetailsSchema } from '../trial/trial';
import {
  billingIntervalSchema,
  billingModeSchema,
  entitlementsSchema,
} from './plans';

/**
 * État de l'abonnement de l'utilisateur. Route (session) : `GET billing/subscription` → `BillingAccount`.
 * Toujours relu en base (table `Subscription` alimentée par les webhooks), jamais déduit côté front.
 */

/** Statuts Stripe d'un abonnement (enum Prisma `SubscriptionStatus`, en majuscules en base). */
export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'unpaid',
  'paused',
] as const;
export const subscriptionStatusSchema = z.enum(SUBSCRIPTION_STATUSES);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

/**
 * Statuts qui donnent le plan Pro. `past_due` garde Pro pendant les relances de paiement de Stripe ;
 * `trialing` n'est jamais créé par Raijin (l'essai est interne) mais reste accepté par sécurité.
 */
export const PRO_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'active',
  'trialing',
  'past_due',
];

export function isProSubscriptionStatus(status: SubscriptionStatus): boolean {
  return PRO_SUBSCRIPTION_STATUSES.includes(status);
}

export const subscriptionSchema = z.object({
  status: subscriptionStatusSchema,
  interval: billingIntervalSchema,
  currentPeriodEnd: z.iso.datetime(),
  /** Résiliation demandée dans le portail : Pro jusqu'à `currentPeriodEnd`, puis Gratuit. */
  cancelAtPeriodEnd: z.boolean(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;

/**
 * Origine du plan effectif. `gift` (phase 6 bis) : mois de Pro offert par l'admin (`User.proGrantedUntil`), calculé
 * par `resolvePlanPolicy` ; priorité : subscription > trial > gift > free.
 */
export const planSourceSchema = z.enum(['free', 'trial', 'subscription', 'gift']);
export type PlanSource = z.infer<typeof planSourceSchema>;

export const billingAccountSchema = z.object({
  /** Plan effectif (PRO pendant l'essai actif ou avec un abonnement Pro). */
  plan: planSchema,
  source: planSourceSchema,
  entitlements: entitlementsSchema,
  /** Dernier abonnement connu ; `null` si jamais abonné. */
  subscription: subscriptionSchema.nullable(),
  trial: trialDetailsSchema,
  /** Fin du mois de Pro offert par l'admin (phase 6 bis) ; absent ou `null` si aucun en cours. */
  giftEndsAt: z.iso.datetime().nullable().optional(),
  /** Paiement en échec (`past_due`) : bandeau neutre avec le lien vers le portail. */
  paymentIssue: z.boolean(),
  /** Un compte de facturation existe (portail ouvrable). */
  portalAvailable: z.boolean(),
  /** Checkout ouvrable (mode non `unavailable`, e-mail vérifié, pas d'abonnement Pro en cours). */
  checkoutAvailable: z.boolean(),
  mode: billingModeSchema,
});
export type BillingAccount = z.infer<typeof billingAccountSchema>;
