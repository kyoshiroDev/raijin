import { ELLIPSIS } from './address';

/** Plages [début, fin] de points de code supprimés (fin incluse). */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad], // trait d'union conditionnel
  [0x061c, 0x061c], // marque de lettre arabe (bidi)
  [0x115f, 0x1160], // remplissages Hangul
  [0x180e, 0x180e], // séparateur de voyelles mongol
  [0x200b, 0x200f], // zéro largeur, marques LRM / RLM
  [0x202a, 0x202e], // contrôles bidirectionnels (« Trojan Source »)
  [0x2060, 0x2064], // joint de mots, opérateurs invisibles
  [0x2066, 0x2069], // isolats bidirectionnels
  [0x3164, 0x3164], // remplissage Hangul
  [0xfeff, 0xfeff], // BOM / espace insécable de largeur nulle
  [0xffa0, 0xffa0], // remplissage Hangul demi-chasse
];

function isControl(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function isInvisible(codePoint: number): boolean {
  return INVISIBLE_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

/**
 * Nettoie un texte venant d'une source externe hostile (nom ou symbole de token, libellé
 * RugCheck, etc.) : remplace les caractères de contrôle C0 / C1 par une espace, retire les
 * caractères invisibles ou bidirectionnels, normalise en NFC, réduit les espaces et tronque à
 * `maxLength` points de code (ellipse comprise).
 *
 * Ne fait **pas** d'échappement HTML : l'affichage passe toujours par l'interpolation échappée
 * d'Angular / Astro (jamais `innerHTML`). Renvoie `''` pour une valeur non textuelle.
 */
export function sanitizeUntrustedText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || maxLength < 1) {
    return '';
  }
  let filtered = '';
  for (const char of value.normalize('NFC')) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (isControl(codePoint)) {
      filtered += ' ';
    } else if (!isInvisible(codePoint)) {
      filtered += char;
    }
  }
  const cleaned = filtered.replace(/\s+/g, ' ').trim();
  const codePoints = Array.from(cleaned);
  if (codePoints.length <= maxLength) {
    return cleaned;
  }
  return `${codePoints.slice(0, maxLength - 1).join('').trimEnd()}${ELLIPSIS}`;
}
