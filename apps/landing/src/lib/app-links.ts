import { isSolanaAddress } from '@raijin/shared-util';

/**
 * Construction des liens vers l'app, **sans** dépendance à `astro:env` : utilisable au build comme dans l'îlot du
 * champ d'analyse (la base vient alors de l'attribut `action` du formulaire, fixé au build).
 */

/** Base de l'app sans barre finale. */
export function normalizeAppBase(base: string): string {
  return base.replace(/\/+$/, '');
}

/**
 * URL `…/analyse/<mint>` de l'app, ou `null` si la chaîne n'est pas une adresse Solana valide (base58, 32 octets).
 * Le mint n'est encodé qu'après validation : aucun caractère de chemin, de requête ou d'ancre ne peut passer.
 */
export function buildAnalyseUrl(base: string, mint: string): string | null {
  if (!isSolanaAddress(mint)) return null;
  return `${normalizeAppBase(base)}/analyse/${encodeURIComponent(mint)}`;
}
