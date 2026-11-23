/**
 * Envoi web-push VAPID partagé par l'API Raijin et l'API du banc (docs/ARCHITECTURE.md §17.1), extrait de
 * `libs/api/notifications/src/lib/push` (phase 8 bis, T3) : chaque application fournit sa propre paire VAPID,
 * la lib ne lit aucune variable d'environnement.
 */
export const SERVER_PUSH_SCOPE = 'server-push' as const;
