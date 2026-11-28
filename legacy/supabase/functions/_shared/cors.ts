// Pure CORS helpers for browser-called Edge Functions (send-test-push).

export const DEV_ORIGIN = 'http://localhost:4200';

/**
 * Allowed origins = the local dev origin + ALLOWED_ORIGINS (comma-separated).
 * Only exact `https://host[:port]` origins (or http://localhost) are kept; anything else is ignored.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  const out = new Set<string>([DEV_ORIGIN]);
  for (const part of (raw ?? '').split(',')) {
    const candidate = part.trim();
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      const isLocal = url.protocol === 'http:' && url.hostname === 'localhost';
      if ((url.protocol === 'https:' || isLocal) && !url.username && !url.password && url.origin === candidate.replace(/\/$/, '')) {
        out.add(url.origin);
      }
    } catch {
      // ignore malformed entries
    }
  }
  return [...out];
}

/** CORS headers for `origin` if it is allowed, otherwise null. */
export function corsHeaders(origin: string | null, allowed: readonly string[]): Record<string, string> | null {
  if (!origin || !allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}
