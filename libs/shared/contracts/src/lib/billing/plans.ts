import * as z from '../zod';
import { planSchema } from '../auth/user';

/**
 * Plans et prix (PROMPT.md §4.4). Tout vient de la configuration de l'API (`PRO_PRICE_*_CENTS`,
 * `*_LIMIT`), jamais d'une valeur en dur dans le front. Route publique (sans session) :
 * `GET billing/plans` → `BillingPlansResponse` (aucun secret, aucun identifiant de prix Stripe).
 */

/** Périodicité d'un abonnement Pro (enum Prisma `BillingInterval` : MONTH / YEAR). */
export const BILLING_INTERVALS = ['month', 'year'] as const;
export const billingIntervalSchema = z.enum(BILLING_INTERVALS);
export type BillingInterval = z.infer<typeof billingIntervalSchema>;

export const BILLING_INTERVAL_LABELS: Readonly<
  Record<BillingInterval, string>
> = {
  month: 'Mensuel',
  year: 'Annuel',
};

/**
 * Mode de paiement côté serveur :
 * - `stripe` : Stripe configuré (Checkout hébergé, portail client) ;
 * - `simulation` : `FakeBillingProvider` (dev et tests, refusé en production) ; le front affiche « mode simulation » ;
 * - `unavailable` : Stripe non configuré en production (`BILLING_NOT_CONFIGURED`), boutons désactivés.
 */
export const billingModeSchema = z.enum([
  'stripe',
  'simulation',
  'unavailable',
]);
export type BillingMode = z.infer<typeof billingModeSchema>;

/**
 * Droits effectifs d'un plan, calculés par l'API (`resolvePlanPolicy`, docs/ARCHITECTURE.md §13.4).
 * `analysesPerDay: null` = illimité.
 */
export const entitlementsSchema = z.object({
  analysesPerDay: z.number().int().positive().nullable(),
  maxActiveWatches: z.number().int().min(0),
  pushAlerts: z.boolean(),
  /** 0 = scan de wallet non inclus (Gratuit). */
  walletScansPerDay: z.number().int().min(0),
  alertHistoryDays: z.number().int().min(1).max(366),
});
export type Entitlements = z.infer<typeof entitlementsSchema>;

/** Prix affiché : montant TTC en centimes (entier, jamais de flottant) et devise ISO 4217 en majuscules. */
export const priceSchema = z.object({
  interval: billingIntervalSchema,
  amountCents: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
export type Price = z.infer<typeof priceSchema>;

export const billingPlansResponseSchema = z.object({
  free: z.object({
    plan: z.literal(planSchema.enum.FREE),
    entitlements: entitlementsSchema,
  }),
  pro: z.object({
    plan: z.literal(planSchema.enum.PRO),
    entitlements: entitlementsSchema,
    monthly: priceSchema.extend({ interval: z.literal('month') }),
    yearly: priceSchema.extend({ interval: z.literal('year') }),
  }),
  /** Essai Pro sans carte : durée et droits (Pro, analyses plafonnées). */
  trial: z.object({
    days: z.number().int().min(1).max(30),
    entitlements: entitlementsSchema,
  }),
  mode: billingModeSchema,
});
export type BillingPlansResponse = z.infer<typeof billingPlansResponseSchema>;

/** Durée de l'essai par défaut (`TRIAL_DAYS`), pour les textes statiques (landing). */
export const DEFAULT_TRIAL_DAYS = 7;

/** Phrase d'offre (hero de la landing, page tarifs, page Abonnement). */
export function trialOfferText(days: number = DEFAULT_TRIAL_DAYS): string {
  return `Essaie Pro gratuitement pendant ${days} jours. Sans carte bancaire.`;
}

/**
 * Économie de l'annuel par rapport à 12 mensualités, en pourcentage entier (149 € contre 178,80 € → 17).
 * 0 si l'annuel n'est pas moins cher. Information de prix, pas une promesse de gain.
 */
export function yearlySavingsPercent(
  monthlyCents: number,
  yearlyCents: number,
): number {
  const twelve = monthlyCents * 12;
  if (twelve <= 0 || yearlyCents >= twelve) return 0;
  return Math.round((1 - yearlyCents / twelve) * 100);
}
