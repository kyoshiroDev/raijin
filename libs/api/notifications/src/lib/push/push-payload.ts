import { pushNotificationPayloadSchema, type PushNotificationPayload } from '@raijin/shared-contracts';
import { describeAlert, severityLabel, tokenLabel, type AlertMessage } from '../templates/alert-text';

export const PUSH_ICON = '/icons/icon-192.png';
export const PUSH_BADGE = '/icons/badge-72.png';
/** Conservation par le service push si l'appareil est hors ligne : 24 h. */
export const PUSH_TTL_SECONDS = 86_400;

function clip(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * Charge utile au format du service worker Angular (`ngsw-worker.js`) : texte brut, sans e-mail ni
 * donnée de compte ; clic → `/alertes?alerte=<id>`. Les notifications d'un même mint se remplacent
 * (`tag`). Validée par le contrat avant envoi.
 */
export function buildAlertPushPayload(alert: AlertMessage): PushNotificationPayload {
  const title = clip(`Raijin : alerte ${severityLabel(alert.severity)}`, 80);
  const body = clip(`${tokenLabel(alert.mint, alert.token)} (non vérifié). ${describeAlert(alert)}`, 240);
  return pushNotificationPayloadSchema.parse({
    notification: {
      title,
      body,
      icon: PUSH_ICON,
      badge: PUSH_BADGE,
      tag: `alert:${alert.mint}`,
      renotify: true,
      lang: 'fr',
      timestamp: alert.createdAt.getTime(),
      data: {
        alertId: alert.id,
        mint: alert.mint,
        onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url: `/alertes?alerte=${alert.id}` } },
      },
    },
  });
}
