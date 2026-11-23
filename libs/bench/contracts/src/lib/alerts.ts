import { mintAddressSchema } from '@raijin/shared-contracts';
import * as z from './zod';
import { isoDateTimeSchema, listResponseSchema, rowIdSchema } from './common';

/**
 * Journal des alertes (`public.alert_log`, lecture seule) et réglages (`public.alert_settings`,
 * une ligne pour le compte unique). Heures en Europe/Paris ; l'API revérifie chaque borne.
 */
export const alertKindSchema = z.enum(['single', 'grouped']);
export const alertFirstHitSchema = z.enum(['target', 'stop']);

const price = z.number().positive().nullable();

export const alertLogRowSchema = z.object({
  id: rowIdSchema,
  mint: mintAddressSchema,
  sent_at: isoDateTimeSchema,
  kind: alertKindSchema,
  entry_price: price,
  target_price: price,
  stop_price: price,
  entry_roundtrip_pct: z.number().nullable(),
  stake_sol: price,
  max_price: price,
  min_price: price,
  last_price: price,
  last_price_at: isoDateTimeSchema.nullable(),
  first_hit: alertFirstHitSchema.nullable(),
  first_hit_at: isoDateTimeSchema.nullable(),
  followup_sent_at: isoDateTimeSchema.nullable(),
  tracking_until: isoDateTimeSchema.nullable(),
});
export type AlertLogRow = z.infer<typeof alertLogRowSchema>;

export const ALERT_LOG_LIMIT_MAX = 300;
/** `GET /api/alerts?mint=&since=&limit=` : plus récentes d'abord. */
export const alertLogQuerySchema = z.object({
  mint: mintAddressSchema.optional(),
  since: isoDateTimeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(ALERT_LOG_LIMIT_MAX).default(ALERT_LOG_LIMIT_MAX),
});
export type AlertLogQuery = z.infer<typeof alertLogQuerySchema>;
export const alertLogResponseSchema = listResponseSchema(alertLogRowSchema, ALERT_LOG_LIMIT_MAX);

/** Seul profil d'alerte restant (critères fixes côté serveur). */
export const ALERT_PRESET = 'young_calm';

const hour = z.number().int().min(0).max(23);

/** Préférences modifiables (`PUT /api/settings/alerts`, CSRF) ; `enabled` est porté par l'interrupteur des notifications. */
export const alertPreferencesSchema = z
  .object({
    hide_bonding_curve: z.boolean(),
    quiet_start: hour,
    quiet_end: hour,
    max_per_hour: z.number().int().min(1).max(20),
    max_per_day: z.number().int().min(1).max(100),
    stake_sol: z.number().min(0.01).max(100),
    /** SIMULATION : chaque alerte envoyée ouvre une position paper « tout à ×2 » (désactivé en mode ombre). */
    auto_paper: z.boolean(),
    paper_sl_pct: z.number().int().min(1).max(90),
  })
  .strict();
export type AlertPreferences = z.infer<typeof alertPreferencesSchema>;

/** `GET /api/settings/alerts` → `AlertSettings` (valeurs par défaut si aucune ligne). */
export const alertSettingsSchema = alertPreferencesSchema.extend({ enabled: z.boolean() });
export type AlertSettings = z.infer<typeof alertSettingsSchema>;

/** `PUT /api/settings/alerts/enabled` (CSRF) : active ou coupe les notifications. */
export const alertEnabledRequestSchema = z.object({ enabled: z.boolean() }).strict();
export type AlertEnabledRequest = z.infer<typeof alertEnabledRequestSchema>;

/** `GET /api/settings/preferences` : mise et stop par défaut lus par les écrans de paper trading. */
export const userPreferencesSchema = alertPreferencesSchema.pick({ stake_sol: true, paper_sl_pct: true });
export type UserPreferences = z.infer<typeof userPreferencesSchema>;

/**
 * Push du banc (paire VAPID distincte de Raijin) : `GET /api/push/vapid-public-key`,
 * `POST /api/push/subscriptions` (`PushSubscriptionRequest` de `@raijin/shared-contracts`),
 * `POST /api/push/unsubscribe` (`PushUnsubscribeRequest`), `POST /api/push/test` → `PushTestResponse`.
 */
export const pushTestResponseSchema = z.object({ sent: z.number().int().nonnegative(), failed: z.number().int().nonnegative() });
export type PushTestResponse = z.infer<typeof pushTestResponseSchema>;
