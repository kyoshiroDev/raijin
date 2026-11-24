/**
 * Nettoyage des textes journalisés : implémentation unique dans `@raijin/server-security` (partagée avec
 * `@raijin/bench-engine`, qui ne peut pas dépendre de `bench-core`). Ré-export pour les imports existants.
 */
export { errorCodeOf, redactSecrets, safeErrorMessage } from '@raijin/server-security';
