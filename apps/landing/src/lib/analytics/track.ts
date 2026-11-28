import type { Ga4EventName, Ga4EventParams } from '@raijin/shared-contracts';
import { GA4_CTA_PLACEMENTS, GA4_EVENT_NAMES } from './constants';
import { hasAnalyticsConsent } from './consent';
import { isGa4Loaded } from './ga4';

type ParamsArg<N extends Ga4EventName> = Ga4EventParams[N] extends Record<string, never> ? [] : [Ga4EventParams[N]];

/**
 * Envoie un événement GA4 de la liste fermée des contrats. **No-op** sans consentement ou sans GA4 chargé :
 * aucun envoi, aucune file d'attente. Renvoie `true` si l'événement est parti.
 */
export function track<N extends Ga4EventName>(name: N, ...params: ParamsArg<N>): boolean {
  if (typeof document === 'undefined') return false;
  return sendEvent(document, name, (params[0] ?? {}) as Record<string, string>);
}

function sendEvent(doc: Document, name: string, params: Record<string, string>): boolean {
  if (!(GA4_EVENT_NAMES as readonly string[]).includes(name)) return false;
  if (!hasAnalyticsConsent(doc) || !isGa4Loaded(doc)) return false;
  const gtag = (doc.defaultView as (Window & { gtag?: (...args: unknown[]) => void }) | null)?.gtag;
  gtag?.('event', name, params);
  return true;
}

/** Paramètres autorisés par événement (valeurs lues dans les attributs `data-track-*`). */
const DECLARATIVE_PARAMS: Readonly<Record<Ga4EventName, readonly string[]>> = {
  analyse_demo_lancee: [],
  analyse_demo_resultat: ['verdict'],
  cta_essai_clic: ['emplacement'],
  inscription_debut: ['emplacement'],
  voir_tarifs: [],
  guide_lu: ['slug'],
  faq_ouverte: ['faq_id'],
};

const SAFE_VALUE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VERDICTS = ['safe', 'warn', 'danger'];

function isValidParam(key: string, value: string): boolean {
  if (!SAFE_VALUE.test(value)) return false;
  if (key === 'emplacement') return (GA4_CTA_PLACEMENTS as readonly string[]).includes(value);
  if (key === 'verdict') return VERDICTS.includes(value);
  return true;
}

/**
 * Suivi déclaratif pour les pages sans îlot : `<a data-track="cta_essai_clic" data-track-emplacement="hero">`.
 * Nom hors liste, paramètre manquant ou invalide : rien n'est envoyé.
 */
export function trackFromElement(doc: Document, element: Element): boolean {
  const name = element.getAttribute('data-track') ?? '';
  const keys = DECLARATIVE_PARAMS[name as Ga4EventName];
  if (!keys) return false;
  const params: Record<string, string> = {};
  for (const key of keys) {
    const value = element.getAttribute(`data-track-${key.replace(/_/g, '-')}`) ?? '';
    if (!isValidParam(key, value)) return false;
    params[key] = value;
  }
  return sendEvent(doc, name, params);
}

/** Délégation unique des clics sur `[data-track]` (capture : part avant la navigation). */
export function bindDeclarativeTracking(doc: Document): void {
  doc.addEventListener(
    'click',
    (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-track]') : null;
      if (target) trackFromElement(doc, target);
    },
    { capture: true },
  );
}
