/**
 * Nettoyage d'un texte destiné aux journaux ou à `job_runs.error` : identifiants d'URL de connexion,
 * paramètres de requête sensibles (`api-key`, `token`…), jetons `Bearer`, longues chaînes ressemblant
 * à une clé. Le texte est ensuite borné (`maxLength`).
 */
const CREDENTIALS_IN_URL = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]*@/gi;
const SECRET_QUERY = /([?&](?:api[-_]?key|apikey|key|token|secret|password|access_token|auth)=)[^&\s'"]*/gi;
const BEARER = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|PASSWORD|TOKEN)[A-Z0-9_]*)\s*[=:]\s*\S+/g;
/** Chaînes hexadécimales ou base64 de 40 caractères et plus (clés, jetons) ; les adresses Solana (≤ 44, base58) restent. */
const LONG_TOKEN = /\b(?:[0-9a-f]{40,}|[A-Za-z0-9_-]{45,})\b/gi;

export function redactSecrets(text: string): string {
  return text
    .replace(CREDENTIALS_IN_URL, '$1***@')
    .replace(SECRET_QUERY, '$1***')
    .replace(BEARER, '$1 ***')
    .replace(SECRET_ASSIGNMENT, '$1=***')
    .replace(LONG_TOKEN, '***');
}

/** Message d'erreur sûr : nom + message nettoyés, borné ; jamais de stack ni d'objet sérialisé. */
export function safeErrorMessage(error: unknown, maxLength: number): string {
  let raw: string;
  if (error instanceof Error) raw = error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message;
  else if (typeof error === 'string') raw = error;
  else raw = 'Erreur inconnue';
  const clean = redactSecrets(raw.replace(/[\r\n\t]+/g, ' ')).trim() || 'Erreur inconnue';
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}

/** Code d'erreur court sûr à journaliser (`ECONNREFUSED`, `P2002`…), ou `UNKNOWN`. */
export function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(code)) return code;
  }
  return error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'UNKNOWN';
}
