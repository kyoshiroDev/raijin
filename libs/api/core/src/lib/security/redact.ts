/**
 * Masque les identifiants d'une URL de connexion (`redis://:<mot de passe>@hôte`, `postgresql://user:pass@hôte`)
 * dans un texte destiné aux journaux (message, stack) : l'URL elle-même n'est jamais journalisée en clair.
 */
const CREDENTIALS_IN_URL = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]*@/gi;

export function redactCredentials(text: string): string {
  return text.replace(CREDENTIALS_IN_URL, '$1***@');
}
