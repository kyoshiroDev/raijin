/**
 * Ajouts et exceptions maison à la liste CC0 des domaines jetables (disposable-domains.generated.ts).
 * Modifié à la main, relu en revue de code. Domaines en minuscules, sans `@`.
 */

/** Domaines jetables absents de la liste source (ajoutés après constat d'abus ou de doublon connu). */
export const DISPOSABLE_DOMAINS_LOCAL_ADDITIONS: readonly string[] = [
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
  'cool.fr.nf',
  'jetable.fr.nf',
  'courriel.fr.nf',
  'moncourrier.fr.nf',
  'monemail.fr.nf',
  'monmail.fr.nf',
  'jetable.org',
  'trashmail.fr',
];

/** Domaines de la liste source à ne jamais traiter comme jetables (faux positifs constatés). */
export const DISPOSABLE_DOMAINS_LOCAL_EXCEPTIONS: readonly string[] = [];
