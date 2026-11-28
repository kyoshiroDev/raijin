import { safeErrorMessage } from '@raijin/server-security';

/**
 * Journal des fonctions portées : chaque texte (chaîne ou `Error`) passe par `safeErrorMessage` (identifiants
 * d'URL, `api-key=`, `Bearer`, affectations `*_KEY=`, longues clés masqués ; retours à la ligne retirés ; borné).
 * Les nombres et booléens passent tels quels ; tout autre objet est remplacé par son type (jamais sérialisé ici :
 * les résumés JSON sont construits par l'appelant, puis nettoyés comme une chaîne). Aucun calcul ne dépend du journal.
 */
const MAX_WARN = 500;
const MAX_INFO = 4000;

function clean(value: unknown, max: number): unknown {
  if (typeof value === 'string') return value === '' ? value : safeErrorMessage(value, max);
  if (value instanceof Error) return safeErrorMessage(value, max);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value;
  return `[${typeof value}]`;
}

export const engineLog = {
  info: (...args: unknown[]): void => console.log(...args.map((a) => clean(a, MAX_INFO))),
  warn: (...args: unknown[]): void => console.warn(...args.map((a) => clean(a, MAX_WARN))),
  error: (...args: unknown[]): void => console.error(...args.map((a) => clean(a, MAX_WARN))),
};
