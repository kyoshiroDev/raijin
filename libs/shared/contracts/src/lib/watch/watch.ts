import * as z from '../zod';
import { mintAddressSchema } from '../address';
import { tokenMetadataSchema } from '../analysis/token';
import { planSchema } from '../auth/user';
import { verdictSchema } from '../verdict';

/**
 * Suivis de tokens (PROMPT.md §4.2, §4.4, docs/ARCHITECTURE.md §11).
 *
 * Routes (`/api/v1`, session obligatoire, e-mail vérifié, CSRF sur les mutations) :
 * - `GET watches` → `WatchListResponse` ;
 * - `POST watches` (`WatchCreateRequest`) → 201 `Watch` (200 si déjà suivi : idempotent) ;
 * - `PATCH watches/:id` (`WatchUpdateRequest`) → `Watch` (pause / reprise) ;
 * - `DELETE watches/:id` → 204.
 * Les limites viennent toujours de l'API (plan relu en base, valeurs en configuration).
 */

/** Statut d'un suivi : seuls les suivis actifs sont réanalysés et alertent. */
export const WATCH_STATUSES = ['active', 'paused'] as const;
export const watchStatusSchema = z.enum(WATCH_STATUSES);
export type WatchStatus = z.infer<typeof watchStatusSchema>;

/**
 * Motif de pause : `user` (mis en pause par l'utilisateur) ou `plan_limit` (au-delà de la limite
 * du plan, par exemple à la fin de l'essai Pro : suivi conservé, jamais supprimé).
 */
export const watchPauseReasonSchema = z.enum(['user', 'plan_limit']);
export type WatchPauseReason = z.infer<typeof watchPauseReasonSchema>;

/** Nombre maximal de suivis (actifs + en pause) renvoyés par `GET watches`. */
export const WATCH_LIST_MAX = 100;

/** Paramètre de route `:id` des suivis. */
export const watchIdParamSchema = z.object({ id: z.uuid() }).strict();
export type WatchIdParam = z.infer<typeof watchIdParamSchema>;

/**
 * Corps de `POST watches`. Le mint doit avoir une analyse récente (≤ 24 h, bouton « Suivre » de
 * l'écran d'analyse), sinon 404 `ANALYSIS_NOT_FOUND` : on ne suit pas une adresse jamais vérifiée.
 */
export const watchCreateRequestSchema = z.object({ mint: mintAddressSchema }).strict();
export type WatchCreateRequest = z.infer<typeof watchCreateRequestSchema>;

/** Corps de `PATCH watches/:id` : reprise refusée (`WATCH_LIMIT_REACHED`) au-delà de la limite. */
export const watchUpdateRequestSchema = z.object({ status: watchStatusSchema }).strict();
export type WatchUpdateRequest = z.infer<typeof watchUpdateRequestSchema>;

/** Un suivi, avec le dernier verdict connu (réanalyse programmée). */
export const watchSchema = z.object({
  id: z.uuid(),
  mint: mintAddressSchema,
  /** Métadonnées de la dernière analyse (nom/symbole non fiables) ; `null` si inconnues. */
  token: tokenMetadataSchema.nullable(),
  status: watchStatusSchema,
  /** `null` si le suivi est actif. */
  pausedReason: watchPauseReasonSchema.nullable(),
  lastVerdict: verdictSchema.nullable(),
  /** Dernière réanalyse complète (verdict) ; `null` avant la première. */
  lastCheckedAt: z.iso.datetime().nullable(),
  /** Alertes non lues pour ce mint. */
  unreadAlerts: z.number().int().min(0),
  createdAt: z.iso.datetime(),
});
export type Watch = z.infer<typeof watchSchema>;

/**
 * Droits de l'utilisateur liés au plan, calculés par l'API depuis la base (plan, essai actif) et la
 * configuration (`FREE_WATCH_LIMIT`, `PRO_WATCH_LIMIT`, `*_ALERT_HISTORY_DAYS`). Jamais par le front.
 */
export const planLimitsSchema = z.object({
  plan: planSchema,
  /** Essai Pro en cours (limites Pro appliquées). */
  trialActive: z.boolean(),
  /** Suivis actifs autorisés (Gratuit 3, Pro 50 par défaut). */
  maxActiveWatches: z.number().int().min(0),
  /** Notifications push autorisées (Pro et essai). Le Gratuit reçoit les alertes par e-mail seulement. */
  pushAlerts: z.boolean(),
  /** Profondeur de l'historique des alertes affiché, en jours. */
  alertHistoryDays: z.number().int().min(1).max(366),
});
export type PlanLimits = z.infer<typeof planLimitsSchema>;

/** Réponse de `GET watches`. */
export const watchListResponseSchema = z.object({
  items: z.array(watchSchema).max(WATCH_LIST_MAX),
  limits: planLimitsSchema,
  activeCount: z.number().int().min(0),
  pausedCount: z.number().int().min(0),
});
export type WatchListResponse = z.infer<typeof watchListResponseSchema>;
