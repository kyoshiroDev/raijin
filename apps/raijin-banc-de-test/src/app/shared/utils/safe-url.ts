// Every external link in the app goes through safeExternalUrl().

export const LINK_HOSTS = {
  x: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'],
  telegram: ['t.me', 'www.t.me', 'telegram.me'],
  image: ['dd.dexscreener.com', 'cdn.dexscreener.com'],
} as const;

export type LinkKind = keyof typeof LINK_HOSTS | 'website';

/**
 * Returns a normalised https URL or null.
 * Rejects javascript:/data:/http:, credentials in URL, localhost and IP literals,
 * and hosts outside the allowlist for x / telegram / image links.
 */
export function safeExternalUrl(input: unknown, kind: LinkKind = 'website'): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 500) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || !host.includes('.')) return null;
  if (kind !== 'website' && !(LINK_HOSTS[kind] as readonly string[]).includes(host)) return null;
  return url.toString();
}
