/**
 * Nettoyage des valeurs venues de Google (données **hostiles** : titres de page, requêtes de recherche, sources UTM
 * saisies par n'importe qui) avant la validation par les contrats : caractères de contrôle retirés, longueur bornée,
 * nombres finis et positifs. Rien n'est interprété : le front affiche par interpolation (jamais `innerHTML`).
 */

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Texte borné à `max` caractères (points de code), sans caractère de contrôle. */
export function cleanText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.replace(CONTROL_CHARS, ' ').trim() : '';
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/** Nombre fini ≥ 0 (les métriques Google arrivent en chaînes). */
export function cleanNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Entier ≥ 0. */
export function cleanCount(value: unknown): number {
  return Math.round(cleanNumber(value));
}

/** Ratio borné à [0, 1]. */
export function cleanRatio(value: unknown): number {
  return Math.min(1, cleanNumber(value));
}

/** Part de `value` dans `total` (0 si total nul). */
export function share(value: number, total: number): number {
  return total > 0 ? Math.min(1, value / total) : 0;
}
