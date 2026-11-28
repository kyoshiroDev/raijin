// Port Node (bench-engine) : liste blanche des endpoints push extraite de _shared/webpush.ts (le reste du fichier, le
// chiffrement VAPID, est remplacé par @raijin/server-push). Code identique.
export const PUSH_ENDPOINT_PATTERN =
  /^https:\/\/(web\.push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)\//;
const EXACT_PUSH_HOSTS = new Set(['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com']);
const WINDOWS_HOST = /^[a-z0-9-]+\.notify\.windows\.com$/;

/** True only for https URLs on a known push service host (no credentials, no port, no whitespace). */
export function isAllowedPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 1000 || /\s/.test(endpoint)) return false;
  if (!PUSH_ENDPOINT_PATTERN.test(endpoint)) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname;
  return EXACT_PUSH_HOSTS.has(host) || WINDOWS_HOST.test(host);
}

