import * as z from '../zod';

/**
 * Codes d'erreur de l'abonnement et de l'essai Pro (phase 6, docs/ARCHITECTURE.md §13). S'ajoutent aux
 * codes génériques (`UNAUTHORIZED`, `RATE_LIMITED`) et à `AUTH_EMAIL_NOT_VERIFIED` (Checkout exige un
 * e-mail vérifié). Aucun code ne révèle pourquoi un essai a été refusé (anti-abus, message neutre).
 */
export const BILLING_ERROR_CODES = [
  /** Paiement indisponible : `BILLING_PROVIDER=stripe` sans clés valides, ou prix non configurés : 503. */
  'BILLING_NOT_CONFIGURED',
  /** Un abonnement Pro est déjà en cours (actif ou en retard de paiement) : 409. Le front propose le portail. */
  'ALREADY_SUBSCRIBED',
  /** Portail demandé sans compte de facturation (jamais abonné) : 409. */
  'NO_BILLING_ACCOUNT',
  /** Webhook refusé (signature absente, invalide ou trop ancienne) : 400. Jamais affiché par le front. */
  'BILLING_WEBHOOK_INVALID',
  /** Récapitulatif ou écran de fin d'essai demandé par un compte qui n'a jamais eu d'essai : 404. */
  'TRIAL_NOT_FOUND',
] as const;

export const billingErrorCodeSchema = z.enum(BILLING_ERROR_CODES);
export type BillingErrorCode = z.infer<typeof billingErrorCodeSchema>;

/** Messages français (ton neutre, aucune urgence artificielle). */
export const BILLING_ERROR_MESSAGES: Readonly<
  Record<BillingErrorCode, string>
> = {
  BILLING_NOT_CONFIGURED:
    'L’abonnement n’est pas encore disponible. Réessaie un peu plus tard.',
  ALREADY_SUBSCRIBED:
    'Tu es déjà abonné à Pro. Tu peux gérer ton abonnement depuis cette page.',
  NO_BILLING_ACCOUNT: 'Aucun abonnement à gérer pour ce compte.',
  BILLING_WEBHOOK_INVALID: 'Requête refusée.',
  TRIAL_NOT_FOUND: 'Aucun essai Pro n’est associé à ce compte.',
};
