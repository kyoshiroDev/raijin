/**
 * Code d'erreur journalisable, sans jamais le message brut : les messages des pilotes (pg,
 * ioredis, undici) peuvent contenir une URL de connexion, un hôte, une requête ou une valeur.
 * Renvoie le `code` de l'erreur s'il a une forme sûre (ex. `P2002`, `ECONNREFUSED`, `57P01`),
 * sinon son nom de classe (ex. `PrismaClientInitializationError`), sinon `UNKNOWN`.
 */
export function errorCode(error: unknown): string {
  if (error === null || typeof error !== 'object') return 'UNKNOWN';
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(code)) return code;
  if (typeof code === 'number' && Number.isInteger(code)) return String(code);
  const name = (error as { name?: unknown }).name;
  if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(name)) return name;
  return 'UNKNOWN';
}
