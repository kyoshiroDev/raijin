import * as z from '../zod';

/**
 * Préférences de notification (écran Compte, PROMPT.md §4.2 et §4.4). Routes (`/api/v1`, session) :
 * - `GET notifications/settings` → `NotificationSettings` ;
 * - `PATCH notifications/preferences` (`NotificationPreferencesUpdate`, CSRF) → `NotificationSettings`.
 * L'e-mail de fin d'essai et les e-mails de sécurité (vérification, reset) ne sont pas désactivables.
 */
export const notificationPreferencesSchema = z.object({
  /** Alertes de suivi par e-mail (tous les plans). */
  emailAlerts: z.boolean(),
  /** Alertes de suivi en notification push (Pro et essai ; ignoré en Gratuit). */
  pushAlerts: z.boolean(),
  /** Résumé hebdomadaire par e-mail (optionnel). */
  weeklyDigest: z.boolean(),
  /**
   * E-mails d'essai J+1 et J-2 (phase 6). L'e-mail J0 « Tu repasses en Gratuit » part toujours
   * (colonne `User.notifyTrialEmails`, défaut true).
   */
  trialEmails: z.boolean(),
});
export type NotificationPreferences = z.infer<
  typeof notificationPreferencesSchema
>;

/** Valeurs d'un nouveau compte (colonnes Prisma avec ces défauts). */
export const DEFAULT_NOTIFICATION_PREFERENCES: Readonly<NotificationPreferences> =
  {
    emailAlerts: true,
    pushAlerts: true,
    weeklyDigest: false,
    trialEmails: true,
  };

/** Corps de `PATCH notifications/preferences` : au moins un champ. */
export const notificationPreferencesUpdateSchema = notificationPreferencesSchema
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Aucune préférence à modifier.',
  });
export type NotificationPreferencesUpdate = z.infer<
  typeof notificationPreferencesUpdateSchema
>;

/** Préférences + ce que le compte et le serveur permettent réellement. */
export const notificationSettingsSchema = z.object({
  preferences: notificationPreferencesSchema,
  /** Le plan autorise le push (Pro, essai actif). */
  pushAllowed: z.boolean(),
  /** Le serveur a des clés VAPID (sinon le push est indisponible, `PUSH_NOT_SUPPORTED`). */
  pushConfigured: z.boolean(),
  /** Appareils abonnés au push pour ce compte. */
  pushDevices: z.number().int().min(0),
  /** Les alertes e-mail exigent une adresse vérifiée. */
  emailVerified: z.boolean(),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

/** Libellés français des préférences (écran Compte). */
export const NOTIFICATION_PREFERENCE_LABELS: Readonly<
  Record<keyof NotificationPreferences, string>
> = {
  emailAlerts: 'Alertes par e-mail',
  pushAlerts: 'Notifications push',
  weeklyDigest: 'Résumé hebdomadaire',
  trialEmails: 'E-mails pendant l’essai Pro',
};
