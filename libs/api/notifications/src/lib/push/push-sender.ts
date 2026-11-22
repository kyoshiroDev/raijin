import type { PushNotificationPayload } from '@raijin/shared-contracts';

/** Abonnement d'un appareil (endpoint du service push + clés de chiffrement du navigateur). */
export interface PushTarget {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export interface PushSendOptions {
  /** Durée de conservation par le service push si l'appareil est hors ligne (secondes). */
  readonly ttlSeconds: number;
  /** `high` pour une alerte Danger (réveille l'appareil), `normal` sinon. */
  readonly urgency: 'normal' | 'high';
}

/**
 * Résultat d'un envoi : `gone` (404/410 du service push) = abonnement à supprimer ;
 * `failed` = erreur passagère ou refus, **code seulement** (jamais l'endpoint, qui identifie l'appareil).
 */
export type PushResult = { readonly status: 'sent' } | { readonly status: 'gone' } | { readonly status: 'failed'; readonly code: string };

/** Envoi de notifications push web (VAPID). Implémentations : `WebPushSender`, `FakePushSender` (tests). */
export abstract class PushSender {
  /** Clés VAPID présentes : sinon le push est indisponible (`PUSH_NOT_SUPPORTED`). */
  abstract readonly configured: boolean;
  /** Clé publique d'application (servie au front), `null` sans clés. */
  abstract readonly publicKey: string | null;
  abstract send(target: PushTarget, payload: PushNotificationPayload, options: PushSendOptions): Promise<PushResult>;
}
