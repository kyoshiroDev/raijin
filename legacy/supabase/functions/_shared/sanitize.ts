// Pure helpers to neutralise hostile token metadata before it is stored.

// Control chars (C0, DEL, C1), Arabic letter mark (U+061C), zero-width chars and LRM/RLM (U+200B–U+200F),
// bidi embeddings/overrides (U+202A–U+202E), word joiner + invisible operators + bidi isolates (U+2060–U+2069),
// BOM (U+FEFF), interlinear annotation controls (U+FFF9–U+FFFB).
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\uFFF9-\uFFFB]/g;

/** Normalises, strips invisible/bidi characters and angle brackets, trims and caps length. */
export function sanitizeText(input: unknown, maxLength: number): string {
  if (typeof input !== 'string') return '';
  return input
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // Cut by code point, never inside a surrogate pair: a lone half-emoji can make Postgres reject the whole
    // JSON payload (one hostile token name would then break every bulk upsert).
    .replace(/^[\s\S]*$/, (s) => Array.from(s).slice(0, Math.max(0, maxLength)).join(''));
}

export const X_HOSTS = ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'] as const;
export const TELEGRAM_HOSTS = ['t.me', 'www.t.me', 'telegram.me'] as const;
export const IMAGE_HOSTS = ['dd.dexscreener.com', 'cdn.dexscreener.com'] as const;

/**
 * Returns a normalised https URL, or null.
 * Rejects non-https schemes (javascript:, data:, http:), credentials in URL,
 * localhost / IP literals, overly long URLs, and hosts outside `allowedHosts` when given.
 */
export function safeHttpsUrl(input: unknown, allowedHosts?: readonly string[]): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 500) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return null;
  if (!host.includes('.')) return null;
  if (allowedHosts && !allowedHosts.includes(host)) return null;
  return url.toString();
}

/** Constant-time string comparison (for shared secrets). */
export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
