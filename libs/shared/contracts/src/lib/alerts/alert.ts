import * as z from '../zod';
import { mintAddressSchema } from '../address';
import { tokenMetadataSchema } from '../analysis/token';
import { pageQueryShape, pageResponseSchema } from '../pagination';
import {
  ALERT_TYPES,
  alertSeveritySchema,
  alertTypeSchema,
  authorityReactivatedPayloadSchema,
  holderSoldPayloadSchema,
  lpRemovedPayloadSchema,
  verdictDegradedPayloadSchema,
} from './events';

/**
 * Alertes (écran « Alertes », PROMPT.md §4.2). Routes (`/api/v1`, session obligatoire) :
 * - `GET alerts?status=&types=&mint=&cursor=&limit=` → `AlertListResponse` (plus récentes d'abord,
 *   limitée à `PlanLimits.alertHistoryDays`) ;
 * - `GET alerts/unread-count` → `AlertUnreadCount` (badge de la barre de navigation) ;
 * - `POST alerts/read` (`AlertReadRequest`, CSRF) → `AlertUnreadCount`.
 * Les alertes d'un autre utilisateur sont invisibles (404 `ALERT_NOT_FOUND`, jamais 403).
 */

const alertBaseShape = {
  id: z.uuid(),
  mint: mintAddressSchema,
  /** Métadonnées du token au moment de l'alerte (nom/symbole non fiables) ; `null` si inconnues. */
  token: tokenMetadataSchema.nullable(),
  severity: alertSeveritySchema,
  createdAt: z.iso.datetime(),
  /** `null` = non lue. */
  readAt: z.iso.datetime().nullable(),
};

/** Une alerte : champs communs + `type` / `payload` (union discriminée sur `type`). */
export const alertSchema = z.discriminatedUnion('type', [
  z.object({ ...alertBaseShape, type: z.literal('verdict_degraded'), payload: verdictDegradedPayloadSchema }),
  z.object({ ...alertBaseShape, type: z.literal('lp_removed'), payload: lpRemovedPayloadSchema }),
  z.object({ ...alertBaseShape, type: z.literal('mint_reactivated'), payload: authorityReactivatedPayloadSchema }),
  z.object({ ...alertBaseShape, type: z.literal('freeze_reactivated'), payload: authorityReactivatedPayloadSchema }),
  z.object({ ...alertBaseShape, type: z.literal('holder_sold'), payload: holderSoldPayloadSchema }),
]);
export type Alert = z.infer<typeof alertSchema>;

/** Filtre lu / non lu. */
export const alertReadFilterSchema = z.enum(['all', 'unread', 'read']);
export type AlertReadFilter = z.infer<typeof alertReadFilterSchema>;

/** Libellés français des filtres lu / non lu. */
export const ALERT_READ_FILTER_LABELS: Readonly<Record<AlertReadFilter, string>> = {
  all: 'Toutes',
  unread: 'Non lues',
  read: 'Lues',
};

/**
 * Requête de `GET alerts`. `types` : liste séparée par des virgules (`types=lp_removed,holder_sold`)
 * ou paramètre répété ; absent = tous les types.
 */
export const alertListQuerySchema = z
  .object({
    status: alertReadFilterSchema.default('all'),
    types: z
      .preprocess(
        (value) => (typeof value === 'string' ? value.split(',').filter((part) => part.length > 0) : value),
        z.array(alertTypeSchema).min(1).max(ALERT_TYPES.length),
      )
      .optional(),
    mint: mintAddressSchema.optional(),
    ...pageQueryShape,
  })
  .strict();
export type AlertListQuery = z.infer<typeof alertListQuerySchema>;
export type AlertListQueryInput = z.input<typeof alertListQuerySchema>;

export const alertUnreadCountSchema = z.object({ unread: z.number().int().min(0) });
export type AlertUnreadCount = z.infer<typeof alertUnreadCountSchema>;

/** Réponse de `GET alerts` : page + nombre total de non lues (tous filtres confondus). */
export const alertListResponseSchema = pageResponseSchema(alertSchema).extend(alertUnreadCountSchema.shape);
export type AlertListResponse = z.infer<typeof alertListResponseSchema>;

/** Nombre maximal d'alertes marquées en une requête. */
export const ALERT_READ_BATCH_MAX = 100;

/**
 * Corps de `POST alerts/read` : marquer des alertes lues ou non lues, ou tout marquer comme lu.
 * Les identifiants inconnus ou d'un autre utilisateur sont ignorés silencieusement.
 */
export const alertReadRequestSchema = z.union([
  z.object({ ids: z.array(z.uuid()).min(1).max(ALERT_READ_BATCH_MAX), read: z.boolean() }).strict(),
  z.object({ all: z.literal(true), read: z.literal(true) }).strict(),
]);
export type AlertReadRequest = z.infer<typeof alertReadRequestSchema>;
