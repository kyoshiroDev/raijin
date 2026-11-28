import { GA4_ID_PATTERN } from './constants';
import { cookieNames, deleteCookie } from './cookies';

/** Hôte unique du script Google (CSP : `script-src 'self' https://www.googletagmanager.com`). */
export const GTAG_SRC = 'https://www.googletagmanager.com/gtag/js';

type Gtag = (...args: unknown[]) => void;

interface Ga4Window extends Window {
  dataLayer?: unknown[];
  gtag?: Gtag;
  [disableFlag: `ga-disable-${string}`]: boolean | undefined;
}

/** Identifiant de mesure exploitable, ou `null` (absent, vide ou mal formé : GA4 désactivé). */
export function normalizeMeasurementId(value: string | null | undefined): string | null {
  const id = value?.trim() ?? '';
  return GA4_ID_PATTERN.test(id) ? id : null;
}

function win(doc: Document): Ga4Window | null {
  return (doc.defaultView as Ga4Window | null) ?? null;
}

/** GA4 chargé dans cette page (après consentement uniquement). */
export function isGa4Loaded(doc: Document): boolean {
  return typeof win(doc)?.gtag === 'function';
}

/**
 * Consent Mode v2 **basique** : appelé seulement après « Tout accepter » (ou un choix « accepté » mémorisé).
 * Déclare d'abord tout refusé, accorde uniquement `analytics_storage`, puis injecte `gtag.js` (aucun script
 * inline). Les signaux publicitaires restent refusés. Idempotent.
 */
export function loadGa4(doc: Document, rawId: string | null | undefined): boolean {
  const id = normalizeMeasurementId(rawId);
  const w = win(doc);
  if (!id || !w) return false;
  w[`ga-disable-${id}`] = false;
  if (typeof w.gtag === 'function') {
    w.gtag('consent', 'update', { analytics_storage: 'granted' });
    return true;
  }
  const dataLayer = (w.dataLayer ??= []);
  // gtag.js attend l'objet `arguments` (pas un tableau) dans dataLayer.
  w.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    dataLayer.push(arguments);
  };
  w.gtag('consent', 'default', {
    analytics_storage: 'denied',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
  });
  w.gtag('consent', 'update', { analytics_storage: 'granted' });
  w.gtag('js', new Date());
  w.gtag('config', id, { allow_google_signals: false, allow_ad_personalization_signals: false });

  const script = doc.createElement('script');
  script.async = true;
  script.src = `${GTAG_SRC}?id=${encodeURIComponent(id)}`;
  doc.head.append(script);
  return true;
}

/**
 * Retrait du consentement : plus aucun envoi dans la page (`ga-disable-<id>`, consentement refusé) et
 * suppression des cookies `_ga`, `_ga_*` déjà posés.
 */
export function disableGa4(doc: Document, rawId: string | null | undefined): void {
  const id = normalizeMeasurementId(rawId);
  const w = win(doc);
  if (id && w) {
    w[`ga-disable-${id}`] = true;
    w.gtag?.('consent', 'update', { analytics_storage: 'denied' });
  }
  for (const name of cookieNames(doc)) {
    if (name === '_ga' || name.startsWith('_ga_') || name === '_gid') deleteCookie(doc, name);
  }
}
