import { isAllowedHttpsUrl } from '@raijin/shared-util';
import * as z from '../zod';
import { mintAddressSchema } from '../address';
import { relativePathSchema } from '../auth/common';

/**
 * Push web VAPID (PROMPT.md §4.2, docs/ARCHITECTURE.md §11.7). Routes (`/api/v1`) :
 * - `GET push/vapid-public-key` (public) → `VapidPublicKeyResponse` (503 `PUSH_NOT_SUPPORTED` sans clés) ;
 * - `POST push/subscriptions` (session, CSRF, `PushSubscriptionRequest`) → 201 `PushSubscriptionResponse`
 *   (403 `PUSH_PLAN_REQUIRED` en Gratuit, 400 `PUSH_SUBSCRIPTION_INVALID`) ; ré-abonner le même endpoint
 *   met à jour les clés (idempotent) ;
 * - `POST push/unsubscribe` (session, CSRF, `PushUnsubscribeRequest`) → 204.
 * La clé privée VAPID ne quitte jamais l'API.
 */

/**
 * Services push des navigateurs (sous-domaines compris) : l'API envoie une requête à l'endpoint
 * fourni par le navigateur, il est donc filtré par cette liste (pas de SSRF vers un hôte arbitraire).
 */
export const PUSH_SERVICE_HOSTS = [
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
] as const;

/** Clé publique d'application VAPID : point P-256 non compressé (65 octets) en base64url. */
export const vapidPublicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{86,88}$/);

export const vapidPublicKeyResponseSchema = z.object({ publicKey: vapidPublicKeySchema });
export type VapidPublicKeyResponse = z.infer<typeof vapidPublicKeyResponseSchema>;

/** Endpoint d'abonnement : `https://` vers un service push connu, 2048 caractères max. */
export const pushEndpointSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => isAllowedHttpsUrl(value, PUSH_SERVICE_HOSTS), { message: 'Service push non pris en charge.' });

/**
 * Corps de `POST push/subscriptions` : `PushSubscription.toJSON()` du navigateur.
 * `p256dh` (65 octets) et `auth` (16 octets) en base64url, avec ou sans remplissage.
 */
export const pushSubscriptionRequestSchema = z
  .object({
    endpoint: pushEndpointSchema,
    expirationTime: z.number().int().nonnegative().nullable().optional(),
    keys: z
      .object({
        p256dh: z.string().regex(/^[A-Za-z0-9_-]{86,88}={0,2}$/),
        auth: z.string().regex(/^[A-Za-z0-9_-]{21,24}={0,2}$/),
      })
      .strict(),
  })
  .strict();
export type PushSubscriptionRequest = z.infer<typeof pushSubscriptionRequestSchema>;

export const pushSubscriptionResponseSchema = z.object({ id: z.uuid(), createdAt: z.iso.datetime() });
export type PushSubscriptionResponse = z.infer<typeof pushSubscriptionResponseSchema>;

export const pushUnsubscribeRequestSchema = z.object({ endpoint: pushEndpointSchema }).strict();
export type PushUnsubscribeRequest = z.infer<typeof pushUnsubscribeRequestSchema>;

/**
 * Charge utile chiffrée envoyée au navigateur, au format attendu par le service worker Angular
 * (`ngsw-worker.js` affiche `notification` et gère le clic via `data.onActionClick`) : aucun
 * service worker maison. Texte brut uniquement (nom/symbole déjà nettoyés), 3 ko max chiffrés.
 */
export const pushNotificationPayloadSchema = z.object({
  notification: z.object({
    title: z.string().min(1).max(80),
    body: z.string().min(1).max(240),
    /** Chemins relatifs de l'app (icônes PNG du manifeste). */
    icon: relativePathSchema,
    badge: relativePathSchema,
    /** Regroupe les notifications d'un même mint (`alert:<mint>`). */
    tag: z.string().regex(/^alert:[1-9A-HJ-NP-Za-km-z]{32,44}$/),
    renotify: z.boolean(),
    lang: z.literal('fr'),
    timestamp: z.number().int().nonnegative(),
    data: z.object({
      alertId: z.uuid(),
      mint: mintAddressSchema,
      onActionClick: z.object({
        default: z.object({
          operation: z.literal('navigateLastFocusedOrOpen'),
          /** Page ouverte au clic (`/alertes?alerte=<id>`). */
          url: relativePathSchema,
        }),
      }),
    }),
  }),
});
export type PushNotificationPayload = z.infer<typeof pushNotificationPayloadSchema>;

/**
 * Variante admin de la charge utile (phase 6 bis, docs/ARCHITECTURE.md §14.7) : même enveloppe pour le service worker
 * Angular, mais sans mint ni identifiant d'alerte de token. `tag` fixe par nature d'avis (les avis d'une même nature se
 * remplacent) et clic limité à l'espace admin (`/admin` ou `/admin/...`). Envoyée uniquement aux comptes ADMIN.
 */
export const ADMIN_PUSH_TAGS = ['admin-alert', 'admin-notice'] as const;
export const adminPushTagSchema = z.enum(ADMIN_PUSH_TAGS);
export type AdminPushTag = z.infer<typeof adminPushTagSchema>;

/** Chemin relatif de l'espace admin (aucune autre page ouverte au clic d'un avis admin). */
export const adminPushUrlSchema = relativePathSchema.refine((value) => value === '/admin' || value.startsWith('/admin/'), {
  message: 'Chemin admin attendu.',
});

export const adminPushNotificationPayloadSchema = z.object({
  notification: z.object({
    title: z.string().min(1).max(80),
    body: z.string().min(1).max(240),
    icon: relativePathSchema,
    badge: relativePathSchema,
    tag: adminPushTagSchema,
    renotify: z.boolean(),
    lang: z.literal('fr'),
    timestamp: z.number().int().nonnegative(),
    data: z
      .object({
        onActionClick: z.object({
          default: z.object({ operation: z.literal('navigateLastFocusedOrOpen'), url: adminPushUrlSchema }),
        }),
      })
      .strict(),
  }),
});
export type AdminPushNotificationPayload = z.infer<typeof adminPushNotificationPayloadSchema>;

/**
 * Toute charge utile envoyée par l'API (alerte de token ou avis admin) : type attendu par l'expéditeur push
 * (`PushSender.send`), ce qui supprime les conversions `as unknown as PushNotificationPayload`.
 */
export const outgoingPushPayloadSchema = z.union([pushNotificationPayloadSchema, adminPushNotificationPayloadSchema]);
export type OutgoingPushPayload = z.infer<typeof outgoingPushPayloadSchema>;
