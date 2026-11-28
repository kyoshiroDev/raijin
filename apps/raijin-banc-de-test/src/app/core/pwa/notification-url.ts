/**
 * In-app paths a push notification may open. Anything else (absolute URL, protocol-relative
 * `//host`, `javascript:`, unknown route, malformed mint…) falls back to '/'.
 * The payload comes from our own backend over an encrypted channel, but it is still treated
 * as untrusted input: a notification must never be able to send the user off-site.
 */
export const NOTIFICATION_PATH_RE = /^\/(token\/[1-9A-HJ-NP-Za-km-z]{32,44}|settings|alerts)?$/;

export function safeNotificationPath(url: unknown): string {
  return typeof url === 'string' && NOTIFICATION_PATH_RE.test(url) ? url : '/';
}

/** Reads `notification.data.url` from a SwPush click event payload (shape not trusted). */
export function notificationUrl(notification: unknown): unknown {
  if (typeof notification !== 'object' || notification === null) return undefined;
  const data: unknown = (notification as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return undefined;
  return (data as { url?: unknown }).url;
}
