import { DAY_MS } from './constants';

/** Lecture d'un cookie de premier niveau (valeur décodée), ou `null`. */
export function readCookie(doc: Document, name: string): string | null {
  for (const part of doc.cookie.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** Cookie de premier niveau, limité à l'hôte de la landing, `SameSite=Lax`, `Secure` en HTTPS. */
export function writeCookie(doc: Document, name: string, value: string, maxAgeDays: number): void {
  const secure = doc.location?.protocol === 'https:' ? '; Secure' : '';
  const maxAge = Math.round((maxAgeDays * DAY_MS) / 1000);
  doc.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax${secure}`;
}

/**
 * Supprime un cookie sur l'hôte courant et sur chacun de ses domaines parents (les cookies GA4 sont posés
 * sur le domaine de plus haut niveau possible, par exemple `.raijinshield.com`).
 */
export function deleteCookie(doc: Document, name: string): void {
  const expired = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
  doc.cookie = expired;
  const labels = (doc.location?.hostname ?? '').split('.');
  for (let i = 0; i < labels.length - 1; i += 1) {
    doc.cookie = `${expired}; Domain=.${labels.slice(i).join('.')}`;
  }
}

/** Noms des cookies présents (sans valeur). */
export function cookieNames(doc: Document): string[] {
  return doc.cookie
    .split(';')
    .map((part) => part.split('=')[0]?.trim() ?? '')
    .filter((name) => name.length > 0);
}
