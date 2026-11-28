import type { ConsentPurpose, Ga4CtaPlacement, Ga4EventName, SignupAttribution } from '@raijin/shared-contracts';

/**
 * Copies d'exécution des constantes de `libs/shared/contracts/src/lib/analytics/ga4.ts`.
 * La landing n'importe que des **types** depuis les contrats (aucun Zod dans ses scripts) ;
 * `constants.spec.ts` vérifie que ces valeurs restent identiques à celles des contrats.
 */

export const GA4_EVENT_NAMES: readonly Ga4EventName[] = [
  'analyse_demo_lancee',
  'analyse_demo_resultat',
  'cta_essai_clic',
  'inscription_debut',
  'voir_tarifs',
  'guide_lu',
  'faq_ouverte',
];

export const GA4_CTA_PLACEMENTS: readonly Ga4CtaPlacement[] = [
  'header',
  'hero',
  'verdicts',
  'tarifs',
  'faq',
  'final',
  'guide',
];

export const CONSENT_COOKIE_NAME = 'rj_consent';
export const CONSENT_MAX_AGE_DAYS = 182;
export const CONSENT_VERSION = 1;
export const CONSENT_PURPOSES: readonly ConsentPurpose[] = ['analytics'];

export const ATTRIBUTION_COOKIE_NAME = 'rj_attr';
export const ATTRIBUTION_COOKIE_MAX_AGE_DAYS = 90;

export const ATTRIBUTION_QUERY_PARAMS = {
  utmSource: 'utm_source',
  utmMedium: 'utm_medium',
  utmCampaign: 'utm_campaign',
  referrer: 'rj_ref',
  landingPath: 'rj_lp',
} as const satisfies Readonly<Record<keyof SignupAttribution, string>>;

/** Clé `sessionStorage` de l'attribution tant que le consentement n'est pas donné. */
export const ATTRIBUTION_SESSION_KEY = 'rj.attribution';

/** Identifiant de mesure GA4 attendu (« G-XXXXXXX ») : toute autre valeur désactive GA4. */
export const GA4_ID_PATTERN = /^G-[A-Z0-9]{4,20}$/;

export const DAY_MS = 86_400_000;
