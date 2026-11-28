/**
 * Politique de la base `APP_URL` (fixée au build) : `https://` uniquement, sans identifiants, requête ni ancre.
 * Seule exception : `http://` vers une adresse de bouclage (127.0.0.1, localhost, ::1), pour les tests de bout en bout.
 * Vérifiée par astro.config.mjs (le build échoue) et par `appBase()`.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isAllowedAppUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK.has(url.hostname);
}

export function assertAllowedAppUrl(value: string): string {
  if (!isAllowedAppUrl(value)) {
    throw new Error('APP_URL invalide : https:// attendu (http:// accepté seulement vers 127.0.0.1 ou localhost).');
  }
  return value;
}
