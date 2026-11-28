import { relativePathSchema } from '@raijin/shared-contracts';

/** Écran par défaut après connexion. */
export const DEFAULT_AFTER_LOGIN = '/compte';

/** Écrans d'auth : on n'y renvoie jamais après connexion (boucle). */
const AUTH_PATHS = /^\/compte\/(connexion|inscription|lien-magique|mot-de-passe-oublie|reinitialiser-mot-de-passe|verifier-email)(?=[/?#]|$)/;

/**
 * Cible de redirection sûre après connexion : chemin relatif interne validé par
 * `relativePathSchema` (pas de schéma, pas de `//`, pas de `\`, pas de caractère de contrôle).
 * Toute autre valeur (URL absolue, `javascript:`, chemin protocol-relative…) donne `fallback`.
 */
export function safeRedirect(value: unknown, fallback = DEFAULT_AFTER_LOGIN): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  const parsed = relativePathSchema.safeParse(value);
  if (!parsed.success) return fallback;
  const path = parsed.data;
  // Navigateurs : `/\t/exemple.com` ou `/%5Cexemple.com` normalisés en URL externe. Décodé, on revérifie.
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return fallback;
  }
  if (!relativePathSchema.safeParse(decoded).success) return fallback;
  return AUTH_PATHS.test(path) ? fallback : path;
}
