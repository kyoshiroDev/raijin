import type { SignupAttribution } from '@raijin/shared-contracts';
import {
  ATTRIBUTION_COOKIE_MAX_AGE_DAYS,
  ATTRIBUTION_COOKIE_NAME,
  ATTRIBUTION_QUERY_PARAMS,
  ATTRIBUTION_SESSION_KEY,
} from './constants';
import { deleteCookie, readCookie, writeCookie } from './cookies';

/** Bornes de `signupAttributionSchema` (contrats), appliquées dès la capture : l'app revalide tout. */
const MAX_LABEL = 200;
const MAX_URL = 2048;
const MAX_PATH = 512;
// eslint-disable-next-line no-control-regex -- caractères de contrôle C0, DEL, C1 refusés (comme les contrats)
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

type Key = keyof SignupAttribution;
const KEYS = Object.keys(ATTRIBUTION_QUERY_PARAMS) as Key[];

function cleanLabel(value: string | null | undefined): string | undefined {
  const text = value?.trim() ?? '';
  if (!text || text.length > MAX_LABEL || CONTROL_CHARS.test(text)) return undefined;
  return text;
}

/** Référent **externe** réduit à origine + chemin (ni requête ni ancre : rien de personnel ne fuit). */
export function cleanReferrer(referrer: string, currentOrigin: string): string | undefined {
  if (!referrer) return undefined;
  try {
    const url = new URL(referrer);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (url.origin === currentOrigin) return undefined;
    const value = `${url.origin}${url.pathname}`;
    return value.length <= MAX_URL && !CONTROL_CHARS.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function cleanPath(value: string | null | undefined): string | undefined {
  const path = value?.trim() ?? '';
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return undefined;
  if (path.length > MAX_PATH || CONTROL_CHARS.test(path)) return undefined;
  return path;
}

/** Revalide un objet venu d'un stockage ou d'une URL : clés inconnues ignorées, valeurs invalides retirées. */
export function sanitizeAttribution(input: unknown): SignupAttribution | null {
  if (typeof input !== 'object' || input === null) return null;
  const raw = input as Record<string, unknown>;
  const text = (key: Key) => (typeof raw[key] === 'string' ? (raw[key] as string) : undefined);
  const result: SignupAttribution = {};
  const utmSource = cleanLabel(text('utmSource'));
  const utmMedium = cleanLabel(text('utmMedium'));
  const utmCampaign = cleanLabel(text('utmCampaign'));
  const referrer = text('referrer');
  const landingPath = cleanPath(text('landingPath'));
  if (utmSource) result.utmSource = utmSource;
  if (utmMedium) result.utmMedium = utmMedium;
  if (utmCampaign) result.utmCampaign = utmCampaign;
  if (referrer && cleanReferrer(referrer, 'null') === referrer) result.referrer = referrer;
  if (landingPath) result.landingPath = landingPath;
  return hasSignal(result) ? result : null;
}

/** Un UTM ou un référent externe : sans signal, rien n'est retenu (même règle que l'app). */
function hasSignal(value: SignupAttribution): boolean {
  return Boolean(value.utmSource || value.utmMedium || value.utmCampaign || value.referrer);
}

/** Relevé de l'URL d'arrivée et du référent, ou `null` si aucun signal. */
export function captureFromLocation(location: Pick<Location, 'href' | 'origin'>, referrer: string): SignupAttribution | null {
  let url: URL;
  try {
    url = new URL(location.href);
  } catch {
    return null;
  }
  const params = url.searchParams;
  const candidate: SignupAttribution = {};
  const utmSource = cleanLabel(params.get(ATTRIBUTION_QUERY_PARAMS.utmSource));
  const utmMedium = cleanLabel(params.get(ATTRIBUTION_QUERY_PARAMS.utmMedium));
  const utmCampaign = cleanLabel(params.get(ATTRIBUTION_QUERY_PARAMS.utmCampaign));
  const ref = cleanReferrer(referrer, location.origin);
  const landingPath = cleanPath(url.pathname);
  if (utmSource) candidate.utmSource = utmSource;
  if (utmMedium) candidate.utmMedium = utmMedium;
  if (utmCampaign) candidate.utmCampaign = utmCampaign;
  if (ref) candidate.referrer = ref;
  if (landingPath) candidate.landingPath = landingPath;
  return hasSignal(candidate) ? candidate : null;
}

function parseStored(raw: string | null): SignupAttribution | null {
  if (!raw) return null;
  try {
    return sanitizeAttribution(JSON.parse(raw));
  } catch {
    return null;
  }
}

function session(doc: Document): Storage | null {
  try {
    return doc.defaultView?.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Attribution retenue : cookie `rj_attr` (après consentement) sinon `sessionStorage`. */
export function readStoredAttribution(doc: Document): SignupAttribution | null {
  const fromCookie = parseStored(readCookie(doc, ATTRIBUTION_COOKIE_NAME));
  if (fromCookie) return fromCookie;
  try {
    return parseStored(session(doc)?.getItem(ATTRIBUTION_SESSION_KEY) ?? null);
  } catch {
    return null;
  }
}

/**
 * Range l'attribution selon le consentement : cookie de premier niveau 90 jours si la mesure d'audience est
 * acceptée, sinon `sessionStorage` (onglet courant) et suppression du cookie éventuel.
 */
export function persistAttribution(doc: Document, value: SignupAttribution | null, consented: boolean): void {
  const store = session(doc);
  if (consented) {
    if (value) writeCookie(doc, ATTRIBUTION_COOKIE_NAME, JSON.stringify(value), ATTRIBUTION_COOKIE_MAX_AGE_DAYS);
    try {
      store?.removeItem(ATTRIBUTION_SESSION_KEY);
    } catch {
      // Stockage indisponible : sans conséquence.
    }
    return;
  }
  deleteCookie(doc, ATTRIBUTION_COOKIE_NAME);
  if (!value) return;
  try {
    store?.setItem(ATTRIBUTION_SESSION_KEY, JSON.stringify(value));
  } catch {
    // Navigation privée stricte : pas d'attribution, sans conséquence.
  }
}

/** Premier contact : une attribution déjà retenue n'est jamais remplacée. */
export function resolveAttribution(doc: Document, consented: boolean): SignupAttribution | null {
  const stored = readStoredAttribution(doc);
  const value = stored ?? captureFromLocation(doc.location, doc.referrer);
  persistAttribution(doc, value, consented);
  return value;
}

/** Ajoute `utm_*`, `rj_ref`, `rj_lp` à un lien vers l'app, sans écraser un paramètre déjà présent. */
export function decorateAppUrl(href: string, value: SignupAttribution | null, base?: string): string {
  if (!value) return href;
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return href;
  }
  for (const key of KEYS) {
    const param = ATTRIBUTION_QUERY_PARAMS[key];
    const data = value[key];
    if (data && !url.searchParams.has(param)) url.searchParams.set(param, data);
  }
  return url.toString();
}

/** Complète tous les liens `a[data-app-link]` de la page (inscription, analyse dans l'app). */
export function decorateAppLinks(doc: Document, value: SignupAttribution | null): void {
  if (!value) return;
  for (const link of doc.querySelectorAll<HTMLAnchorElement>('a[data-app-link]')) {
    const href = link.getAttribute('href');
    if (href) link.setAttribute('href', decorateAppUrl(href, value, doc.location.href));
  }
}
