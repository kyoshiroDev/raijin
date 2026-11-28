/**
 * Analyse d'URL minimale et pure (sans `URL`, absent de `lib: es2022` et des globaux communs
 * Node / navigateur / Deno). Volontairement stricte : tout ce qui est ambigu est refusé.
 */

/** Longueur maximale d'une URL acceptée. */
export const URL_MAX_LENGTH = 2048;

export interface ParsedUrlLike {
  /** Schéma en minuscules (`https`, `http`) ou `null` si absent (`dexscreener.com/...`). */
  readonly scheme: string | null;
  /** Hôte en minuscules, sans `www.` initial. */
  readonly host: string;
  /** Segments de chemin non vides, non décodés. */
  readonly segments: readonly string[];
  /** Paramètres de requête (premier occurrence gagnante), non décodés. */
  readonly query: Readonly<Record<string, string>>;
}

const URL_LIKE = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?(?:#.*)?$/i;
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Découpe une chaîne qui ressemble à une URL. Renvoie `null` si elle contient des espaces, des
 * identifiants (`user@host`), un port, une barre oblique inverse ou un hôte invalide.
 */
export function parseUrlLike(value: string): ParsedUrlLike | null {
  if (value.length === 0 || value.length > URL_MAX_LENGTH || /[\s\\]/.test(value)) {
    return null;
  }
  const match = URL_LIKE.exec(value);
  if (!match) {
    return null;
  }
  const [, rawScheme, rawHost = '', rawPath = '', rawQuery = ''] = match;
  const lowerHost = rawHost.toLowerCase();
  if (!HOST.test(lowerHost)) {
    return null;
  }
  const host = lowerHost.startsWith('www.') ? lowerHost.slice(4) : lowerHost;
  const query: Record<string, string> = {};
  for (const pair of rawQuery.split('&')) {
    if (pair.length === 0) {
      continue;
    }
    const eq = pair.indexOf('=');
    const key = (eq === -1 ? pair : pair.slice(0, eq)).toLowerCase();
    if (!(key in query)) {
      query[key] = eq === -1 ? '' : pair.slice(eq + 1);
    }
  }
  return {
    scheme: rawScheme ? rawScheme.toLowerCase() : null,
    host,
    segments: rawPath.split('/').filter((segment) => segment.length > 0),
    query,
  };
}

/** Vrai si `host` est l'un des domaines autorisés ou l'un de leurs sous-domaines. */
export function isHostAllowed(host: string, allowedHosts: readonly string[]): boolean {
  const lower = host.toLowerCase();
  return allowedHosts.some((allowed) => lower === allowed || lower.endsWith(`.${allowed}`));
}

/**
 * Vrai si `value` est une URL `https://` absolue dont l'hôte figure dans la liste blanche
 * (sous-domaines compris). Toute donnée externe affichée comme lien passe par ce filtre
 * (PROMPT.md §8 : URLs en https uniquement, liste de domaines autorisés).
 */
export function isAllowedHttpsUrl(value: string, allowedHosts: readonly string[]): boolean {
  const parsed = parseUrlLike(value);
  return parsed !== null && parsed.scheme === 'https' && isHostAllowed(parsed.host, allowedHosts);
}
