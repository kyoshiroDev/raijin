import { CONSENT_COOKIE_NAME, CONSENT_MAX_AGE_DAYS, CONSENT_VERSION, DAY_MS } from './constants';
import { readCookie, writeCookie } from './cookies';

/** Choix mémorisé : une seule finalité soumise au consentement, la mesure d'audience. */
export interface ConsentChoice {
  analytics: boolean;
  /** Date du choix (minuit UTC du jour). */
  date: Date;
}

const VALUE_PATTERN = /^v(\d+)\.(granted|denied)\.(\d{4}-\d{2}-\d{2})$/;

/** `v1.granted.2026-11-22` (format de docs/ARCHITECTURE.md §14.10). */
export function serializeConsent(analytics: boolean, now: Date): string {
  return `v${CONSENT_VERSION}.${analytics ? 'granted' : 'denied'}.${now.toISOString().slice(0, 10)}`;
}

/**
 * Choix valide, ou `null` (absent, illisible, d'une version antérieure, daté dans le futur ou de plus de
 * 6 mois) : la bannière est alors reproposée et rien n'est chargé.
 */
export function parseConsent(value: string | null, now: Date): ConsentChoice | null {
  if (!value) return null;
  const match = VALUE_PATTERN.exec(value);
  if (!match || Number(match[1]) !== CONSENT_VERSION) return null;
  const date = new Date(`${match[3] ?? ''}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  const age = now.getTime() - date.getTime();
  if (age < -DAY_MS || age >= CONSENT_MAX_AGE_DAYS * DAY_MS) return null;
  return { analytics: match[2] === 'granted', date };
}

export function readConsent(doc: Document, now: Date = new Date()): ConsentChoice | null {
  return parseConsent(readCookie(doc, CONSENT_COOKIE_NAME), now);
}

export function writeConsent(doc: Document, analytics: boolean, now: Date = new Date()): ConsentChoice {
  const value = serializeConsent(analytics, now);
  writeCookie(doc, CONSENT_COOKIE_NAME, value, CONSENT_MAX_AGE_DAYS);
  return parseConsent(value, now) ?? { analytics, date: now };
}

/** Mesure d'audience autorisée (choix valide et explicite). */
export function hasAnalyticsConsent(doc: Document, now: Date = new Date()): boolean {
  return readConsent(doc, now)?.analytics === true;
}
