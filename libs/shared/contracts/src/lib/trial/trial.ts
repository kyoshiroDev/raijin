import * as z from '../zod';
import { trialStateSchema } from '../auth/user';

/**
 * Essai Pro de 7 jours sans carte (« reverse trial », PROMPT.md §4.4, docs/ARCHITECTURE.md §13).
 * Démarré par l'API à la vérification de l'e-mail si l'anti-abus l'accepte ; géré en base, jamais par Stripe.
 * Routes (session) :
 * - `GET trial/recap` → `TrialRecap` (écran de fin d'essai, e-mails J+1 / J-2 / J0) ; 404 `TRIAL_NOT_FOUND` ;
 * - `POST trial/end-screen/seen` (CSRF) → 204 : l'écran de fin d'essai ne réapparaît plus (tous appareils).
 * L'état courant est aussi dans `GET billing/subscription` (`trial`) et, sans détail, dans `PublicUser.trial`.
 */

const DAY_MS = 86_400_000;

/**
 * Jours restants affichés (« Essai Pro : plus que N jours ») : arrondi au jour supérieur, 0 si terminé.
 * Même calcul côté API (e-mail J-2) et côté front (bandeau), à partir de `endsAt`.
 */
export function trialDaysRemaining(
  endsAt: Date | string,
  now: Date = new Date(),
): number {
  const end =
    typeof endsAt === 'string' ? Date.parse(endsAt) : endsAt.getTime();
  if (Number.isNaN(end)) return 0;
  return Math.max(0, Math.ceil((end - now.getTime()) / DAY_MS));
}

/** Message neutre d'un compte refusé par l'anti-abus : ne dit jamais pourquoi. */
export const TRIAL_INELIGIBLE_NOTICE =
  'Ton compte est en plan Gratuit. Tu peux passer à Pro quand tu veux.';

export const trialDetailsSchema = trialStateSchema.extend({
  /** `null` hors essai actif. */
  daysRemaining: z.number().int().min(0).nullable(),
  /**
   * Afficher l'écran de fin d'essai (Rai bravo + récapitulatif) : dernières 24 h de l'essai, ou essai terminé
   * sans abonnement et écran pas encore vu (`POST trial/end-screen/seen`).
   */
  endScreenDue: z.boolean(),
  /** `TRIAL_INELIGIBLE_NOTICE` si `status = ineligible`, sinon `null`. */
  notice: z.string().min(1).max(200).nullable(),
});
export type TrialDetails = z.infer<typeof trialDetailsSchema>;

/**
 * Récapitulatif de l'essai (fenêtre `startedAt` → `endsAt`, ou fin anticipée par l'abonnement) :
 * comptes calculés en base (événements `analysis_done`, `Alert`, `Watch`, `UsageCounter` wallet_scan).
 */
export const trialRecapSchema = z.object({
  status: trialStateSchema.shape.status,
  startedAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  /** Analyses de token faites pendant l'essai. */
  analysesCount: z.number().int().min(0),
  /** Alertes de suivi reçues pendant l'essai. */
  alertsCount: z.number().int().min(0),
  /** Tokens distincts analysés avec le verdict Danger (« tokens Danger évités »). */
  dangerTokensCount: z.number().int().min(0),
  walletScansCount: z.number().int().min(0),
  /** Suivis actifs maintenant, et suivis en pause à cause de la limite du plan (à choisir ou réactiver). */
  activeWatches: z.number().int().min(0),
  planLimitPausedWatches: z.number().int().min(0),
});
export type TrialRecap = z.infer<typeof trialRecapSchema>;
