import * as z from '../zod';

/** Codes d'erreur des suivis, alertes et push (phase 4). */
export const WATCH_ERROR_CODES = [
  /** Limite de suivis actifs du plan atteinte (création ou reprise) : 403. */
  'WATCH_LIMIT_REACHED',
  /** Suivi inexistant ou d'un autre utilisateur : 404. */
  'WATCH_NOT_FOUND',
  /** Alerte inexistante ou d'un autre utilisateur : 404. */
  'ALERT_NOT_FOUND',
  /** Push indisponible : clés VAPID absentes côté serveur (503) ; aussi utilisé par le front si le navigateur ne le gère pas. */
  'PUSH_NOT_SUPPORTED',
  /** Push réservé au plan Pro (et à l'essai) : 403. */
  'PUSH_PLAN_REQUIRED',
  /** Abonnement push refusé (endpoint hors des services connus, clés invalides) : 400. */
  'PUSH_SUBSCRIPTION_INVALID',
] as const;

export const watchErrorCodeSchema = z.enum(WATCH_ERROR_CODES);
export type WatchErrorCode = z.infer<typeof watchErrorCodeSchema>;

/** Messages français (ton neutre, sans urgence artificielle). */
export const WATCH_ERROR_MESSAGES: Readonly<Record<WatchErrorCode, string>> = {
  WATCH_LIMIT_REACHED:
    'Tu suis déjà le nombre maximal de tokens pour ton plan. Retire ou mets en pause un suivi pour en ajouter un autre.',
  WATCH_NOT_FOUND: 'Ce suivi n’existe plus.',
  ALERT_NOT_FOUND: 'Cette alerte n’existe plus.',
  PUSH_NOT_SUPPORTED:
    'Les notifications push ne sont pas disponibles ici. Sur iPhone, ajoute d’abord Raijin à l’écran d’accueil.',
  PUSH_PLAN_REQUIRED: 'Les notifications push font partie du plan Pro. Tu reçois tes alertes par e-mail.',
  PUSH_SUBSCRIPTION_INVALID: 'Ce navigateur a fourni un abonnement push non pris en charge.',
};
