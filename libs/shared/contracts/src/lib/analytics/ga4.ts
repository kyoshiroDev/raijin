import type { SignupAttribution } from '../auth/attribution';
import type { Verdict } from '../verdict';

/**
 * Suivi Google de la **landing uniquement** (PROMPT.md §4.6, docs/ANALYTICS.md). L'app `apps/web` n'embarque pas
 * GA4 : ses mesures restent internes (`ProductEvent`, `DailyMetric`).
 *
 * Ce module n'importe pas Zod (constantes et types seulement) : la landing peut l'utiliser en `import type` sans
 * alourdir ses îlots ; un test de la landing vérifie que ses constantes d'exécution sont identiques à celles-ci.
 */

/** Événements GA4 de la landing (snake_case, liste fermée). */
export const GA4_EVENT_NAMES = [
  'analyse_demo_lancee',
  'analyse_demo_resultat',
  'cta_essai_clic',
  'inscription_debut',
  'voir_tarifs',
  'guide_lu',
  'faq_ouverte',
] as const;
export type Ga4EventName = (typeof GA4_EVENT_NAMES)[number];

/** Emplacements d'un CTA d'essai (paramètre `emplacement`). */
export const GA4_CTA_PLACEMENTS = ['header', 'hero', 'verdicts', 'tarifs', 'faq', 'final', 'guide'] as const;
export type Ga4CtaPlacement = (typeof GA4_CTA_PLACEMENTS)[number];

/** Paramètres de chaque événement (aucune donnée personnelle, aucune adresse de wallet, aucun mint saisi). */
export interface Ga4EventParams {
  analyse_demo_lancee: Record<string, never>;
  analyse_demo_resultat: { verdict: Verdict };
  cta_essai_clic: { emplacement: Ga4CtaPlacement };
  inscription_debut: { emplacement: Ga4CtaPlacement };
  voir_tarifs: Record<string, never>;
  guide_lu: { slug: string };
  faq_ouverte: { faq_id: string };
}

/**
 * Événements clés (conversions) à marquer dans GA4. L'inscription confirmée et l'abonnement ont lieu dans l'app
 * (sans GA4) : ils sont mesurés en interne et reliés aux sources par l'écran Acquisition (docs/ANALYTICS.md).
 */
export const GA4_KEY_EVENTS: readonly Ga4EventName[] = ['inscription_debut', 'cta_essai_clic'];

// ---------------------------------------------------------------------------------------------
// Consentement (bannière maison, CNIL) : choix mémorisé 6 mois dans un cookie de premier niveau de la landing.
// ---------------------------------------------------------------------------------------------

export const CONSENT_COOKIE_NAME = 'rj_consent';
/** 6 mois (PROMPT.md §4.6). Au-delà, la bannière est reproposée. */
export const CONSENT_MAX_AGE_DAYS = 182;
/** Incrémenté si les finalités changent : un choix d'une version antérieure est redemandé. */
export const CONSENT_VERSION = 1;
/** Une seule finalité soumise au consentement : la mesure d'audience GA4 (aucune publicité). */
export const CONSENT_PURPOSES = ['analytics'] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

// ---------------------------------------------------------------------------------------------
// Attribution de première visite : landing → app → `POST auth/register` (`signupAttributionSchema`).
// ---------------------------------------------------------------------------------------------

/** Cookie de premier niveau de la landing, posé seulement après consentement (sinon mémoire de session). */
export const ATTRIBUTION_COOKIE_NAME = 'rj_attr';
export const ATTRIBUTION_COOKIE_MAX_AGE_DAYS = 90;

/**
 * Paramètres d'URL transmis par les liens de la landing vers l'app (`/inscription`, `/analyse`). L'app les lit au
 * démarrage (`AttributionTracker`) : les UTM gardent leur nom standard, la provenance et la page d'arrivée de la
 * landing passent par `rj_ref` et `rj_lp` (le référent vu par l'app serait sinon la landing elle-même).
 */
export const ATTRIBUTION_QUERY_PARAMS = {
  utmSource: 'utm_source',
  utmMedium: 'utm_medium',
  utmCampaign: 'utm_campaign',
  referrer: 'rj_ref',
  landingPath: 'rj_lp',
} as const satisfies Readonly<Record<keyof SignupAttribution, string>>;
