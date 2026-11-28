/** Vrai si l'URL vise l'API Raijin (les autres origines ne reçoivent ni cookies ni jeton CSRF). */
export function isApiUrl(url: string, base: string): boolean {
  const root = base.endsWith('/') ? base.slice(0, -1) : base;
  return url === root || url.startsWith(`${root}/`) || url.startsWith(`${root}?`);
}

/** Méthodes qui modifient l'état côté serveur : protégées par le jeton CSRF. */
export function isMutation(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}
