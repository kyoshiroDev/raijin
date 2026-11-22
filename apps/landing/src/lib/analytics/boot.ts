import type { SignupAttribution } from '@raijin/shared-contracts';
import { decorateAppLinks, persistAttribution, resolveAttribution } from './attribution';
import { initConsentBanner, type ConsentBannerHandle } from './banner';
import { hasAnalyticsConsent } from './consent';
import { disableGa4, loadGa4, normalizeMeasurementId } from './ga4';
import { bindDeclarativeTracking } from './track';

export const CONSENT_BANNER_ID = 'rj-consent';

export interface AnalyticsBoot {
  measurementId: string | null;
  attribution: SignupAttribution | null;
  banner: ConsentBannerHandle | null;
}

/**
 * Point d'entrée unique (script module de `Base.astro`) :
 * 1. attribution de première visite (session sans consentement, cookie `rj_attr` après) + liens vers l'app ;
 * 2. sans identifiant GA4 valide (bannière absente) : rien d'autre, aucun script Google ;
 * 3. sinon bannière, et GA4 chargé **uniquement** si la mesure d'audience est acceptée.
 */
export function bootAnalytics(doc: Document): AnalyticsBoot {
  const element = doc.getElementById(CONSENT_BANNER_ID);
  const measurementId = normalizeMeasurementId(element?.dataset['ga4Id']);
  const consented = measurementId !== null && hasAnalyticsConsent(doc);

  const attribution = resolveAttribution(doc, consented);
  decorateAppLinks(doc, attribution);
  bindDeclarativeTracking(doc);

  if (!element || !measurementId) return { measurementId: null, attribution, banner: null };

  if (consented) loadGa4(doc, measurementId);
  const banner = initConsentBanner(doc, element, {
    onChange(analytics) {
      if (analytics) loadGa4(doc, measurementId);
      else disableGa4(doc, measurementId);
      persistAttribution(doc, attribution, analytics);
    },
  });
  return { measurementId, attribution, banner };
}
